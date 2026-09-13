import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StandaloneContext } from '../core/discovery';
import { ProjectDoctor } from './projectDoctor';
import type { McpToolOutput, UnrealMcpGateway } from './unrealMcpClient';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe('ROI-focused Project Doctor', () => {
  it('runs a changed-scope scan and emits auditable confirmed and inferred issues', async () => {
    const ctx = await projectContext();
    const gateway = new FakeGateway(scanWithIssues());
    const doctor = createDoctor(ctx, gateway);

    const started = await doctor.start({ mode: 'changed', paths: ['Content/BP/BP_Test.uasset'] });
    const completed = await doctor.waitForTerminal(started.id, 5_000);

    expect(completed.status).toBe('failed');
    expect(completed.coverage.assets.status).toBe('completed');
    expect(completed.issues.some((issue) => issue.ruleId === 'asset.missing_reference' && issue.confidence === 'confirmed')).toBe(true);
    expect(completed.issues.some((issue) => issue.ruleId === 'blueprint.unhandled_failure' && issue.confidence === 'inferred')).toBe(true);
    expect(completed.artifacts.some((file) => file.endsWith('references.json'))).toBe(true);
    await expect(fs.promises.access(path.join(ctx.projectRoot, 'Saved', 'EngineLink', 'Doctor', 'Runs', started.id, 'report.md'))).resolves.toBeUndefined();
  });

  it('returns passed_with_findings when complete checks only find P2 issues', async () => {
    const ctx = await projectContext();
    const scan = emptyScan();
    scan.blueprints = [{
      path: '/Game/BP/BP_Test', compileStatus: 'UpToDate',
      issues: [{ ruleId: 'blueprint.orphan_node', severity: 'P2', confidence: 'confirmed', evidence: 'orphan' }],
    }];
    const doctor = createDoctor(ctx, new FakeGateway(scan));
    const started = await doctor.start({ mode: 'changed', paths: ['/Game/BP/BP_Test'] });
    const completed = await doctor.waitForTerminal(started.id, 5_000);
    expect(completed.status).toBe('passed_with_findings');
    expect(completed.summary).toMatchObject({ total: 1, checksComplete: true, hasFindings: true, hasBlockingIssues: false });
  });

  it('blocks deep inspection when PIE is already running without stopping it', async () => {
    const ctx = await projectContext();
    const gateway = new FakeGateway(emptyScan(), { pieRunning: true, currentMap: '/Game/Map/Test', dirtyPackages: [], openAssets: [] });
    const doctor = createDoctor(ctx, gateway);

    const started = await doctor.start({ mode: 'changed', paths: ['/Game/BP/BP_Test'] });
    const completed = await doctor.waitForTerminal(started.id, 5_000);

    expect(completed.status).toBe('incomplete');
    expect(completed.coverage.assets.status).toBe('unavailable');
    expect(completed.issues.some((issue) => issue.ruleId === 'editor.pie_active')).toBe(true);
    expect(gateway.calls.filter((call) => call.includes('request =')).length).toBe(0);
  });

  it('does not classify baseline issues as resolved when current evidence is incomplete', async () => {
    const ctx = await projectContext();
    const first = createDoctor(ctx, new FakeGateway(scanWithIssues()));
    const baselineStart = await first.start({ mode: 'changed', paths: ['/Game/BP/BP_Test'] });
    const baseline = await first.waitForTerminal(baselineStart.id, 5_000);

    const unavailable = new ProjectDoctor(
      async () => ctx,
      async () => ({ running: false, process: null }),
      () => { throw new Error('gateway must not be created'); },
    );
    const verifyStart = await unavailable.start({ mode: 'changed', paths: ['/Game/BP/BP_Test'], baselineRunId: baseline.id });
    const verify = await unavailable.waitForTerminal(verifyStart.id, 5_000);

    expect(verify.comparison?.resolved).toEqual([]);
    const unverifiedScanIssues = baseline.issues
      .filter((issue) => !issue.ruleId.startsWith('host.'))
      .map((issue) => issue.id);
    expect(verify.comparison?.unverified).toEqual(expect.arrayContaining(unverifiedScanIssues));
  });

  it('reuses the baseline scope and rejects an explicitly different scope', async () => {
    const ctx = await projectContext();
    const first = createDoctor(ctx, new FakeGateway(emptyScan()));
    const baselineStart = await first.start({ mode: 'changed', paths: ['/Game/BP/BP_Test'], referenceQueries: ['/Game/Old'] });
    const baseline = await first.waitForTerminal(baselineStart.id, 5_000);

    const second = createDoctor(ctx, new FakeGateway(emptyScan()));
    const repeatStart = await second.start({ baselineRunId: baseline.id });
    const repeat = await second.waitForTerminal(repeatStart.id, 5_000);
    expect(repeat.requestedPaths).toEqual(baseline.requestedPaths);
    expect(repeat.referenceQueries).toEqual(baseline.referenceQueries);
    await expect(second.start({ baselineRunId: baseline.id, paths: ['/Game/Different'] }))
      .rejects.toThrow(/same paths/);
  });

  it('does not call Unreal MCP when the heartbeat is missing', async () => {
    const ctx = await projectContext();
    await fs.promises.rm(path.join(ctx.projectRoot, 'Saved', 'VibeUE', 'Signals', 'editor-42-health.json'));
    const gateway = new FakeGateway(emptyScan());
    const doctor = createDoctor(ctx, gateway);

    const started = await doctor.start({ mode: 'changed', paths: ['/Game/BP/BP_Test'] });
    const completed = await doctor.waitForTerminal(started.id, 5_000);
    expect(completed.status).toBe('incomplete');
    expect(completed.coverage.editor.status).toBe('unavailable');
    expect(gateway.calls).toEqual([]);
  });

  it('accepts BOM-prefixed VibeUE build evidence', async () => {
    const ctx = await projectContext();
    await fs.promises.writeFile(path.join(ctx.projectRoot, 'Saved', 'VibeUE', 'last-build.json'),
      '\uFEFF' + JSON.stringify({ status: 'succeeded', projectFile: ctx.project.uprojectPath, completedAtIso: new Date().toISOString() }), 'utf8');
    const doctor = createDoctor(ctx, new FakeGateway(emptyScan()));
    const started = await doctor.start({ mode: 'preflight' });
    const completed = await doctor.waitForTerminal(started.id, 5_000);
    expect(completed.coverage.build.status).toBe('completed');
  });

  it('reports a missing Unreal MCP capability as incomplete', async () => {
    const ctx = await projectContext();
    const gateway = new FakeGateway(emptyScan());
    gateway.tools = [];
    const doctor = createDoctor(ctx, gateway);
    const started = await doctor.start({ mode: 'changed', paths: ['/Game/BP/BP_Test'] });
    const completed = await doctor.waitForTerminal(started.id, 5_000);
    expect(completed.status).toBe('incomplete');
    expect(completed.issues.some((issue) => issue.ruleId === 'mcp.capability')).toBe(true);
  });

  it('rejects an Unreal MCP endpoint attached to a different Editor PID', async () => {
    const ctx = await projectContext();
    const gateway = new FakeGateway(emptyScan(), {
      pieRunning: false, currentMap: '/Game/Map/Test', dirtyPackages: [], openAssets: [], environment: { editorPid: 99 },
    });
    const doctor = createDoctor(ctx, gateway);
    const started = await doctor.start({ mode: 'preflight' });
    const completed = await doctor.waitForTerminal(started.id, 5_000);
    expect(completed.status).toBe('incomplete');
    expect(completed.issues.some((issue) => issue.ruleId === 'mcp.editor_mismatch')).toBe(true);
  });

  it('blocks before MCP when multiple Editors have the same project open', async () => {
    const ctx = await projectContext();
    const gateway = new FakeGateway(emptyScan());
    const doctor = new ProjectDoctor(
      async () => ctx,
      async () => ({
        running: true,
        process: { pid: 42, project: ctx.project.uprojectPath },
        processes: [{ pid: 42, project: ctx.project.uprojectPath }, { pid: 43, project: ctx.project.uprojectPath }],
      }),
      () => gateway,
    );
    const started = await doctor.start({ mode: 'scenario', scenarioNames: ['anything'] });
    const completed = await doctor.waitForTerminal(started.id, 5_000);
    expect(completed.status).toBe('incomplete');
    expect(completed.issues.some((issue) => issue.ruleId === 'editor.multiple_instances')).toBe(true);
    expect(completed.build.authoritative).toBeNull();
    expect(gateway.calls).toEqual([]);
  });

  it('cancels an active VibeUE scenario and waits for teardown', async () => {
    const ctx = await projectContext();
    const scenarios = path.join(ctx.projectRoot, '.enginelink', 'doctor', 'scenarios');
    await fs.promises.mkdir(scenarios, { recursive: true });
    await fs.promises.writeFile(path.join(scenarios, 'cancel-me.json'), JSON.stringify({
      schema: 'enginelink.doctor-scenario.v1', name: 'cancel-me', map: '/Game/Map/Test', clients: 1,
      steps: [{ action: 'start_pie' }], teardown: { stop_pie: true },
    }), 'utf8');
    const gateway = new RunningScenarioGateway();
    const doctor = createDoctor(ctx, gateway);
    const started = await doctor.start({ mode: 'scenario', scenarioNames: ['cancel-me'] });
    for (let attempt = 0; attempt < 50 && !gateway.scenarioStarted; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gateway.scenarioStarted).toBe(true);
    const completed = await doctor.cancel(started.id);
    expect(completed.status).toBe('cancelled');
    expect(gateway.scenarioCancelled).toBe(true);
    expect(gateway.settingsRestored).toBe(true);
  });
});

