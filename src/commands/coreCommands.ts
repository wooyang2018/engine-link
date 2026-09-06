import * as vscode from 'vscode';
import { EngineLinkService } from '../core/service';
import type { RunRecord } from '../core/runStore';
import type { EngineLinkContext, ParsedDiagnostic } from '../types';
import type { EngineLinkSettings } from '../config/settings';

/** VS Code presentation adapter over the same core used by CLI and MCP. */
export async function executeCoreBuild(ctx: EngineLinkContext, settings: EngineLinkSettings): Promise<void> {
  await runWithProgress(ctx, 'Cold build', async (service) => service.build({
    configuration: settings.buildConfiguration,
    targetType: settings.buildTarget,
    platform: settings.platform,
    reason: 'VS Code Build command',
  }));
}

export async function executeCoreClean(ctx: EngineLinkContext, settings: EngineLinkSettings): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'EngineLink clean removes Unreal build products. Continue?',
    { modal: true },
    'Clean',
  );
  if (choice !== 'Clean') return;
  await runWithProgress(ctx, 'Clean', async (service) => service.clean({
    configuration: settings.buildConfiguration,
    targetType: settings.buildTarget,
    platform: settings.platform,
    confirm: true,
    reason: 'VS Code Clean command',
  }));
}

export async function executeCoreCompileCommands(ctx: EngineLinkContext, settings: EngineLinkSettings): Promise<void> {
  await runWithProgress(ctx, 'Generate compile_commands.json', async (service) => service.generateCompileCommands({
    configuration: settings.buildConfiguration,
    platform: settings.platform,
    reason: 'VS Code Generate compile_commands command',
  }));
}

export async function executeCoreLaunch(ctx: EngineLinkContext): Promise<void> {
  if (!ctx.project) return showError('No Unreal project is selected.');
  try {
    const result = await new EngineLinkService(ctx.project.projectRoot).launchEditor({ reason: 'VS Code Launch command' });
    const message = result.existing ? `Editor is already running (PID ${result.process && typeof result.process === 'object' ? (result.process as { pid?: number }).pid : 'unknown'}).` : `Editor launched (PID ${result.pid ?? 'pending'}).`;
    vscode.window.showInformationMessage(`EngineLink: ${message}`);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

async function runWithProgress(
  ctx: EngineLinkContext,
  title: string,
  operation: (service: EngineLinkService) => Promise<RunRecord>,
): Promise<void> {
  if (!ctx.project) return showError('No Unreal project is selected.');
  try {
    const record = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `EngineLink: ${title}`, cancellable: false },
      () => operation(new EngineLinkService(ctx.project!.projectRoot)),
    );
    applyRun(ctx, record);
    const message = `${title} ${record.success ? 'succeeded' : 'failed'} in ${(record.durationMs / 1000).toFixed(1)}s. Run: ${record.id}`;
    ctx.outputChannel.appendLine(`[EngineLink] ${message}`);
    record.success ? vscode.window.showInformationMessage(`EngineLink: ${message}`) : showError(message);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

function applyRun(ctx: EngineLinkContext, record: RunRecord): void {
  const diagnostics = (record.diagnostics ?? []) as ParsedDiagnostic[];
  ctx.lastBuildErrors = diagnostics;
  ctx.lastBuildResult = {
    success: record.success,
    duration: record.durationMs,
    errors: diagnostics.filter((item) => item.severity === 'error').length,
    warnings: diagnostics.filter((item) => item.severity === 'warning').length,
  };
  ctx.diagnosticCollection.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const item of diagnostics) {
    if (!item.file || item.line <= 0) continue;
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(Math.max(0, item.line - 1), Math.max(0, item.column - 1), Math.max(0, item.line - 1), Math.max(0, item.column)),
      `${item.code}: ${item.message}`,
      item.severity === 'error' ? vscode.DiagnosticSeverity.Error : item.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
    );
    const list = byFile.get(item.file) ?? [];
    list.push(diagnostic);
    byFile.set(item.file, list);
  }
  ctx.diagnosticCollection.set([...byFile].map(([file, entries]) => [vscode.Uri.file(file), entries]));
}

function showError(message: string): void {
  vscode.window.showErrorMessage(`EngineLink: ${message}`);
}
