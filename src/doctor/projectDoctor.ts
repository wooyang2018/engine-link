import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { StandaloneContext } from '../core/discovery';
import { RunStore } from '../core/runStore';
import { spawnAsync } from '../platform/process';
import { ProjectDoctorLock } from './projectLock';
import { DoctorStore } from './store';
import type {
  DoctorConfidence,
  DoctorRule,
  DoctorRun,
  DoctorScenarioSpec,
  DoctorSeverity,
  DoctorStartOptions,
  UnrealScanResult,
} from './types';
import { applyHostChecks } from './hostChecks';
import { UnrealMcpClient, type UnrealMcpGateway } from './unrealMcpClient';
import { queryEditorState, scanUnrealProject } from './unrealScanner';
import { calculateDoctorStatus, summarizeDoctor } from './status';
import { parseJsonValue, SafeJsonError } from '../parsers/safeJson';
import { DoctorEvidenceError } from './evidence';
import { candidateFromRecord, selectBuildEvidence, type BuildEvidenceSelection } from './buildEvidence';
import { executeDoctorScenario } from './scenarioRunner';
import { getRuntimeIdentity } from '../runtimeIdentity';

export interface DoctorEditorProcess {
  running: boolean;
  process: { pid: number; project?: string; commandLine?: string; startedAt?: string } | null;
  processes?: Array<{ pid: number; project?: string; commandLine?: string; startedAt?: string }>;
}

type GatewayFactory = (url: string, connectTimeoutMs: number, requestTimeoutMs: number) => UnrealMcpGateway;

