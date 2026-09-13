import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { buildCommandLine, cleanCommandLine, generateClangDatabaseCommandLine } from '../build/ubt';
import { postProcessCompileCommandsFile } from '../cursor/compileCommandsPostProcess';
import { detectBuildTools } from '../detection/buildToolsDetector';
import { parseBuildLine } from '../parsers/buildOutputParser';
import { spawnAsync } from '../platform/process';
import type { BuildConfiguration, BuildPlatform, BuildTargetType, ParsedDiagnostic } from '../types';
import { exists } from './config';
import { resolveStandaloneContext, type StandaloneContext } from './discovery';
import { createRunId, RunStore, type RunRecord } from './runStore';
import { ProjectDoctor } from '../doctor/projectDoctor';
import type { DoctorRun, DoctorStartOptions } from '../doctor/types';
import { parseJsonValue } from '../parsers/safeJson';

export interface OperationContext {
  taskId?: string;
  reason?: string;
}

export interface BuildOptions extends OperationContext {
  configuration?: BuildConfiguration;
  targetType?: BuildTargetType;
  platform?: BuildPlatform;
}

export interface AcceptanceOptions extends OperationContext {
  tier: string;
  evidenceNotes?: string;
}

export interface EditorProcessInfo {
  pid: number;
  project?: string;
  commandLine?: string;
  startedAt?: string;
}

export class EngineLinkService {
  private readonly contextPromise: Promise<StandaloneContext>;
  private readonly projectDoctor: ProjectDoctor;

  constructor(startPath = process.cwd()) {
    this.contextPromise = resolveStandaloneContext(startPath);
    this.projectDoctor = new ProjectDoctor(
      () => this.contextPromise,
      () => this.getEditorProcess(),
    );
  }

  async getEnvironment(): Promise<Record<string, unknown>> {
    const ctx = await this.contextPromise;
    const buildTools = await detectBuildTools();
    return {
      schema: 'enginelink.environment.v1',
      project: ctx.project,
      engine: ctx.engine,
      buildTools: buildTools ?? null,
      defaults: this.buildDefaults(ctx),
      configPath: path.join(ctx.projectRoot, '.enginelink', 'project.json'),
      responsibilities: {
        engineLink: 'Host-side discovery, cold builds, editor process launch, diagnostics, compile database, and acceptance.',
        unrealMcp: 'Editor-side assets, PIE, Live Coding, transactions, and VibeUE toolsets.',
      },
    };
  }

  async startProjectDoctor(options: DoctorStartOptions = {}): Promise<DoctorRun> {
    return this.projectDoctor.start(options);
  }

  async getProjectDoctorRun(runId: string): Promise<DoctorRun> {
    return this.projectDoctor.get(runId);
  }

  async cancelProjectDoctorRun(runId: string): Promise<DoctorRun> {
    return this.projectDoctor.cancel(runId);
  }

  async waitForProjectDoctorRun(runId: string, timeoutMs?: number): Promise<DoctorRun> {
    return this.projectDoctor.waitForTerminal(runId, timeoutMs);
  }

  async build(options: BuildOptions = {}): Promise<RunRecord> {
    const ctx = await this.contextPromise;
    const defaults = this.buildDefaults(ctx);
    const command = buildCommandLine(ctx.engine, ctx.project, {
      configuration: options.configuration ?? defaults.configuration,
      targetType: options.targetType ?? defaults.targetType,
      platform: options.platform ?? defaults.platform,
    });
    const projectProcess = await this.findProjectEditor(ctx.project.uprojectPath);
    if (projectProcess) {
      const message = `Unreal Editor is running for this project (PID ${projectProcess.pid}). Use Unreal MCP LiveCodingToolset for compatible changes, or close the editor before a cold build.`;
      return this.saveBlockedRun('build', ctx, command.executable, command.args, options, message, { editorPid: projectProcess.pid });
    }
    return this.runCommand('build', ctx, command.executable, command.args, options);
  }

  async clean(options: BuildOptions & { confirm?: boolean } = {}): Promise<RunRecord> {
    const ctx = await this.contextPromise;
    const defaults = this.buildDefaults(ctx);
    const command = cleanCommandLine(ctx.engine, ctx.project, {
      configuration: options.configuration ?? defaults.configuration,
      targetType: options.targetType ?? defaults.targetType,
      platform: options.platform ?? defaults.platform,
    });
    if (!options.confirm) {
      return this.saveBlockedRun(
        'clean', ctx, command.executable, command.args, options,
        'Clean removes build products. Re-run with confirm=true.',
      );
    }
    return this.runCommand('clean', ctx, command.executable, command.args, options);
  }

