import * as vscode from 'vscode';
import * as path from 'path';
import { generateClangDatabaseCommandLine, formatCommandLine } from '../build/ubt';
import { spawnAsync } from '../platform/process';
import { fileExists } from '../platform/paths';
import {
  isCompileCommandsStale,
  loadCompileCommands,
  postProcessCompileCommandsFile,
  type PostProcessResult,
} from '../cursor/compileCommandsPostProcess';
import { placeCompileCommands } from '../cursor/placeCompileCommands';
import type { EngineLinkContext } from '../types';
import type { EngineLinkSettings } from '../config/settings';

/**
 * Generate compile_commands.json via UBT and place it at the project root.
 */
export async function generateCompileCommands(
  ctx: EngineLinkContext,
  settings: EngineLinkSettings,
) {
  if (!ctx.project || !ctx.engine) {
    vscode.window.showErrorMessage('EngineLink: No project or engine detected.');
    return;
  }

  const project = ctx.project;
  const engine = ctx.engine;
  const cmd = generateClangDatabaseCommandLine(engine, project, {
    configuration: settings.buildConfiguration,
    platform: settings.platform,
    editorTargetName: ctx.editorTargetName,
  });

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'EngineLink: Generating compile_commands.json...',
      cancellable: true,
    },
    async (_progress, token) => {
      ctx.outputChannel.show(true);
      ctx.outputChannel.appendLine(`[EngineLink] ${formatCommandLine(cmd)}`);

      const ubtOutput: string[] = [];
      const capture = (line: string) => {
        ubtOutput.push(line);
        ctx.outputChannel.appendLine(line);
      };

      const result = await spawnAsync(cmd.executable, cmd.args, {
        onStdout: capture,
        onStderr: capture,
        token,
      });

      if (result.exitCode !== 0) {
        vscode.window
          .showErrorMessage('EngineLink: Failed to generate compile_commands.json.', 'Show Output')
          .then((choice) => {
            if (choice === 'Show Output') ctx.outputChannel.show();
          });
        return;
      }

      const placed = await placeCompileCommands({
        projectRoot: project.projectRoot,
        engineRoot: engine.root,
        ubtOutput: ubtOutput.join('\n'),
        onLog: (line) => ctx.outputChannel.appendLine(line),
      });

      if (!placed.ok) {
        vscode.window.showWarningMessage(
          'EngineLink: compile_commands.json generated but could not be located. Check UBT output.',
        );
        return;
      }

      const postProcess = await runCompileCommandsPostProcess(ctx);
      await restartClangdIfAvailable(ctx);
      if (postProcess.stats.broken > 0) {
        vscode.window.showWarningMessage(
          `EngineLink: compile_commands.json post-processed with ${postProcess.stats.broken} broken entr${postProcess.stats.broken === 1 ? 'y' : 'ies'}.`,
        );
      } else {
        vscode.window.showInformationMessage(
          'EngineLink: compile_commands.json generated successfully.',
        );
      }
    },
  );
}

/**
 * Ask the vscode-clangd extension to restart so it picks up a rewritten
 * compile_commands.json. A running server caches the database and keeps
 * publishing stale diagnostics until restarted. No-op when clangd is absent.
 */
export async function restartClangdIfAvailable(ctx: EngineLinkContext): Promise<void> {
  try {
    await vscode.commands.executeCommand('clangd.restart');
    ctx.outputChannel.appendLine('[EngineLink] Restarted clangd to reload compile_commands.json.');
  } catch {
    ctx.outputChannel.appendLine('[EngineLink] clangd.restart not available; reload the window to refresh IntelliSense.');
  }
}

/**
 * Post-process compile_commands.json in place and log stats.
 */