export class ProjectDoctor {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly context: () => Promise<StandaloneContext>,
    private readonly editorProcess: () => Promise<DoctorEditorProcess>,
    private readonly gatewayFactory: GatewayFactory = (url, connect, request) => new UnrealMcpClient(url, connect, request),
    private readonly hostChecks: typeof applyHostChecks = applyHostChecks,
  ) {}

  async start(options: DoctorStartOptions = {}): Promise<DoctorRun> {
    const ctx = await this.context();
    const store = new DoctorStore(ctx.projectRoot);
    const baseline = options.baselineRunId ? await store.get(options.baselineRunId) : undefined;
    if (baseline?.status === 'running') throw new Error('Cannot compare against a running Doctor baseline.');
    const mode = options.mode ?? baseline?.mode ?? 'changed';
    if (!['preflight', 'changed', 'scenario'].includes(mode)) throw new Error(`Unsupported doctor mode: ${mode}`);
    if (baseline && baseline.mode !== mode) throw new Error(`Baseline mode is ${baseline.mode}; requested mode is ${mode}.`);
    assertSameExplicitScope('paths', options.paths, baseline?.requestedPaths);
    assertSameExplicitScope('referenceQueries', options.referenceQueries, baseline?.referenceQueries);
    assertSameExplicitScope('scenarioNames', options.scenarioNames, baseline?.scenarioNames);
    const id = createDoctorRunId();
    const paths = options.paths !== undefined ? unique(options.paths)
      : baseline ? baseline.requestedPaths : mode === 'changed' ? await changedPaths(ctx.projectRoot) : [];
    const referenceQueries = options.referenceQueries !== undefined ? unique(options.referenceQueries) : baseline?.referenceQueries ?? [];
    const scenarioNames = options.scenarioNames !== undefined ? unique(options.scenarioNames) : baseline?.scenarioNames ?? [];
    const run: DoctorRun = {
      schema: 'enginelink.doctor-run.v1', id, mode, status: 'running', taskId: options.taskId, reason: options.reason,
      startedAt: new Date().toISOString(), project: ctx.project.uprojectPath, projectRoot: ctx.projectRoot,
      requestedPaths: paths, referenceQueries, scenarioNames, baselineRunId: options.baselineRunId,
      progress: { phase: 'queued', completed: 0, total: mode === 'scenario' ? 4 : mode === 'changed' ? 4 : 2 },
      coverage: {}, engineLink: await getRuntimeIdentity(), editor: {}, build: {}, issues: [], artifacts: [], scenarios: [],
    };
    await store.save(run);
    const controller = new AbortController();
    this.active.set(id, controller);
    void this.execute(ctx, run, controller.signal).finally(() => this.active.delete(id));
    return run;
  }

  async get(runId: string): Promise<DoctorRun> {
    const ctx = await this.context();
    return new DoctorStore(ctx.projectRoot).get(runId);
  }

  async cancel(runId: string): Promise<DoctorRun> {
    const controller = this.active.get(runId);
    if (!controller) {
      const existing = await this.get(runId);
      if (existing.status === 'running') throw new Error('Doctor run is owned by another EngineLink process and cannot be cancelled here.');
      return existing;
    }
    controller.abort();
    return this.waitForTerminal(runId, 20_000);
  }

  async waitForTerminal(runId: string, timeoutMs = 180_000): Promise<DoctorRun> {
    const started = Date.now();
    for (;;) {
      const run = await this.get(runId);
      if (run.status !== 'running') return run;
      if (Date.now() - started > timeoutMs) return run;
      await delay(100);
    }
  }

  private async execute(ctx: StandaloneContext, run: DoctorRun, signal: AbortSignal): Promise<void> {
    const store = new DoctorStore(ctx.projectRoot);
    const lock = new ProjectDoctorLock(ctx.projectRoot);
    let gateway: UnrealMcpGateway | undefined;
    const logSnapshot = await snapshotLog(ctx);
    try {
      await lock.acquire(run.id);
      await store.appendEvent(run.id, { phase: 'start', mode: run.mode, paths: run.requestedPaths });
      await this.phase(run, store, 'preflight', async () => {
        await this.hostChecks(ctx, run);
        const processInfo = await this.editorProcess();
        run.editor = { process: processInfo.process, processes: processInfo.processes ?? (processInfo.process ? [processInfo.process] : []), running: processInfo.running };
        if ((processInfo.processes?.length ?? 0) > 1) {
          run.build = await readBuildState(ctx, processInfo.process, {}, undefined, true);
          run.coverage.build = { status: 'unavailable', detail: 'Build authority is ambiguous while multiple Editors have this project open.' };
          run.coverage.editor = { status: 'unavailable', detail: `${processInfo.processes!.length} Unreal Editor processes have the same project open.` };
          addIssue(run, 'editor.multiple_instances', 'P1', ctx.project.uprojectPath,
            `Found Editor PIDs ${processInfo.processes!.map((item) => item.pid).join(', ')} for the same project.`,
            'MCP, readiness, build, and runtime evidence cannot be bound to one authoritative session.',
            'Close unintended Editor sessions and rerun Doctor.', 'Use exactly one Editor for this project during diagnosis.',
            'confirmed', 'Windows process inventory');
          return;
        }
        const signalState = await readVibeSignals(ctx.projectRoot, processInfo.process);
        Object.assign(run.editor, signalState);
        if (!processInfo.running) {
          run.build = await readBuildState(ctx, undefined, signalState);
          applyBuildSelection(run, run.build as unknown as BuildEvidenceSelection, ctx);
          run.coverage.editor = { status: 'unavailable', detail: 'Unreal Editor is not running.' };
          addIssue(run, 'editor.offline', 'P1', ctx.project.uprojectPath,
            'Unreal Editor is not running; editor-side checks cannot execute.',
            'Asset, Blueprint, PIE, and runtime conclusions remain unverified.',
            'Launch the project Editor and repeat this Doctor run.',
            'Launch the project Editor before relying on editor-side conclusions.', 'unconfirmed', 'EngineLink');
          return;
        }
        if (signalState.readinessValid !== true || signalState.heartbeatStale === true || signalState.gameThreadWedged === true) {
          run.build = await readBuildState(ctx, processInfo.process, signalState);
          applyBuildSelection(run, run.build as unknown as BuildEvidenceSelection, ctx);
          run.coverage.editor = { status: 'unavailable', detail: 'VibeUE readiness/heartbeat is missing, stale, or reports a wedged game thread.' };
          addIssue(run, 'editor.unhealthy', 'P0', ctx.project.uprojectPath,
            String(signalState.healthMessage), 'Unreal MCP calls may hang and produce unreliable results.',
            'Recover or relaunch the Editor, then repeat the run.',
            'Clear modal/crash state or relaunch the Editor.', 'confirmed', 'VibeUE heartbeat');
          return;
        }
        gateway = this.gatewayFactory(
          ctx.config.unrealMcp?.url ?? 'http://127.0.0.1:8000/mcp',
          ctx.config.unrealMcp?.connectTimeoutMs ?? 5_000,
          ctx.config.unrealMcp?.requestTimeoutMs ?? 60_000,
        );
        const tools = await gateway.listTools();
        run.editor.tools = tools;
        if (!tools.includes('execute_python_code')) {
          run.coverage.editor = { status: 'unavailable', detail: 'Unreal MCP lacks execute_python_code.' };
          addIssue(run, 'mcp.capability', 'P1', ctx.project.uprojectPath,
            'The connected Unreal MCP does not expose execute_python_code.',
            'ROI-focused batched asset and Blueprint checks cannot run.',
            'Reconnect after enabling the expected capability.',
            'Enable VibeUE or an equivalent read-only batch execution capability.', 'confirmed', 'Unreal MCP');
          return;
        }
        const stateResult = await queryEditorState(gateway);
        const state = stateResult.data;
        const stateRawArtifact = await store.writeArtifact(run.id, 'mcp-editor-state-raw.json', stateResult.raw);
        run.artifacts.push(stateRawArtifact);
        Object.assign(run.editor, state);
        const environmentPid = Number((state.environment as Record<string, unknown> | undefined)?.editorPid);
        if (Number.isFinite(environmentPid) && environmentPid !== processInfo.process?.pid) {
          const detail = `Unreal MCP reports Editor PID ${environmentPid}, but EngineLink selected PID ${processInfo.process?.pid}.`;
          run.coverage.editor = { status: 'unavailable', detail };
          addIssue(run, 'mcp.editor_mismatch', 'P0', ctx.project.uprojectPath, detail,
            'Diagnostics may target a different Editor session or project state.',
            'Close duplicate Editor sessions or point EngineLink at the intended local MCP endpoint, then rerun preflight.',
            'Use one healthy Editor session per local Unreal MCP endpoint.', 'confirmed', 'Unreal MCP');
          return;
        }
        const environmentBuild = (state.environment as Record<string, unknown> | undefined)?.lastBuild;
        run.build = await readBuildState(ctx, processInfo.process, signalState, environmentBuild);
        applyBuildSelection(run, run.build as unknown as BuildEvidenceSelection, ctx);
        const stateErrors = ['mapError', 'dirtyPackagesError', 'openAssetsError'].filter((name) => typeof state[name] === 'string');
        if (stateErrors.length) {
          const detail = `Required Editor state could not be read: ${stateErrors.map((name) => `${name}: ${String(state[name])}`).join('; ')}`;
          run.coverage.editor = { status: 'unavailable', detail };
          addIssue(run, 'editor.state_incomplete', 'P2', ctx.project.uprojectPath, detail,
            'Deep checks cannot prove that their asset state is stable.', 'Correct the unavailable Editor API and repeat preflight.',
            'Restore the required Editor-state capability before relying on Doctor results.', 'unconfirmed', 'Unreal Editor');
          return;
        }
        const dirtyPackages = Array.isArray(state.dirtyPackages) ? state.dirtyPackages : [];
        if (dirtyPackages.length) {
          addIssue(run, 'editor.dirty_packages', 'P2', String(state.currentMap ?? ctx.project.uprojectPath),
            `Editor has ${dirtyPackages.length} dirty package(s): ${dirtyPackages.map(String).join(', ')}`,
            'Scenario map changes and comparisons may not start from a reproducible baseline.',
            'Save or revert the intended packages, then repeat preflight.', 'Resolve dirty packages before running scenario mode.',
            'confirmed', 'Unreal Editor');
        }
        run.coverage.editor = {
          status: 'completed', evidenceSource: stateResult.evidence.evidenceSource,
          evidenceCandidates: stateResult.evidence.candidates, parseWarnings: stateResult.evidence.parseWarnings,
          rawArtifacts: [stateRawArtifact],
        };
      });

      throwIfCancelled(signal);
      if (run.mode === 'preflight') {
        run.coverage.assets = { status: 'not-requested' };
        run.coverage.blueprints = { status: 'not-requested' };
        run.coverage.scenarios = { status: 'not-requested' };
      } else if (!gateway || run.coverage.editor?.status !== 'completed') {
        run.coverage.assets = { status: 'unavailable', detail: 'Editor-side scan was not safe to execute.' };
        run.coverage.blueprints = { status: 'unavailable', detail: 'Editor-side scan was not safe to execute.' };
        run.coverage.scenarios = { status: 'unavailable', detail: 'Editor-side scenario was not safe to execute.' };
      } else if (run.editor.pieRunning === true) {
        const detail = 'PIE or Simulate is already running; Doctor will not silently stop it.';
        run.coverage.assets = { status: 'unavailable', detail };
        run.coverage.blueprints = { status: 'unavailable', detail };
        run.coverage.scenarios = { status: 'unavailable', detail };
        addIssue(run, 'editor.pie_active', 'P1', String(run.editor.currentMap ?? ctx.project.uprojectPath), detail,
          'Loaded asset state and runtime objects may not represent a safe diagnostic baseline.',
          'Stop PIE explicitly and repeat the Doctor run.',
          'Finish the user-owned PIE session before running deep diagnostics.', 'confirmed', 'Unreal Editor');
      } else if (run.mode === 'changed') {
        await this.runChangedScan(ctx, run, gateway, store, signal);
      } else {
        await this.runScenarios(ctx, run, gateway, store, signal);
      }

      throwIfCancelled(signal);
      await this.phase(run, store, 'logs', async () => {
        const logs = await readLogDelta(logSnapshot);
        const artifact = await store.writeArtifact(run.id, 'session-logs.json', logs);
        run.artifacts.push(artifact);
        run.coverage.logs = logs.available
          ? { status: 'completed', detail: `${logs.entries.length} warning/error entries from this run.` }
          : { status: 'unavailable', detail: logs.error };
      });

      if (run.baselineRunId) await this.compareBaseline(run, store);
      finalize(run);
    } catch (error) {
      if (signal.aborted) {
        run.status = 'cancelled';
        run.conclusion = 'Cancelled before all requested evidence was collected.';
      } else if (error instanceof DoctorEvidenceError || error instanceof SafeJsonError) {
        run.status = 'incomplete';
        run.error = error.message;
        run.conclusion = `Project Doctor could not establish trustworthy evidence during ${run.progress.phase}.`;
        const raw = error instanceof DoctorEvidenceError ? error.raw : error.rawInput;
        if (raw !== undefined) {
          const artifact = await store.writeArtifact(run.id, `mcp-${safeName(run.progress.phase)}-parse-failure.json`, raw);
          run.artifacts.push(artifact);
        }
      } else {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        run.conclusion = `Project Doctor failed during ${run.progress.phase}: ${run.error}`;
      }
    } finally {
      run.finishedAt = new Date().toISOString();
      run.summary = summarizeDoctor(run);
      await gateway?.close().catch(() => undefined);
      await lock.release().catch(() => undefined);
      await store.appendEvent(run.id, { phase: 'finish', status: run.status, error: run.error });
      await store.save(run);
    }
  }

  private async runChangedScan(
    ctx: StandaloneContext,
    run: DoctorRun,
    gateway: UnrealMcpGateway,
    store: DoctorStore,
    signal: AbortSignal,
  ): Promise<void> {
    const rules = run.baselineRunId ? await loadBaselineRules(store, run.baselineRunId) : await loadRules(ctx);
    run.ruleIds = rules.map((rule) => rule.id);
    await this.phase(run, store, 'asset-blueprint-scan', async () => {
      throwIfCancelled(signal);
      const ruleArtifact = await store.writeArtifact(run.id, 'rules.json', rules);
      const scanResult = await scanUnrealProject(gateway, run.requestedPaths, run.referenceQueries, unrealRules(rules));
      const scan = scanResult.data;
      const inventory = await store.writeArtifact(run.id, 'inventory.json', scan.inventory);
      const references = await store.writeArtifact(run.id, 'references.json', scan.references);
      const raw = await store.writeArtifact(run.id, 'unreal-scan.json', scan);
      const rawResponse = await store.writeArtifact(run.id, 'mcp-unreal-scan-raw.json', scanResult.raw);
      run.artifacts.push(ruleArtifact, inventory, references, raw, rawResponse);
      applyScanIssues(run, scan, rules);
      await applyConfigRules(ctx, run, rules);
      const evidence = {
        evidenceSource: scanResult.evidence.evidenceSource, evidenceCandidates: scanResult.evidence.candidates,
        parseWarnings: scanResult.evidence.parseWarnings, rawArtifacts: [rawResponse],
      };
      run.coverage.assets = { status: 'completed', detail: `${scan.references.length} scoped dependency edges.`, ...evidence };
      run.coverage.blueprints = { status: 'completed', detail: `${scan.blueprints.length} affected Blueprints read.`, ...evidence };
      run.coverage.rules = { status: 'completed', detail: `${rules.length} project rules evaluated.` };
      run.coverage.scenarios = { status: 'not-requested' };
    });
  }

  private async runScenarios(
    ctx: StandaloneContext,
    run: DoctorRun,
    gateway: UnrealMcpGateway,
    store: DoctorStore,
    signal: AbortSignal,
  ): Promise<void> {
    const specs = await loadScenarios(ctx, run.scenarioNames);
    if (specs.length === 0) throw new Error('Scenario mode requires at least one configured scenario name.');
    run.progress.total = specs.length + 3;
    for (const spec of specs) {
      throwIfCancelled(signal);
      await this.phase(run, store, `scenario:${spec.name}`, async () => {
        const result = await executeDoctorScenario(gateway, spec, signal, ctx.projectRoot);
        run.scenarios.push(result);
        const artifact = await store.writeArtifact(run.id, `scenario-${safeName(spec.name)}.json`, result);
        run.artifacts.push(artifact, ...result.artifacts);
        if (result.status !== 'passed') {
          addIssue(run, `scenario.${safeName(spec.name)}`, 'P1', spec.map,
            result.error ?? `Scenario ended with ${result.status}.`,
            'Runtime behavior is not proven for this scenario.',
            `Repeat scenario '${spec.name}' after correcting its failing stage.`,
            'Fix the first failing precondition or assertion and rerun the same scenario.',
            result.status === 'incomplete' ? 'unconfirmed' : 'confirmed', 'EngineLink/VibeUE scenario');
        }
      });
    }
    run.coverage.assets = { status: 'not-requested' };
    run.coverage.blueprints = { status: 'not-requested' };
    run.coverage.rules = { status: 'not-requested' };
    run.coverage.scenarios = run.scenarios.every((item) => item.status === 'passed')
      ? { status: 'completed', detail: `${run.scenarios.length} scenario(s) passed.` }
      : run.scenarios.some((item) => item.status === 'incomplete' || item.status === 'cancelled')
        ? { status: 'incomplete', detail: 'One or more runtime scenarios could not collect complete evidence.' }
        : { status: 'failed', detail: 'One or more runtime scenarios executed and failed.' };
  }

  private async compareBaseline(run: DoctorRun, store: DoctorStore): Promise<void> {
    const baseline = await store.get(run.baselineRunId!);
    const currentIds = new Set(run.issues.map((issue) => issue.id));
    const baselineIds = new Set(baseline.issues.map((issue) => issue.id));
    const evidenceComplete = Object.values(run.coverage).every((coverage) =>
      coverage.status === 'completed' || coverage.status === 'not-requested');
    run.comparison = {
      resolved: evidenceComplete ? [...baselineIds].filter((id) => !currentIds.has(id)) : [],
      persisting: [...baselineIds].filter((id) => currentIds.has(id)),
      introduced: [...currentIds].filter((id) => !baselineIds.has(id)),
      unverified: evidenceComplete ? [] : [...baselineIds].filter((id) => !currentIds.has(id)),
    };
  }

  private async phase(run: DoctorRun, store: DoctorStore, phase: string, action: () => Promise<void>): Promise<void> {
    run.progress.phase = phase;
    await store.appendEvent(run.id, { phase, status: 'started' });
    await store.save(run);
    try {
      await action();
      run.progress.completed++;
      await store.appendEvent(run.id, { phase, status: 'completed' });
    } catch (error) {
      run.coverage[phase] = { status: 'failed', detail: error instanceof Error ? error.message : String(error) };
      await store.appendEvent(run.id, { phase, status: 'failed', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    await store.save(run);
  }
}

async function changedPaths(projectRoot: string): Promise<string[]> {
  const result = await spawnAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: projectRoot }).catch(() => undefined);
  if (!result || result.exitCode !== 0) return [];
  const paths: string[] = [];
  const records = result.stdout.split('\0').filter(Boolean);
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const status = record.slice(0, 2);
    const file = record.slice(3);
    if (file) paths.push(file);
    if ((status[0] === 'R' || status[0] === 'C') && records[index + 1]) paths.push(records[++index]);
  }
  return unique(paths);
}

