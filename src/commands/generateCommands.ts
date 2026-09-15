import * as vscode from 'vscode';
import * as path from 'path';
import { fileExists } from '../platform/paths';
import {
  isCompileCommandsStale,
  loadCompileCommands,
  postProcessCompileCommandsFile,
  type PostProcessResult,
  type ProjectForcedIncludes,
} from '../cursor/compileCommandsPostProcess';
import type { EngineLinkContext } from '../types';
import type { EngineLinkSettings } from '../config/settings';
import { EngineLinkService } from '../core/service';

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

export interface ClangdCompileDbSync {
  templateFlags?: string[];
  projectForcedIncludes?: ProjectForcedIncludes;
}

/**
 * Update `.clangd` from an already-generated compile database, then restart clangd.
 * Does not spawn UBT. Prefer `templateFlags` captured before forced-include injection.
 */
export async function syncClangdFromCompileDb(
  ctx: EngineLinkContext,
  options: ClangdCompileDbSync = {},
): Promise<void> {
  if (!ctx.project || !ctx.engine) return;
  const engineRoot = ctx.engine.root;
  const templateFlags = options.templateFlags ?? [];
  if (templateFlags.length === 0) {
    ctx.outputChannel.appendLine('[EngineLink] Skipping .clangd engine fallback; no template flags.');
    await restartClangdIfAvailable(ctx);
    return;
  }

  const { ensureClangdConfig, ensureIdeOverridesHeader } = await import('../cursor/clangdConfig');
  const ideOverridesHeader = ctx.globalStoragePath
    ? await ensureIdeOverridesHeader(ctx.globalStoragePath)
    : undefined;
  const changed = await ensureClangdConfig(ctx.project.projectRoot, {
    engineRoot,
    templateFlags,
    projectRoot: ctx.project.projectRoot,
    projectForcedIncludes: options.projectForcedIncludes,
    ideOverridesHeader,
  });
  if (changed) {
    ctx.outputChannel.appendLine('[EngineLink] .clangd updated with engine-source IntelliSense fallback.');
  }
  await restartClangdIfAvailable(ctx);
}

function clangdSyncFromDetails(details?: Record<string, unknown>): ClangdCompileDbSync {
  const templateFlags = details?.templateFlags;
  const projectForcedIncludes = details?.projectForcedIncludes;
  return {
    templateFlags: Array.isArray(templateFlags) ? templateFlags.filter((flag): flag is string => typeof flag === 'string') : undefined,
    projectForcedIncludes:
      projectForcedIncludes && typeof projectForcedIncludes === 'object'
        ? projectForcedIncludes as ProjectForcedIncludes
        : undefined,
  };
}

/**
 * Post-process compile_commands.json in place, update `.clangd`, and log stats.
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
  return result;
}

async function generateCompileCommandsViaService(
  ctx: EngineLinkContext,
  settings: EngineLinkSettings,
): Promise<boolean> {
  if (!ctx.project) return false;
  const record = await new EngineLinkService(ctx.project.projectRoot).generateCompileCommands({
    configuration: settings.buildConfiguration,
    platform: settings.platform,
    reason: 'Cursor auto-generate compile_commands',
  });
  ctx.outputChannel.appendLine(
    `[EngineLink] Generate compile_commands.json ${record.success ? 'succeeded' : 'failed'} in ${(record.durationMs / 1000).toFixed(1)}s.`,
  );
  if (!record.success) {
    vscode.window.showErrorMessage(
      `EngineLink: Failed to generate compile_commands.json${record.details?.message ? `: ${String(record.details.message)}` : '.'}`,
    );
    return false;
  }
  await syncClangdFromCompileDb(ctx, clangdSyncFromDetails(record.details));
  return true;
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
      await generateCompileCommandsViaService(ctx, settings);
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
  await syncClangdFromCompileDb(ctx, {
    templateFlags: postProcess.templateFlags,
    projectForcedIncludes: postProcess.projectForcedIncludes,
  });

  if (postProcess.stats.broken > 0 && options.allowRegenerate && settings.autoGenerateCompileCommands) {
    ctx.outputChannel.appendLine(
      '[EngineLink] compile_commands.json still has broken entries after post-process; regenerating...',
    );
    await generateCompileCommandsViaService(ctx, settings);
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

export function clangdSyncFromRunDetails(details?: Record<string, unknown>): ClangdCompileDbSync {
  return clangdSyncFromDetails(details);
}
