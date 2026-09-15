import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StandaloneContext } from '../core/discovery';
import { RunStore } from '../core/runStore';
import { ProjectDoctor } from './projectDoctor';
import { toDoctorView } from './view';
import type { McpToolOutput, UnrealMcpGateway } from './unrealMcpClient';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe('ROI-focused Project Doctor', () => {
  it('runs a changed-scope scan and emits executed asset and graph issues', async () => {
    const ctx = await projectContext();
    const gateway = new FakeGateway(scanWithIssues());
    const doctor = createDoctor(ctx, gateway);

    const completed = await doctor.run({ paths: ['Content/BP/BP_Test.uasset'] });

    expect(completed.status).toBe('failed');
    expect(completed.coverage.assets.status).toBe('completed');
    expect(completed.issues.some((issue) => issue.ruleId === 'asset.missing_reference')).toBe(true);
    expect(completed.issues.some((issue) => issue.ruleId === 'blueprint.unhandled_failure')).toBe(true);
    expect(completed.issues.every((issue) => !('confidence' in issue))).toBe(true);
    const runDir = path.join(ctx.projectRoot, 'Saved', 'EngineLink', 'Doctor', 'Runs', completed.id);
    await expect(fs.promises.access(path.join(runDir, 'scan.json'))).resolves.toBeUndefined();
    await expect(fs.promises.access(path.join(runDir, 'report.md'))).resolves.toBeUndefined();
    await expect(fs.promises.access(path.join(runDir, 'events.jsonl'))).rejects.toThrow();
    await expect(fs.promises.access(path.join(runDir, 'references.json'))).rejects.toThrow();
    expect(gateway.assetEdgeArgs).toEqual({ paths: ['/Game/BP/BP_Test'] });
    expect(gateway.assetEdgeArgs).not.toHaveProperty('referenceQueries');
    const summary = JSON.parse(await fs.promises.readFile(path.join(runDir, 'summary.json'), 'utf8'));
    expect(summary).not.toHaveProperty('progress');
    expect(summary.issues[0]).not.toHaveProperty('id');
  });

  it('returns passed_with_findings when complete checks only find P2 issues', async () => {
    const ctx = await projectContext();
    const scan = emptyScan();
    scan.blueprints = [{
      path: '/Game/BP/BP_Test', compileStatus: 'UpToDate',
      issues: [{ ruleId: 'blueprint.orphan_node', severity: 'P2', evidence: 'orphan' }],
    }];
    const doctor = createDoctor(ctx, new FakeGateway(scan));
    const completed = await doctor.run({ paths: ['/Game/BP/BP_Test'] });
    expect(completed.status).toBe('passed_with_findings');
    expect(completed.issues).toHaveLength(1);
    expect(completed.issues[0].severity).toBe('P2');
  });

  it('blocks deep inspection when PIE is already running without stopping it or emitting a pie issue', async () => {
    const ctx = await projectContext();
    const gateway = new FakeGateway(emptyScan(), { pieRunning: true, currentMap: '/Game/Map/Test', dirtyPackages: [], openAssets: [] });
    const doctor = createDoctor(ctx, gateway);

    const completed = await doctor.run({ paths: ['/Game/BP/BP_Test'] });

    expect(completed.status).toBe('incomplete');
    expect(completed.coverage.assets.status).toBe('unavailable');
    expect(completed.issues.some((issue) => issue.ruleId === 'editor.pie_active')).toBe(false);
    expect(gateway.calls.some((call) => call.includes('GetReferencersAndDependencies'))).toBe(false);
  });

  it('treats a missing Editor as incomplete coverage without an editor.offline issue', async () => {
    const ctx = await projectContext();
    const doctor = new ProjectDoctor(
      async () => ctx,
      async () => ({ running: false, process: null }),
      () => { throw new Error('gateway must not be created'); },
    );

    const completed = await doctor.run({ paths: ['/Game/BP/BP_Test'] });
    const view = toDoctorView(completed);
    expect(completed.status).toBe('incomplete');
    expect(view.status).toBe('incomplete');
    expect(completed.coverage.editor.status).toBe('unavailable');
    expect(completed.issues.some((issue) => issue.ruleId === 'editor.offline')).toBe(false);
    expect(view).not.toHaveProperty('id');
  });

  it('uses EngineLink RunStore build evidence and ignores VibeUE last-build.json', async () => {
    const ctx = await projectContext();
    await fs.promises.mkdir(path.join(ctx.projectRoot, 'Saved', 'VibeUE'), { recursive: true });
    await fs.promises.writeFile(path.join(ctx.projectRoot, 'Saved', 'VibeUE', 'last-build.json'),
      JSON.stringify({ status: 'failed', projectFile: ctx.project.uprojectPath, completedAtIso: new Date().toISOString() }), 'utf8');
    const doctor = createDoctor(ctx, new FakeGateway(emptyScan()));
    const completed = await doctor.run();
    expect(completed.coverage.build.status).toBe('completed');
  });

  it('reports a missing Unreal MCP capability as coverage, not an mcp.capability issue', async () => {
    const ctx = await projectContext();
    const gateway = new FakeGateway(emptyScan());
    gateway.tools = [];
    const doctor = createDoctor(ctx, gateway);
    const completed = await doctor.run({ paths: ['/Game/BP/BP_Test'] });
    expect(completed.status).toBe('incomplete');
    expect(completed.coverage.editor.status).toBe('unavailable');
    expect(completed.issues.some((issue) => issue.ruleId === 'mcp.capability')).toBe(false);
  });

  it('blocks before MCP when multiple Editors have the same project open without emitting an instance issue', async () => {
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
    const completed = await doctor.run({ paths: ['/Game/BP/BP_Test'] });
    expect(completed.status).toBe('incomplete');
    expect(completed.issues.some((issue) => issue.ruleId === 'editor.multiple_instances')).toBe(false);
    expect(completed.build.authoritative).toBeNull();
    expect(gateway.calls).toEqual([]);
  });

  it('times out as incomplete when Unreal MCP does not respond', async () => {
    const ctx = await projectContext();
    const hanging: UnrealMcpGateway = {
      listTools: () => new Promise(() => undefined),
      call: () => new Promise(() => undefined),
      close: async () => undefined,
    };
    const doctor = createDoctor(ctx, hanging);
    const completed = await doctor.run({ paths: ['/Game/BP/BP_Test'], timeoutMs: 200 });
    expect(completed.status).toBe('incomplete');
    expect(completed.error).toMatch(/timed out/);
    expect(toDoctorView(completed)).not.toHaveProperty('id');
  });
});