  async getBuildDiagnostics(): Promise<Record<string, unknown>> {
    const ctx = await this.contextPromise;
    const latest = await new RunStore(ctx.projectRoot).getLatest('build');
    return latest
      ? { runId: latest.id, success: latest.success, diagnostics: latest.diagnostics ?? [] }
      : { runId: null, success: null, diagnostics: [] };
  }

  async generateCompileCommands(options: BuildOptions = {}): Promise<RunRecord> {
    const ctx = await this.contextPromise;
    const defaults = this.buildDefaults(ctx);
    const command = generateClangDatabaseCommandLine(ctx.engine, ctx.project, {
      configuration: options.configuration ?? defaults.configuration,
      platform: options.platform ?? defaults.platform,
    });
    const record = await this.runCommand('compile-commands', ctx, command.executable, command.args, options);
    if (!record.success) return record;
    const dbPath = path.join(ctx.projectRoot, 'compile_commands.json');
    if (!(await exists(dbPath))) throw new Error(`UBT succeeded but did not create ${dbPath}`);
    const postProcess = await postProcessCompileCommandsFile(ctx.projectRoot, ctx.engine.root);
    record.details = { ...(record.details ?? {}), postProcess: postProcess.stats, compileCommandsPath: dbPath };
    await new RunStore(ctx.projectRoot).save(record);
    return record;
  }

  async getEditorProcess(): Promise<{ running: boolean; process: EditorProcessInfo | null; processes: EditorProcessInfo[] }> {
    const ctx = await this.contextPromise;
    const processes = await this.findProjectEditors(ctx.project.uprojectPath);
    return { running: processes.length > 0, process: processes[0] ?? null, processes };
  }

