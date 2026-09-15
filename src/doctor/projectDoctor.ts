import { DEFAULT_DOCTOR_TIMEOUT_MS, DOCTOR_LOCK_STALE_MS, type DoctorRun, type DoctorSeverity, type DoctorStartOptions, type UnrealScanResult } from './types';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { StandaloneContext } from '../core/discovery';
import { RunStore } from '../core/runStore';
import { spawnAsync } from '../platform/process';
import { ProjectDoctorLock } from './projectLock';
import { DoctorStore } from './store';
import { applyHostChecks } from './hostChecks';
import { UnrealMcpClient, type UnrealMcpGateway } from './unrealMcpClient';
import { loadNativeToolCatalog, queryEditorState, scanUnrealProject, type NativeToolCatalog } from './unrealScanner';
import { calculateDoctorStatus } from './status';
import { SafeJsonError } from '../parsers/safeJson';
import { DoctorEvidenceError } from './evidence';
import { candidateFromRecord, selectBuildEvidence, type BuildEvidenceSelection } from './buildEvidence';

export interface DoctorEditorProcess {
  running: boolean;
  process: { pid: number; project?: string; commandLine?: string; startedAt?: string } | null;
  processes?: Array<{ pid: number; project?: string; commandLine?: string; startedAt?: string }>;
}

type GatewayFactory = (url: string, connectTimeoutMs: number, requestTimeoutMs: number) => UnrealMcpGateway;

export class ProjectDoctor {
  constructor(
    private readonly context: () => Promise<StandaloneContext>,
    private readonly editorProcess: () => Promise<DoctorEditorProcess>,
    private readonly gatewayFactory: GatewayFactory = (url, connect, request) => new UnrealMcpClient(url, connect, request),
    private readonly hostChecks: typeof applyHostChecks = applyHostChecks,
  ) {}

  async run(options: DoctorStartOptions = {}): Promise<DoctorRun> {
    const ctx = await this.context();
    const id = createDoctorRunId();
    const paths = options.paths !== undefined ? unique(options.paths) : await changedPaths(ctx.projectRoot);
    const run: DoctorRun = {
      schema: 'enginelink.doctor-run.v1',
      id,
      status: 'running',
      startedAt: new Date().toISOString(),
      project: ctx.project.uprojectPath,
      projectRoot: ctx.projectRoot,
      requestedPaths: paths,
      phase: 'queued',
      coverage: {},
      editor: {},
      build: {},
      issues: [],
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS);
    try {
      await this.execute(ctx, run, controller.signal);
    } finally {
      clearTimeout(timer);
    }
    return run;
  }