class FakeGateway implements UnrealMcpGateway {
  readonly calls: string[] = [];
  assetEdgeArgs: Record<string, unknown> | undefined;
  tools = ['call_tool', 'list_toolsets', 'describe_toolset'];

  constructor(
    private readonly scan: Record<string, unknown>,
    private readonly state: Record<string, unknown> = { pieRunning: false, currentMap: '/Game/Map/Test', dirtyPackages: [], openAssets: [] },
  ) {}

  async listTools(): Promise<string[]> { return this.tools; }

  async call(name: string, args: Record<string, unknown> = {}): Promise<McpToolOutput> {
    const tool = String(args.tool_name ?? args.toolName ?? '');
    this.calls.push(`${name}:${tool}`);
    if (name === 'list_toolsets') {
      return structured({ toolsets: ['EditorToolset.EditorAppToolset', 'AssetTools', 'BlueprintTools'] });
    }
    if (name === 'describe_toolset') {
      const toolset = String(args.toolset_name ?? args.toolsetName ?? args.name ?? '');
      if (toolset.includes('EditorApp')) return structured({ tools: ['IsPIERunning', 'GetOpenAssets', 'GetDirtyPackages', 'GetCurrentMap'] });
      if (toolset.includes('Asset')) return structured({ tools: ['GetReferencersAndDependencies'] });
      if (toolset.includes('Blueprint')) return structured({ tools: ['GetGraphIssues'] });
      return structured({ tools: [] });
    }
    if (name === 'call_tool') {
      if (/IsPIERunning/i.test(tool)) return structured({ returnValue: Boolean(this.state.pieRunning) });
      if (/GetOpenAssets/i.test(tool)) return structured({ returnValue: this.state.openAssets ?? [] });
      if (/GetDirtyPackages/i.test(tool)) return structured({ returnValue: this.state.dirtyPackages ?? [] });
      if (/GetCurrentMap/i.test(tool)) return structured({ returnValue: this.state.currentMap ?? '' });
      if (/GetReferencersAndDependencies|GetGraphIssues/i.test(tool)) {
        if (/GetReferencersAndDependencies/i.test(tool)) {
          this.assetEdgeArgs = (args.arguments as Record<string, unknown> | undefined) ?? {};
        }
        return structured(this.scan);
      }
    }
    return { text: `unexpected ${name}`, content: [{ type: 'text', text: `unexpected ${name}` }], isError: true };
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
  await fs.promises.writeFile(path.join(root, 'Saved', 'Logs', 'Game.log'), '', 'utf8');
  await fs.promises.writeFile(path.join(root, 'Game.uproject'), '{}', 'utf8');
  const engineRoot = path.join(root, 'FakeEngine');
  const ubtPath = path.join(engineRoot, 'Engine', 'Build', 'BatchFiles', 'Build.bat');
  const editorPath = path.join(engineRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe');
  await fs.promises.mkdir(path.dirname(ubtPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(editorPath), { recursive: true });
  await fs.promises.writeFile(ubtPath, '', 'utf8');
  await fs.promises.writeFile(editorPath, '', 'utf8');
  const ctx: StandaloneContext = {
    projectRoot: root,
    project: {
      name: 'Game', uprojectPath: path.join(root, 'Game.uproject'), projectRoot: root,
      engineAssociation: '5.8', modules: [], targets: [],
    },
    engine: {
      version: '5.8', root: engineRoot, source: 'manual', ubtPath, editorPath, isSourceBuild: false,
    },
  };
  await new RunStore(root).save({
    schema: 'enginelink.run.v1',
    id: 'seed-build',
    kind: 'build',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    success: true,
    durationMs: 1,
    project: ctx.project.uprojectPath,
    engine: engineRoot,
    command: { executable: 'UBT', args: [] },
  });
  return ctx;
}

function structured(value: Record<string, unknown>): McpToolOutput {
  return { text: JSON.stringify(value), structured: value, content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
}

function emptyScan(): Record<string, unknown> {
  return { editor: {}, inventory: [], references: [], blueprints: [] };
}

function scanWithIssues(): Record<string, unknown> {
  return {
    editor: {}, inventory: [{ path: '/Game/BP/BP_Test', class: 'Blueprint' }],
    references: [{ from: '/Game/BP/BP_Test', to: '/Game/UI/WBP_Missing', direction: 'dependency', resolved: false }],
    blueprints: [{
      path: '/Game/BP/BP_Test', compileStatus: 'UpToDate',
      issues: [{ ruleId: 'blueprint.unhandled_failure', severity: 'P2', graph: 'EventGraph', node: 'Cast To Player', evidence: 'Cast Failed is not connected.' }],
    }],
  };
}