class FakeGateway implements UnrealMcpGateway {
  readonly calls: string[] = [];
  tools = ['execute_python_code'];

  constructor(
    private readonly scan: Record<string, unknown>,
    private readonly state: Record<string, unknown> = { pieRunning: false, currentMap: '/Game/Map/Test', dirtyPackages: [], openAssets: [] },
  ) {}

  async listTools(): Promise<string[]> { return this.tools; }

  async call(_name: string, args: Record<string, unknown> = {}): Promise<McpToolOutput> {
    const code = String(args.code ?? '');
    this.calls.push(code);
    const value = code.includes('request =') ? this.scan : this.state;
    return { text: `ENGINELINK_DOCTOR_RESULT=${JSON.stringify(value)}`, content: [], isError: false };
  }

  async close(): Promise<void> {}
}

class RunningScenarioGateway implements UnrealMcpGateway {
  scenarioStarted = false;
  scenarioCancelled = false;
  settingsRestored = false;

  async listTools(): Promise<string[]> { return ['execute_python_code']; }

  async call(_name: string, args: Record<string, unknown> = {}): Promise<McpToolOutput> {
    const code = String(args.code ?? '');
    let value: Record<string, unknown> = {};
    if (code.includes('run_scenario')) {
      this.scenarioStarted = true;
      value = { runId: 'vibe-run', scenarioId: 'vibe-scenario' };
    } else if (code.includes('cancel_scenario')) {
      this.scenarioCancelled = true;
      value = { status: 'cancelled', passed: false, teardownSucceeded: true };
    } else if (code.includes('get_scenario')) {
      value = this.scenarioCancelled
        ? { status: 'cancelled', passed: false, teardownSucceeded: true }
        : { status: 'running' };
    } else if (code.includes('snapshot=json.loads') && code.includes('set_background_throttling')) {
      this.settingsRestored = true;
      value = { succeeded: true };
    } else if (code.includes('settings_class =')) {
      value = { map: '/Game/Map/Test', clients: 2, backgroundThrottling: true };
    } else if (code.includes('StopPIE')) {
      value = { pieRunning: false };
    } else {
      value = { pieRunning: false, currentMap: '/Game/Map/Test', dirtyPackages: [], openAssets: [] };
    }
    return { text: `ENGINELINK_DOCTOR_RESULT=${JSON.stringify(value)}`, content: [], isError: false };
  }