  private async execute(ctx: StandaloneContext, run: DoctorRun, signal: AbortSignal): Promise<void> {
    const store = new DoctorStore(ctx.projectRoot);
    const lock = new ProjectDoctorLock(ctx.projectRoot, DOCTOR_LOCK_STALE_MS);
    let gateway: UnrealMcpGateway | undefined;
    const logSnapshot = await snapshotLog(ctx);
    try {
      await lock.acquire(run.id);
      await this.phase(run, 'preflight', async () => {
        await this.hostChecks(ctx, run);
        const processInfo = await this.editorProcess();
        run.editor = {
          process: processInfo.process,
          processes: processInfo.processes ?? (processInfo.process ? [processInfo.process] : []),
          running: processInfo.running,
        };
        if ((processInfo.processes?.length ?? 0) > 1) {
          run.build = await readBuildState(ctx, processInfo.process, true);
          run.coverage.build = { status: 'unavailable', detail: 'Build authority is ambiguous while multiple Editors have this project open.' };
          run.coverage.editor = { status: 'unavailable', detail: `${processInfo.processes!.length} Unreal Editor processes have the same project open.` };
          return;
        }
        if (!processInfo.running) {
          run.build = await readBuildState(ctx);
          applyBuildSelection(run, run.build as unknown as BuildEvidenceSelection, ctx);
          run.coverage.editor = { status: 'unavailable', detail: 'Unreal Editor is not running.' };
          return;
        }
        gateway = this.gatewayFactory(
          ctx.config.unrealMcp?.url ?? 'http://127.0.0.1:8000/mcp',
          ctx.config.unrealMcp?.connectTimeoutMs ?? 5_000,
          ctx.config.unrealMcp?.requestTimeoutMs ?? 60_000,
        );
        let catalog: NativeToolCatalog;
        try {
          catalog = await abortable(signal, loadNativeToolCatalog(gateway));
        } catch (error) {
          if (signal.aborted) throw error;
          run.coverage.editor = {
            status: 'unavailable',
            detail: error instanceof Error ? error.message : String(error),
          };
          run.build = await readBuildState(ctx, processInfo.process);
          applyBuildSelection(run, run.build as unknown as BuildEvidenceSelection, ctx);
          return;
        }
        run.editor.nativeTools = catalog;
        run.editor.catalog = catalog;
        if (!catalog.pie) {
          run.coverage.editor = { status: 'unavailable', detail: 'Unreal MCP has no IsPIERunning tool. Enable AllToolsets.' };
          run.build = await readBuildState(ctx, processInfo.process);
          applyBuildSelection(run, run.build as unknown as BuildEvidenceSelection, ctx);
          return;
        }
        const stateResult = await abortable(signal, queryEditorState(gateway, catalog));
        const state = stateResult.data;
        Object.assign(run.editor, state);
        run.build = await readBuildState(ctx, processInfo.process);
        applyBuildSelection(run, run.build as unknown as BuildEvidenceSelection, ctx);
        const dirtyPackages = Array.isArray(state.dirtyPackages) ? state.dirtyPackages : [];
        if (dirtyPackages.length) {
          addIssue(run, 'editor.dirty_packages', 'P2', String(state.currentMap ?? ctx.project.uprojectPath),
            `Editor has ${dirtyPackages.length} dirty package(s): ${dirtyPackages.map(String).join(', ')}`,
            'Resolve dirty packages before relying on asset conclusions.');
        }
        run.coverage.editor = { status: 'completed' };
      });

      throwIfCancelled(signal);
      if (!gateway || run.coverage.editor?.status !== 'completed') {
        run.coverage.assets = { status: 'unavailable', detail: 'Editor-side scan was not safe to execute.' };
        run.coverage.blueprints = { status: 'unavailable', detail: 'Editor-side scan was not safe to execute.' };
      } else if (run.editor.pieRunning === true) {
        const detail = 'PIE or Simulate is already running; Doctor will not silently stop it.';
        run.coverage.assets = { status: 'unavailable', detail };
        run.coverage.blueprints = { status: 'unavailable', detail };
      } else {
        await this.runChangedScan(run, gateway, store, signal);
      }

      throwIfCancelled(signal);
      await this.phase(run, 'logs', async () => {
        const logs = await readLogDelta(logSnapshot);
        run.coverage.logs = logs.available
          ? { status: 'completed', detail: `${logs.entries.length} warning/error entries from this run.` }
          : { status: 'unavailable', detail: logs.error };
      });

      finalize(run);
    } catch (error) {
      if (signal.aborted) {
        run.status = 'incomplete';
        run.error = 'Doctor timed out before all requested evidence was collected.';
        run.conclusion = 'The diagnostic did not finish within the requested timeout.';
      } else if (error instanceof DoctorEvidenceError || error instanceof SafeJsonError) {
        run.status = 'incomplete';
        run.error = error.message;
        run.conclusion = `Project Doctor could not establish trustworthy evidence during ${run.phase}.`;
        const raw = error instanceof DoctorEvidenceError ? error.raw : error.rawInput;
        if (raw !== undefined) {
          await store.writeArtifact(run.id, `mcp-${safeName(run.phase)}-parse-failure.json`, raw);
        }
      } else {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        run.conclusion = `Project Doctor failed during ${run.phase}: ${run.error}`;
      }
    } finally {
      run.finishedAt = new Date().toISOString();
      await gateway?.close().catch(() => undefined);
      await lock.release().catch(() => undefined);
      await store.save(run);
    }
  }