function assertSameExplicitScope(name: string, requested: string[] | undefined, baseline: string[] | undefined): void {
  if (requested === undefined || baseline === undefined) return;
  const left = [...new Set(requested)].sort();
  const right = [...new Set(baseline)].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`Baseline comparison requires the same ${name}; omit it to reuse the baseline scope.`);
  }
}

async function readBuildState(
  ctx: StandaloneContext,
  editor?: DoctorEditorProcess['process'],
  signals: Record<string, unknown> = {},
  environmentBuild?: unknown,
  ambiguousEditors = false,
): Promise<BuildEvidenceSelection> {
  const engineLink = await new RunStore(ctx.projectRoot).getLatest('build');
  const vibePath = path.join(ctx.projectRoot, 'Saved', 'VibeUE', 'last-build.json');
  const vibe = await readJson(vibePath);
  const inputs = [
    candidateFromRecord('EngineLink', engineLink),
    candidateFromRecord('VibeUE persisted', vibe),
    candidateFromRecord('VibeUE MCP environment', environmentBuild),
  ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
  const readiness = signals.readiness as Record<string, unknown> | null | undefined;
  const health = signals.health as Record<string, unknown> | null | undefined;
  const selection = selectBuildEvidence(inputs, {
    project: ctx.project.uprojectPath,
    editorPid: ambiguousEditors ? Number.NaN : editor?.pid,
    editorStartedAt: editor?.startedAt,
    sessionStartUtc: typeof readiness?.sessionStartUtc === 'string' ? readiness.sessionStartUtc : undefined,
    readinessSessionStartUtc: typeof readiness?.sessionStartUtc === 'string' ? readiness.sessionStartUtc : undefined,
    healthSessionStartUtc: typeof health?.sessionStartUtc === 'string' ? health.sessionStartUtc : undefined,
    latestSourceTime: await latestSourceModifiedAt(ctx.projectRoot),
  });
  if ((!editor || ambiguousEditors) && selection.authoritative) {
    selection.authoritative.classifications = selection.authoritative.classifications.filter((item) => item !== 'authoritative' && item !== 'current');
    selection.authoritative.classifications.push('historical');
    selection.authoritative.reason = ambiguousEditors
      ? 'Multiple current Editor sessions make build authority ambiguous.'
      : 'No current Editor session exists to establish build authority.';
    selection.history.unshift(selection.authoritative);
    selection.authoritative = null;
  }
  return selection;
}

function applyBuildSelection(run: DoctorRun, selection: BuildEvidenceSelection, ctx: StandaloneContext): void {
  const authoritative = selection.authoritative;
  if (!authoritative) {
    run.coverage.build = { status: 'unavailable', detail: 'No real build can be associated with the current project and Editor session.' };
    addIssue(run, 'build.unverified', 'P2', ctx.project.uprojectPath,
      'No authoritative current build record was found; historical candidates are retained separately.',
      'Static and runtime checks may be using stale binaries.', 'Run a real build for this project/session and rerun Doctor.',
      'Create a fresh successful build after the latest source change.', 'unconfirmed', 'EngineLink build evidence');
  } else if (authoritative.status === 'failed') {
    run.coverage.build = { status: 'failed', detail: `Authoritative ${authoritative.source} build failed.` };
    addIssue(run, 'build.latest_failed', 'P0', ctx.project.uprojectPath,
      `The authoritative current build from ${authoritative.source} failed.`, 'C++ and reflected types may not match the project assets.',
      'Inspect the authoritative build diagnostics.', 'Fix the build before trusting asset or runtime verification.',
      'confirmed', authoritative.source);
  } else {
    run.coverage.build = { status: 'completed', detail: `Authoritative ${authoritative.source} build succeeded.` };
  }
}

async function latestSourceModifiedAt(projectRoot: string): Promise<string | undefined> {
  const queue = ['Source', 'Plugins'].map((entry) => path.join(projectRoot, entry));
  let latest = 0;
  while (queue.length) {
    const directory = queue.pop()!;
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(file);
      else if (/\.(?:h|hpp|c|cc|cpp|cs)$/i.test(entry.name)) latest = Math.max(latest, (await fs.promises.stat(file)).mtimeMs);
    }
  }
  return latest ? new Date(latest).toISOString() : undefined;
}