  async close(): Promise<void> {}
}

function createDoctor(ctx: StandaloneContext, gateway: UnrealMcpGateway): ProjectDoctor {
  return new ProjectDoctor(
    async () => ctx,
    async () => ({ running: true, process: { pid: 42, project: ctx.project.uprojectPath } }),
    () => gateway,
    async (_context, run) => { run.coverage.host = { status: 'completed' }; },
  );
}

async function projectContext(): Promise<StandaloneContext> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-doctor-'));
  roots.push(root);
  await fs.promises.mkdir(path.join(root, 'Saved', 'Logs'), { recursive: true });
  await fs.promises.mkdir(path.join(root, 'Saved', 'VibeUE'), { recursive: true });
  await fs.promises.mkdir(path.join(root, 'Saved', 'VibeUE', 'Signals'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'Saved', 'Logs', 'Game.log'), '', 'utf8');
  const now = new Date().toISOString();
  await fs.promises.writeFile(path.join(root, 'Saved', 'VibeUE', 'last-build.json'), JSON.stringify({
    status: 'succeeded', projectFile: path.join(root, 'Game.uproject'), completedAtIso: now,
  }), 'utf8');
  await fs.promises.writeFile(path.join(root, 'Saved', 'VibeUE', 'Signals', 'editor-42-true.json'),
    JSON.stringify({ signal: 'toolsets-registered', pid: 42, createdUtc: now }), 'utf8');
  await fs.promises.writeFile(path.join(root, 'Saved', 'VibeUE', 'Signals', 'editor-42-health.json'),
    JSON.stringify({ signal: 'health', pid: 42, updatedUtc: now, gameThreadStallSeconds: 0 }), 'utf8');
  await fs.promises.writeFile(path.join(root, 'Game.uproject'), '{}', 'utf8');
  const engineRoot = path.join(root, 'FakeEngine');
  const ubtPath = path.join(engineRoot, 'Engine', 'Build', 'BatchFiles', 'Build.bat');
  const editorPath = path.join(engineRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe');
  await fs.promises.mkdir(path.dirname(ubtPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(editorPath), { recursive: true });
  await fs.promises.writeFile(ubtPath, '', 'utf8');
  await fs.promises.writeFile(editorPath, '', 'utf8');
  return {
    projectRoot: root,
    config: { schemaVersion: 1, uproject: 'Game.uproject' },
    project: {
      name: 'Game', uprojectPath: path.join(root, 'Game.uproject'), projectRoot: root,
      engineAssociation: '5.8', modules: [], targets: [],
    },
    engine: {
      version: '5.8', root: engineRoot, source: 'manual', ubtPath, editorPath, isSourceBuild: false,
    },
  };
}

function emptyScan(): Record<string, unknown> {
  return { environment: {}, editor: {}, inventory: [], references: [], blueprints: [], rules: [] };
}

function scanWithIssues(): Record<string, unknown> {
  return {
    environment: {}, editor: {}, inventory: [{ path: '/Game/BP/BP_Test', class: 'Blueprint' }],
    references: [{ from: '/Game/BP/BP_Test', to: '/Game/UI/WBP_Missing', direction: 'dependency', resolved: false }],
    blueprints: [{
      path: '/Game/BP/BP_Test', compileStatus: 'UpToDate',
      issues: [{ ruleId: 'blueprint.unhandled_failure', severity: 'P2', confidence: 'inferred', graph: 'EventGraph', node: 'Cast To Player', evidence: 'Cast Failed is not connected.' }],
    }],
    rules: [],
  };
}