export async function runCompileCommandsPostProcess(
  ctx: EngineLinkContext,
): Promise<PostProcessResult> {
  if (!ctx.project) {
    throw new Error('No project detected');
  }

  const projectRoot = ctx.project.projectRoot;
  const engineRoot = ctx.engine?.root;
  const result = await postProcessCompileCommandsFile(projectRoot, engineRoot);
  ctx.outputChannel.appendLine(
    `[EngineLink] compile_commands post-process: total=${result.stats.total}, flattened=${result.stats.flattened}, remapped=${result.stats.remapped}, headerAliases=${result.stats.headerAliases}, engineHeaderEntries=${result.stats.engineHeaderEntries}, broken=${result.stats.broken}`,
  );

  if (engineRoot && result.templateFlags.length > 0) {
    const { ensureClangdConfig, ensureIdeOverridesHeader } = await import('../cursor/clangdConfig');
    const ideOverridesHeader = ctx.globalStoragePath
      ? await ensureIdeOverridesHeader(ctx.globalStoragePath)
      : undefined;
    const changed = await ensureClangdConfig(projectRoot, {
      engineRoot,
      templateFlags: result.templateFlags,
      projectRoot,
      projectForcedIncludes: result.projectForcedIncludes,
      ideOverridesHeader,
    });
    if (changed) {
      ctx.outputChannel.appendLine('[EngineLink] .clangd updated with engine-source IntelliSense fallback.');
    }
  }

  return result;
}

/**
 * Ensure compile_commands.json exists and is usable for clangd.
 * Post-processes stale databases; optionally regenerates when still broken.
 */
export async function ensureCompileCommandsIntellisense(
  ctx: EngineLinkContext,
  settings: EngineLinkSettings,
  options: { allowRegenerate?: boolean } = {},
): Promise<void> {
  if (!ctx.project || !ctx.engine) return;

  const projectRoot = ctx.project.projectRoot;
  const compileDbPath = path.join(projectRoot, 'compile_commands.json');

  if (!(await fileExists(compileDbPath))) {
    if (options.allowRegenerate && settings.autoGenerateCompileCommands) {
      ctx.outputChannel.appendLine('[EngineLink] Auto-generating compile_commands.json...');
      await generateCompileCommands(ctx, settings);
    }
    return;
  }

  const stale = await isCompileCommandsStale(projectRoot);
  const needsEngineHeaders = await needsEngineHeaderPostProcess(projectRoot, ctx.engine.root);

  if (!stale && !needsEngineHeaders) {
    ctx.outputChannel.appendLine('[EngineLink] compile_commands.json looks current.');
    return;
  }

  if (stale) {
    ctx.outputChannel.appendLine(
      '[EngineLink] compile_commands.json appears stale (missing .rsp files). Post-processing...',
    );
  } else {
    ctx.outputChannel.appendLine(
      '[EngineLink] compile_commands.json missing engine header entries. Post-processing...',
    );
  }
  const postProcess = await runCompileCommandsPostProcess(ctx);
  await restartClangdIfAvailable(ctx);

  if (postProcess.stats.broken > 0 && options.allowRegenerate && settings.autoGenerateCompileCommands) {
    ctx.outputChannel.appendLine(
      '[EngineLink] compile_commands.json still has broken entries after post-process; regenerating...',
    );
    await generateCompileCommands(ctx, settings);
    return;
  }

  if (postProcess.stats.broken > 0) {
    ctx.outputChannel.appendLine(
      `[EngineLink] compile_commands.json still has ${postProcess.stats.broken} broken entr${postProcess.stats.broken === 1 ? 'y' : 'ies'}; run "Generate compile_commands.json".`,
    );
  }
}

async function needsEngineHeaderPostProcess(projectRoot: string, engineRoot: string): Promise<boolean> {
  try {
    const entries = await loadCompileCommands(projectRoot);
    const enginePrefix = path
      .join(engineRoot, 'Engine', 'Source')
      .replace(/\\/g, '/')
      .toLowerCase();
    return !entries.some((entry) => entry.file.replace(/\\/g, '/').toLowerCase().startsWith(enginePrefix));
  } catch {
    return true;
  }
}