async function readVibeSignals(projectRoot: string, processInfo?: DoctorEditorProcess['process']): Promise<Record<string, unknown>> {
  const pid = processInfo?.pid;
  if (!pid) return {};
  const directory = path.join(projectRoot, 'Saved', 'VibeUE', 'Signals');
  const readiness = await readJson(path.join(directory, `editor-${pid}-true.json`));
  const health = await readJson(path.join(directory, `editor-${pid}-health.json`));
  const readinessObject = readiness && !Array.isArray(readiness) ? readiness : undefined;
  const healthObject = health && !Array.isArray(health) ? health : undefined;
  const readinessSession = String(readinessObject?.sessionStartUtc ?? '');
  const healthSession = String(healthObject?.sessionStartUtc ?? '');
  const sessionsAgree = !readinessSession || !healthSession || Math.abs(Date.parse(readinessSession) - Date.parse(healthSession)) <= 5_000;
  const afterProcessStart = !processInfo.startedAt || !readinessSession || Date.parse(readinessSession) >= Date.parse(processInfo.startedAt) - 5_000;
  const readinessValid = Number(readinessObject?.pid) === pid && readinessObject?.signal === 'toolsets-registered' &&
    (!healthObject || Number(healthObject.pid) === pid) && sessionsAgree && afterProcessStart;
  const readinessSummary = readinessObject ? {
    signal: readinessObject.signal, pid: readinessObject.pid, createdUtc: readinessObject.createdUtc,
    sessionStartUtc: readinessObject.sessionStartUtc, pluginVersion: readinessObject.pluginVersion, currentMap: readinessObject.currentMap,
  } : null;
  if (!health) {
    return {
      readiness: readinessSummary, health: null, readinessValid, heartbeatStale: true,
      healthMessage: 'VibeUE health heartbeat is missing; refusing a potentially hanging Unreal MCP call.',
    };
  }
  const updated = Date.parse(String(healthObject?.updatedUtc ?? ''));
  const ageMs = Number.isFinite(updated) ? Date.now() - updated : Number.POSITIVE_INFINITY;
  const stall = Number(healthObject?.gameThreadStallSeconds ?? 0);
  return {
    readiness: readinessSummary,
    readinessValid,
    health,
    sessionIdentityValid: sessionsAgree && afterProcessStart,
    heartbeatAgeMs: ageMs,
    heartbeatStale: ageMs > 15_000,
    gameThreadWedged: stall > 10,
    healthMessage: ageMs > 15_000
      ? `Editor heartbeat is ${Math.round(ageMs / 1000)} seconds old.`
      : stall > 10 ? `Editor game thread reports a ${stall} second stall.` : 'healthy',
  };
}

