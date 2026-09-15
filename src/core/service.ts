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
import { toDoctorView } from '../doctor/view';
import type { DoctorStartOptions, DoctorView } from '../doctor/types';
import { parseJsonValue } from '../parsers/safeJson';
import { getRuntimeIdentity } from '../runtimeIdentity';
import { pickTargetForType } from '../parsers/targetParser';
import { placeCompileCommands } from '../cursor/placeCompileCommands';

export interface OperationContext {
  taskId?: string;
  reason?: string;
}

export interface BuildOptions extends OperationContext {
  configuration?: BuildConfiguration;
  targetType?: BuildTargetType;
  platform?: BuildPlatform;
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
      engineLink: await getRuntimeIdentity(),
      project: ctx.project,
      engine: ctx.engine,
      editor: await this.getEditorProcess(),
      buildTools: buildTools ?? null,
      defaults: this.buildDefaults(ctx),
      configPath: path.join(ctx.projectRoot, '.enginelink', 'project.json'),
      responsibilities: {
        engineLink: 'Host-side discovery, cold builds, editor process launch, compile database, and Project Doctor.',
        unrealMcp: 'Editor-side assets, PIE, Live Coding, transactions, and native Unreal MCP toolsets.',
      },
    };
  }

  async runProjectDoctor(options: DoctorStartOptions = {}): Promise<DoctorView> {
    return toDoctorView(await this.projectDoctor.run(options));
  }

  async build(options: BuildOptions = {}): Promise<RunRecord> {
    const ctx = await this.contextPromise;
    const defaults = this.buildDefaults(ctx);
    const command = buildCommandLine(ctx.engine, ctx.project, {
      configuration: options.configuration ?? defaults.configuration,
      targetType: options.targetType ?? defaults.targetType,
      platform: options.platform ?? defaults.platform,
      editorTargetName: defaults.editorTargetName,
    });
    const projectProcess = await this.findProjectEditor(ctx.project.uprojectPath);
    if (projectProcess) {
      const message = `Unreal Editor is running for this project (PID ${projectProcess.pid}). Use Unreal MCP LiveCodingToolset for compatible changes, or close the editor before a cold build.`;
      return this.saveBlockedRun('build', ctx, command.executable, command.args, options, message, { editorPid: projectProcess.pid });
    }
    return (await this.runCommand('build', ctx, command.executable, command.args, options)).record;
  }

  async clean(options: BuildOptions & { confirm?: boolean } = {}): Promise<RunRecord> {
    const ctx = await this.contextPromise;
    const defaults = this.buildDefaults(ctx);
    const command = cleanCommandLine(ctx.engine, ctx.project, {
      configuration: options.configuration ?? defaults.configuration,
      targetType: options.targetType ?? defaults.targetType,
      platform: options.platform ?? defaults.platform,
      editorTargetName: defaults.editorTargetName,
    });
    if (!options.confirm) {
      return this.saveBlockedRun(
        'clean', ctx, command.executable, command.args, options,
        'Clean removes build products. Re-run with confirm=true.',
      );
    }
    return (await this.runCommand('clean', ctx, command.executable, command.args, options)).record;
  }

  async generateCompileCommands(options: BuildOptions = {}): Promise<RunRecord> {
    const ctx = await this.contextPromise;
    const defaults = this.buildDefaults(ctx);
    const command = generateClangDatabaseCommandLine(ctx.engine, ctx.project, {
      configuration: options.configuration ?? defaults.configuration,
      platform: options.platform ?? defaults.platform,
      editorTargetName: defaults.editorTargetName,
    });
    const { record, rawOutput } = await this.runCommand('compile-commands', ctx, command.executable, command.args, options);
    if (!record.success) return record;
    const placed = await placeCompileCommands({
      projectRoot: ctx.projectRoot,
      engineRoot: ctx.engine.root,
      ubtOutput: rawOutput,
    });
    if (!placed.ok) {
      record.success = false;
      record.exitCode = record.exitCode || 1;
      record.details = {
        ...(record.details ?? {}),
        message: `UBT succeeded but EngineLink could not place compile_commands.json at ${placed.compileCommandsPath}.`,
      };
      await new RunStore(ctx.projectRoot).save(record);
      return record;
    }
    const postProcess = await postProcessCompileCommandsFile(ctx.projectRoot, ctx.engine.root);
    record.details = {
      ...(record.details ?? {}),
      postProcess: postProcess.stats,
      compileCommandsPath: placed.compileCommandsPath,
      placedFrom: placed.placedFrom,
    };
    await new RunStore(ctx.projectRoot).save(record);
    return record;
  }

  private async getEditorProcess(): Promise<{ running: boolean; process: EditorProcessInfo | null; processes: EditorProcessInfo[] }> {
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

  private buildDefaults(ctx: StandaloneContext) {
    const editorTargetName = ctx.config.build?.editorTargetName?.trim() || undefined;
    return {
      configuration: ctx.config.build?.configuration ?? 'Development' as const,
      targetType: ctx.config.build?.targetType ?? 'Editor' as const,
      platform: ctx.config.build?.platform ?? 'Win64' as const,
      editorTargetName,
      editorTarget: pickTargetForType(ctx.project, 'Editor', { editorTargetName }),
    };
  }

  private async runCommand(
    kind: string,
    ctx: StandaloneContext,
    executable: string,
    args: string[],
    operation: OperationContext,
  ): Promise<{ record: RunRecord; rawOutput: string }> {
    const id = createRunId(kind);
    const started = Date.now();
    const diagnostics: ParsedDiagnostic[] = [];
    const result = await spawnAsync(executable, args, {
      cwd: ctx.projectRoot,
      onStdout: (line) => { const diagnostic = parseBuildLine(line); if (diagnostic) diagnostics.push(diagnostic); },
      onStderr: (line) => { const diagnostic = parseBuildLine(line); if (diagnostic) diagnostics.push(diagnostic); },
    });
    const finished = Date.now();
    const rawOutput = `${result.stdout}${result.stderr}`;
    const record: RunRecord = {
      schema: 'enginelink.run.v1', id, kind, taskId: operation.taskId, reason: operation.reason,
      startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(),
      success: result.exitCode === 0, exitCode: result.exitCode, durationMs: finished - started,
      project: ctx.project.uprojectPath, engine: ctx.engine.root,
      command: { executable, args: redactArgs(args) }, diagnostics,
    };
    await new RunStore(ctx.projectRoot).save(record, rawOutput);
    return { record, rawOutput };
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
