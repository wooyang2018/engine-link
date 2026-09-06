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
import { listProjectPlugins, resolveStandaloneContext, type StandaloneContext } from './discovery';
import { createRunId, RunStore, type RunRecord } from './runStore';

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
}

export class EngineLinkService {
  private readonly contextPromise: Promise<StandaloneContext>;

  constructor(startPath = process.cwd()) {
    this.contextPromise = resolveStandaloneContext(startPath);
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

  async doctor(): Promise<Record<string, unknown>> {
    const ctx = await this.contextPromise;
    const buildTools = await detectBuildTools();
    const plugins = await listProjectPlugins(ctx.projectRoot);
    const gitmodules = await exists(path.join(ctx.projectRoot, '.gitmodules'));
    const clang = await this.detectClang(buildTools?.installationPath);
    const warnings: string[] = [];
    if (!buildTools) warnings.push('Visual Studio C++ Build Tools were not detected.');
    else if (!buildTools.hasWindowsSDK) warnings.push('Visual Studio was found, but the expected Windows SDK component was not detected.');
    if (!clang) warnings.push('clang-cl was not found; compile_commands.json can be generated but IntelliSense may be incomplete.');
    if (!gitmodules && plugins.some((plugin) => plugin.nestedGit)) {
      warnings.push('One or more Plugins directories contain nested Git repositories but the project has no .gitmodules; plugin revisions are not pinned by the parent repository.');
    }
    if (!(await exists(path.join(ctx.projectRoot, '.gitattributes')))) {
      warnings.push('No .gitattributes file is present; large binary Unreal assets have no repository-level LFS or locking policy.');
    }
    return {
      healthy: warnings.length === 0,
      projectFile: ctx.project.uprojectPath,
      engineRoot: ctx.engine.root,
      ubt: { path: ctx.engine.ubtPath, exists: await exists(ctx.engine.ubtPath) },
      editor: { path: ctx.engine.editorPath, exists: await exists(ctx.engine.editorPath) },
      buildTools: buildTools ?? null,
      clang,
      plugins,
      warnings,
    };
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

  async getEditorProcess(): Promise<{ running: boolean; process: EditorProcessInfo | null }> {
    const ctx = await this.contextPromise;
    const processInfo = await this.findProjectEditor(ctx.project.uprojectPath);
    return { running: !!processInfo, process: processInfo ?? null };
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
    if (process.platform !== 'win32') return undefined;
    const script = "Get-CimInstance Win32_Process -Filter \"Name='UnrealEditor.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const result = await spawnAsync('powershell.exe', ['-NoProfile', '-Command', script]).catch(() => undefined);
    if (!result || result.exitCode !== 0 || !result.stdout.trim()) return undefined;
    const parsed = JSON.parse(result.stdout) as Record<string, unknown> | Array<Record<string, unknown>>;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const target = path.resolve(uprojectPath).toLowerCase();
    const match = rows.find((row) => String(row.CommandLine ?? '').toLowerCase().includes(target));
    if (!match) return undefined;
    return { pid: Number(match.ProcessId), project: uprojectPath, commandLine: String(match.CommandLine ?? '') };
  }

  private async detectClang(buildToolsRoot?: string): Promise<boolean> {
    const lookup: [string, string[]] = process.platform === 'win32'
      ? ['where.exe', ['clang-cl.exe']]
      : ['which', ['clang++']];
    if ((await spawnAsync(lookup[0], lookup[1]).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))).exitCode === 0) {
      return true;
    }
    if (!buildToolsRoot) return false;
    return exists(path.join(buildToolsRoot, 'VC', 'Tools', 'Llvm', 'x64', 'bin', 'clang-cl.exe'));
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