async function loadRules(ctx: StandaloneContext): Promise<DoctorRule[]> {
  const configured = ctx.config.doctor?.rulesDirectory ?? path.join('.enginelink', 'doctor', 'rules');
  const directory = confinedPath(ctx.projectRoot, configured);
  const files = (await fs.promises.readdir(directory).catch(() => [] as string[])).filter((file) => file.endsWith('.json')).sort();
  const rules: DoctorRule[] = [];
  for (const file of files) {
    const parsed = await readJson(path.join(directory, file));
    const items = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { rules?: unknown[] } | undefined)?.rules)
      ? (parsed as { rules: unknown[] }).rules : [];
    for (const item of items) rules.push(validateRule(item));
  }
  return rules;
}

async function loadBaselineRules(store: DoctorStore, baselineRunId: string): Promise<DoctorRule[]> {
  const parsed = await readJson(path.join(store.runDirectory(baselineRunId), 'rules.json'));
  if (!Array.isArray(parsed)) throw new Error('Baseline rule snapshot is unavailable; it cannot be compared with identical rules.');
  return parsed.map(validateRule);
}

async function loadScenarios(ctx: StandaloneContext, names: string[]): Promise<DoctorScenarioSpec[]> {
  const configured = ctx.config.doctor?.scenariosDirectory ?? path.join('.enginelink', 'doctor', 'scenarios');
  const directory = confinedPath(ctx.projectRoot, configured);
  const requested = names.length ? names : [];
  const specs: DoctorScenarioSpec[] = [];
  for (const name of requested) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`Invalid scenario name: ${name}`);
    const parsed = await readJson(path.join(directory, name.endsWith('.json') ? name : `${name}.json`));
    specs.push(validateScenario(parsed));
  }
  return specs;
}