  async launchEditor(options: OperationContext = {}): Promise<Record<string, unknown>> {
    const ctx = await this.contextPromise;
    const existing = await this.findProjectEditor(ctx.project.uprojectPath);
    if (existing) return { launched: false, existing: true, process: existing };
    if (!(await exists(ctx.engine.editorPath))) throw new Error(`Unreal Editor not found: ${ctx.engine.editorPath}`);
    const args = [ctx.project.uprojectPath];
    if (ctx.config.editor?.map) args.push(ctx.config.editor.map);
    args.push(...(ctx.config.editor?.args ?? []));
    const child = spawn(ctx.engine.editorPath, args, {
      cwd: ctx.projectRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    const id = createRunId('launch');
    const now = new Date().toISOString();
    const record: RunRecord = {
      schema: 'enginelink.run.v1', id, kind: 'launch', taskId: options.taskId, reason: options.reason,
      startedAt: now, finishedAt: now, success: true, durationMs: 0,
      project: ctx.project.uprojectPath, engine: ctx.engine.root,
      command: { executable: ctx.engine.editorPath, args },
      details: { pid: child.pid },
    };
    await new RunStore(ctx.projectRoot).save(record);
    return { launched: true, existing: false, pid: child.pid, runId: id };
  }

  async runAcceptance(options: AcceptanceOptions): Promise<RunRecord> {
    const ctx = await this.contextPromise;
    const acceptance = ctx.config.acceptance;
    if (!acceptance) throw new Error('No acceptance command is configured in .enginelink/project.json');
    const args = [...(acceptance.args ?? [])];
    if (acceptance.tierArgument) args.push(acceptance.tierArgument, options.tier);
    if (options.evidenceNotes) args.push('-EvidenceNotes', options.evidenceNotes);
    const record = await this.runCommand('acceptance', ctx, acceptance.command, args, options);
    record.evidencePath = await this.findLatestEvidence(ctx, acceptance.evidenceRoot);
    await new RunStore(ctx.projectRoot).save(record);
    return record;
  }

  async getRun(id: string): Promise<RunRecord> {
    const ctx = await this.contextPromise;
    return new RunStore(ctx.projectRoot).get(id);
  }

  async explainRun(id: string): Promise<string> {
    const run = await this.getRun(id);
    const manual = run.kind === 'build'
      ? 'Close Unreal Editor, then run the recorded UBT command in PowerShell.'
      : run.kind === 'compile-commands'
        ? 'Run UnrealBuildTool in GenerateClangDatabase mode, then point clangd at the project-root compile_commands.json.'
        : run.kind === 'launch'
          ? 'Open the .uproject from Explorer or run UnrealEditor.exe with the project path.'
          : 'Run the recorded project acceptance command from the project root.';
    return `# EngineLink run ${run.id}\n\n- Operation: ${run.kind}\n- Reason: ${run.reason || 'Not supplied'}\n- Result: ${run.success ? 'succeeded' : 'failed'}\n- Duration: ${run.durationMs} ms\n\n## Manual equivalent\n\n${manual}\n`;
  }

  private buildDefaults(ctx: StandaloneContext): Required<NonNullable<StandaloneContext['config']['build']>> {
    return {
      configuration: ctx.config.build?.configuration ?? 'Development',
      targetType: ctx.config.build?.targetType ?? 'Editor',
      platform: ctx.config.build?.platform ?? 'Win64',
    };
  }

  private async runCommand(
    kind: string,
    ctx: StandaloneContext,
    executable: string,
    args: string[],
    operation: OperationContext,
  ): Promise<RunRecord> {
    const id = createRunId(kind);
    const started = Date.now();
    const diagnostics: ParsedDiagnostic[] = [];
    const result = await spawnAsync(executable, args, {
      cwd: ctx.projectRoot,
      onStdout: (line) => { const diagnostic = parseBuildLine(line); if (diagnostic) diagnostics.push(diagnostic); },
      onStderr: (line) => { const diagnostic = parseBuildLine(line); if (diagnostic) diagnostics.push(diagnostic); },
    });
    const finished = Date.now();
    const record: RunRecord = {
      schema: 'enginelink.run.v1', id, kind, taskId: operation.taskId, reason: operation.reason,
      startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(),
      success: result.exitCode === 0, exitCode: result.exitCode, durationMs: finished - started,
      project: ctx.project.uprojectPath, engine: ctx.engine.root,
      command: { executable, args: redactArgs(args) }, diagnostics,
    };
    await new RunStore(ctx.projectRoot).save(record, `${result.stdout}${result.stderr}`);
    return record;
  }

  private async saveBlockedRun(
    kind: string,
    ctx: StandaloneContext,
    executable: string,
    args: string[],
    operation: OperationContext,
    message: string,
    details: Record<string, unknown> = {},
  ): Promise<RunRecord> {
    const now = new Date().toISOString();
    const record: RunRecord = {
      schema: 'enginelink.run.v1', id: createRunId(kind), kind,
      taskId: operation.taskId, reason: operation.reason,
      startedAt: now, finishedAt: now, success: false, exitCode: 1, durationMs: 0,
      project: ctx.project.uprojectPath, engine: ctx.engine.root,
      command: { executable, args: redactArgs(args) },
      diagnostics: [], details: { blocked: true, message, ...details },
    };
    await new RunStore(ctx.projectRoot).save(record, message);
    return record;
  }

  private async findProjectEditor(uprojectPath: string): Promise<EditorProcessInfo | undefined> {
    return (await this.findProjectEditors(uprojectPath))[0];
  }

  private async findProjectEditors(uprojectPath: string): Promise<EditorProcessInfo[]> {
    if (process.platform !== 'win32') return [];
    const script = "Get-CimInstance Win32_Process -Filter \"Name='UnrealEditor.exe'\" | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress";
    const result = await spawnAsync('powershell.exe', ['-NoProfile', '-Command', script]).catch(() => undefined);
    if (!result || result.exitCode !== 0 || !result.stdout.trim()) return [];
    const parsed = parseJsonValue<Record<string, unknown> | Array<Record<string, unknown>>>(result.stdout, 'Win32_Process query');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const target = path.resolve(uprojectPath).toLowerCase();
    return rows
      .filter((row) => String(row.CommandLine ?? '').toLowerCase().includes(target))
      .sort((a, b) => String(b.CreationDate ?? '').localeCompare(String(a.CreationDate ?? '')))
      .map((match) => ({
        pid: Number(match.ProcessId), project: uprojectPath, commandLine: String(match.CommandLine ?? ''),
        startedAt: normalizeCimDate(match.CreationDate),
      }));
  }

  private async findLatestEvidence(ctx: StandaloneContext, configuredRoot?: string): Promise<string | undefined> {
    const root = path.resolve(ctx.projectRoot, configuredRoot ?? path.join('docs', 'evidence', 'acceptance'));
    const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
    const candidates: Array<{ file: string; time: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'summary.json');
      const stat = await fs.promises.stat(file).catch(() => undefined);
      if (stat) candidates.push({ file, time: stat.mtimeMs });
    }
    candidates.sort((a, b) => b.time - a.time);
    return candidates[0]?.file;
  }
}

function redactArgs(args: string[]): string[] {
  return args.map((arg, index) => {
    const previous = args[index - 1]?.toLowerCase() ?? '';
    if (/token|secret|password|api[-_]?key/.test(previous)) return '[REDACTED]';
    return arg.replace(/((?:token|secret|password|api[-_]?key)=)[^\s]+/gi, '$1[REDACTED]');
  });
}

function normalizeCimDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const dotNet = value.match(/^\/Date\((\d+)/);
  const parsed = dotNet ? Number(dotNet[1]) : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