  private async runChangedScan(
    run: DoctorRun,
    gateway: UnrealMcpGateway,
    store: DoctorStore,
    signal: AbortSignal,
  ): Promise<void> {
    await this.phase(run, 'asset-blueprint-scan', async () => {
      throwIfCancelled(signal);
      const catalog = (run.editor.catalog ?? run.editor.nativeTools) as NativeToolCatalog;
      const scanResult = await abortable(signal, scanUnrealProject(gateway, catalog, run.requestedPaths));
      const scan = scanResult.data;
      await store.writeArtifact(run.id, 'scan.json', {
        inventory: scan.inventory,
        references: scan.references,
        blueprints: scan.blueprints,
      });
      applyScanIssues(run, scan);
      if (scan.missingTools.includes('asset referencer/dependency tool')) {
        run.coverage.assets = { status: 'incomplete', detail: 'Native MCP has no asset referencer/dependency tool.' };
        run.coverage.blueprints = { status: 'incomplete', detail: 'Native MCP has no Blueprint graph tool.' };
        return;
      }
      run.coverage.assets = { status: 'completed', detail: `${scan.references.length} scoped dependency edges.` };
      run.coverage.blueprints = { status: 'completed', detail: `${scan.blueprints.length} affected Blueprints read.` };
    });
  }

  private async phase(run: DoctorRun, phase: string, action: () => Promise<void>): Promise<void> {
    run.phase = phase;
    try {
      await action();
    } catch (error) {
      run.coverage[phase] = { status: 'failed', detail: error instanceof Error ? error.message : String(error) };
      throw error;
    }
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

async function readBuildState(
  ctx: StandaloneContext,
  editor?: DoctorEditorProcess['process'],
  ambiguousEditors = false,
): Promise<BuildEvidenceSelection> {
  const engineLink = await new RunStore(ctx.projectRoot).getLatest('build');
  const inputs = [candidateFromRecord('EngineLink', engineLink)]
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
  const selection = selectBuildEvidence(inputs, {
    project: ctx.project.uprojectPath,
    editorPid: ambiguousEditors ? Number.NaN : editor?.pid,
    editorStartedAt: editor?.startedAt,
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
  } else if (authoritative.status === 'failed') {
    run.coverage.build = { status: 'failed', detail: `Authoritative ${authoritative.source} build failed.` };
    addIssue(run, 'build.latest_failed', 'P0', ctx.project.uprojectPath,
      `The authoritative current build from ${authoritative.source} failed.`,
      'Fix the build before trusting asset verification.');
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

function applyScanIssues(run: DoctorRun, scan: UnrealScanResult): void {
  for (const ref of scan.references) {
    if (!ref.resolved) addIssue(run, 'asset.missing_reference', 'P1', ref.from,
      `Reference target '${ref.to}' could not be resolved.`,
      'Repair or remove the broken reference, then rerun the same scope.');
  }
  for (const blueprint of scan.blueprints) {
    if (/error|failed/i.test(blueprint.compileStatus)) addIssue(run, 'blueprint.compile', 'P1', blueprint.path,
      `Blueprint compile status is ${blueprint.compileStatus}.`,
      'Correct compiler errors and rerun the same Doctor scope.');
    for (const issue of blueprint.issues) {
      const location = [blueprint.path, issue.graph, issue.node].filter(Boolean).join(' :: ');
      addIssue(run, issue.ruleId, issue.severity, location, issue.evidence,
        'Connect, remove, or deliberately document the node/path, then rescan.');
    }
  }
}

function addIssue(
  run: DoctorRun, ruleId: string, severity: DoctorSeverity, targetPath: string, evidence: string, recommendation: string,
): void {
  const id = stableIssueId(ruleId, targetPath);
  if (run.issues.some((issue) => issue.id === id)) return;
  run.issues.push({ id, ruleId, severity, path: targetPath, evidence, recommendation });
}

function finalize(run: DoctorRun): void {
  const result = calculateDoctorStatus(run);
  run.status = result.status;
  run.conclusion = result.conclusion;
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

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function safeName(value: string): string { return value.replace(/[^A-Za-z0-9_.-]+/g, '-'); }
function createDoctorRunId(): string {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-doctor-${crypto.randomBytes(4).toString('hex')}`;
}
function throwIfCancelled(signal: AbortSignal): void { if (signal.aborted) throw new Error('Doctor timed out.'); }
function abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error('Doctor timed out.');
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Doctor timed out.'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}