function validateRule(value: unknown): DoctorRule {
  if (!value || typeof value !== 'object') throw new Error('Doctor rule must be an object.');
  const rule = value as Partial<DoctorRule> & { params?: unknown };
  const kinds = ['asset_exists', 'asset_absent', 'reference_exists', 'reference_absent', 'config_contains', 'config_absent',
    'property_equals', 'blueprint_node_present', 'blueprint_node_absent', 'blueprint_path_reaches'];
  if (!rule.id || !/^[A-Za-z0-9_.-]+$/.test(rule.id) || !rule.kind || !kinds.includes(rule.kind) ||
      !rule.domain || !['P0', 'P1', 'P2'].includes(String(rule.severity)) || !rule.description || !rule.params) {
    throw new Error(`Invalid Doctor rule: ${JSON.stringify(value)}`);
  }
  return value as DoctorRule;
}

function validateScenario(value: unknown): DoctorScenarioSpec {
  const spec = value as Partial<DoctorScenarioSpec>;
  if (!spec || spec.schema !== 'enginelink.doctor-scenario.v1' || !spec.name || !spec.map?.startsWith('/Game/') ||
      !Number.isInteger(spec.clients) || Number(spec.clients) < 1 || !Array.isArray(spec.steps) || spec.steps.length === 0) {
    throw new Error('Invalid Project Doctor scenario. Expected schema, name, /Game map, clients >= 1, and non-empty steps.');
  }
  return spec as DoctorScenarioSpec;
}

function unrealRules(rules: DoctorRule[]): DoctorRule[] {
  return rules.filter((rule) => rule.kind !== 'config_contains' && rule.kind !== 'config_absent');
}

async function applyConfigRules(ctx: StandaloneContext, run: DoctorRun, rules: DoctorRule[]): Promise<void> {
  for (const rule of rules) {
    if (rule.kind !== 'config_contains' && rule.kind !== 'config_absent') continue;
    const file = confinedPath(ctx.projectRoot, rule.params.file);
    const content = await fs.promises.readFile(file, 'utf8').catch(() => undefined);
    const contains = content?.includes(rule.params.value) === true;
    const passed = rule.kind === 'config_contains' ? contains : !contains;
    if (!passed) addRuleIssue(run, rule, file, content === undefined ? 'Configuration file could not be read.' : `Value '${rule.params.value}' ${contains ? 'is present' : 'is absent'}.`);
  }
}

function applyScanIssues(run: DoctorRun, scan: UnrealScanResult, rules: DoctorRule[]): void {
  for (const ref of scan.references) {
    if (!ref.resolved) addIssue(run, 'asset.missing_reference', 'P1', ref.from,
      `Reference target '${ref.to}' could not be resolved.`, 'Loading or executing the source asset may fail.',
      `Open '${ref.from}' and confirm or replace '${ref.to}'.`, 'Repair or remove the broken reference, then rerun the same scope.',
      'confirmed', 'Asset Registry');
  }
  for (const blueprint of scan.blueprints) {
    if (/error|failed/i.test(blueprint.compileStatus)) addIssue(run, 'blueprint.compile', 'P1', blueprint.path,
      `Blueprint compile status is ${blueprint.compileStatus}.`, 'Blueprint behavior may be stale or unavailable.',
      `Compile '${blueprint.path}' and inspect compiler diagnostics.`, 'Correct compiler errors and rerun the same Doctor scope.',
      'confirmed', 'BlueprintService');
    for (const issue of blueprint.issues) {
      const location = [blueprint.path, issue.graph, issue.node].filter(Boolean).join(' :: ');
      addIssue(run, issue.ruleId, issue.severity, location, issue.evidence,
        issue.confidence === 'inferred' ? 'This graph shape may hide an unhandled runtime path.' : 'The Blueprint graph contains a directly observed structural problem.',
        `Inspect '${location}' and exercise the affected path.`, 'Connect, remove, or deliberately document the node/path, then rescan.',
        issue.confidence, 'BlueprintService');
    }
  }
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  for (const result of scan.rules) {
    if (!result.passed) {
      const rule = byId.get(result.id);
      if (rule) addRuleIssue(run, rule, result.path, result.evidence);
    }
  }
}

function addRuleIssue(run: DoctorRun, rule: DoctorRule, target: string, evidence: string): void {
  addIssue(run, rule.id, rule.severity, target, evidence, rule.description,
    `Re-run rule '${rule.id}' after the affected asset or configuration changes.`,
    `Make the project satisfy the '${rule.kind}' assertion.`, 'confirmed', `rule:${rule.domain}`);
}

function addIssue(
  run: DoctorRun, ruleId: string, severity: DoctorSeverity, targetPath: string, evidence: string,
  impact: string, verification: string, recommendation: string, confidence: DoctorConfidence, source: string,
): void {
  const id = stableIssueId(ruleId, targetPath);
  if (run.issues.some((issue) => issue.id === id)) return;
  run.issues.push({
    id, ruleId, severity, path: targetPath, evidence, impact, verification, recommendation, confidence,
    discoveredAt: new Date().toISOString(), sessionId: run.id, source,
  });
}

function finalize(run: DoctorRun): void {
  const result = calculateDoctorStatus(run);
  run.status = result.status;
  run.conclusion = result.conclusion;
  run.summary = summarizeDoctor(run);
}

function stableIssueId(ruleId: string, target: string): string {
  const hash = crypto.createHash('sha1').update(`${ruleId}\0${target.replace(/\\/g, '/').toLowerCase()}`).digest('hex').slice(0, 10);
  return `UEPD-${ruleId.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}-${hash}`;
}

async function snapshotLog(ctx: StandaloneContext): Promise<{ file: string; size: number }> {
  const file = path.join(ctx.projectRoot, 'Saved', 'Logs', `${ctx.project.name}.log`);
  const stat = await fs.promises.stat(file).catch(() => undefined);
  return { file, size: stat?.size ?? 0 };
}

async function readLogDelta(snapshot: { file: string; size: number }): Promise<{ available: boolean; entries: unknown[]; error?: string }> {
  const buffer = await fs.promises.readFile(snapshot.file).catch(() => undefined);
  if (!buffer) return { available: false, entries: [], error: `Log file is unavailable: ${snapshot.file}` };
  if (buffer.length < snapshot.size) return { available: false, entries: [], error: 'The project log was truncated or rotated during this run.' };
  const text = buffer.subarray(snapshot.size).toString('utf8');
  const entries = text.split(/\r?\n/).map((message, index) => ({ message, line: index + 1 }))
    .filter((item) => /\b(fatal|error|warning)\b/i.test(item.message))
    .map((item) => ({
      ...item,
      severity: /\bfatal\b/i.test(item.message) ? 'fatal' : /\berror\b/i.test(item.message) ? 'error' : 'warning',
      category: item.message.match(/\b(Log[A-Za-z0-9_]+):/)?.[1] ?? 'Unknown',
    }));
  return { available: true, entries };
}

function confinedPath(root: string, configured: string): string {
  if (path.isAbsolute(configured)) throw new Error(`Doctor path must be project-relative: ${configured}`);
  const resolved = path.resolve(root, configured);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Doctor path escapes the project: ${configured}`);
  return resolved;
}

async function readJson(file: string): Promise<Record<string, unknown> | unknown[] | undefined> {
  return fs.promises.readFile(file).then(
    (text) => parseJsonValue<Record<string, unknown> | unknown[]>(text, file),
    () => undefined,
  );
}

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function safeName(value: string): string { return value.replace(/[^A-Za-z0-9_.-]+/g, '-'); }
function createDoctorRunId(): string {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-doctor-${crypto.randomBytes(4).toString('hex')}`;
}
function throwIfCancelled(signal: AbortSignal): void { if (signal.aborted) throw new Error('Doctor run cancelled.'); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
