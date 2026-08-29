import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { generateClangDatabaseCommandLine, formatCommandLine } from '../build/ubt';
import { spawnAsync } from '../platform/process';
import { fileExists } from '../platform/paths';
import {
  isCompileCommandsStale,
  loadCompileCommands,
  postProcessCompileCommandsFile,
  type PostProcessResult,
} from '../cursor/compileCommandsPostProcess';
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

  const cmd = generateClangDatabaseCommandLine(ctx.engine, ctx.project, {
    configuration: settings.buildConfiguration,
    platform: settings.platform,
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

      const ubtWrittenPath = extractClangDatabasePath(ubtOutput.join('\n'));

      // Find and copy compile_commands.json to project root (UBT often writes under engine root)
      const placed = await findAndPlaceCompileCommands(ctx, ubtWrittenPath);

      if (!placed) {
        vscode.window.showWarningMessage(
          'EngineLink: compile_commands.json generated but could not be located. Check UBT output.',
        );
        return;
      }

      const postProcess = await runCompileCommandsPostProcess(ctx);
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
    const { ensureClangdConfig } = await import('../cursor/clangdConfig');
    const changed = await ensureClangdConfig(projectRoot, {
      engineRoot,
      templateFlags: result.templateFlags,
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

/**
 * Parse UBT log line: "ClangDatabase written to C:\...\compile_commands.json"
 */
function extractClangDatabasePath(ubtOutput: string): string | undefined {
  const m = ubtOutput.match(/ClangDatabase written to\s+(.+?)(?:\r?\n|$)/im);
  if (!m) return undefined;
  return m[1].trim().replace(/[/\\]+$/, '');
}

/**
 * Search for the generated compile_commands.json and copy to project root.
 * UBT 5.x often writes next to the engine (e.g. UE_5.7\compile_commands.json), not inside the .uproject folder.
 */
async function findAndPlaceCompileCommands(
  ctx: EngineLinkContext,
  ubtReportedPath?: string,
): Promise<boolean> {
  if (!ctx.project || !ctx.engine) return false;

  const projectRoot = ctx.project.projectRoot;
  const targetPath = path.join(projectRoot, 'compile_commands.json');

  const tryCopyFrom = async (sourcePath: string, label: string): Promise<boolean> => {
    if (!(await fileExists(sourcePath))) return false;
    const normalized = path.normalize(sourcePath);
    if (normalized === path.normalize(targetPath)) {
      ctx.outputChannel.appendLine(`[EngineLink] compile_commands.json at project root (${label}).`);
      return true;
    }
    ctx.outputChannel.appendLine(`[EngineLink] Found compile_commands.json (${label}): ${normalized}`);
    ctx.outputChannel.appendLine(`[EngineLink] Copying to project root: ${targetPath}`);
    await fs.promises.copyFile(normalized, targetPath);
    return true;
  };

  // 0) Already at project root (OutputDir or prior copy)
  if (await fileExists(targetPath)) {
    ctx.outputChannel.appendLine('[EngineLink] compile_commands.json at project root.');
    return true;
  }

  // 1) Path printed by UBT (most reliable across UE versions)
  if (ubtReportedPath && (await tryCopyFrom(ubtReportedPath, 'UBT output'))) {
    return true;
  }

  // 2) Engine root (common on UE 5.5+)
  const engineRootDb = path.join(ctx.engine.root, 'compile_commands.json');
  if (await tryCopyFrom(engineRootDb, 'engine root')) {
    return true;
  }

  // 3) Under Intermediate/Build
  const searchPaths = [
    path.join(projectRoot, 'Intermediate', 'Build'),
    path.join(ctx.engine.root, 'Intermediate', 'Build'),
  ];

  for (const searchBase of searchPaths) {
    const found = await findFileRecursive(searchBase, 'compile_commands.json', 6);
    if (found && (await tryCopyFrom(found, 'Intermediate/Build search'))) {
      return true;
    }
  }

  return false;
}

/**
 * Recursively search for a file up to a given depth.
 */
async function findFileRecursive(
  dir: string,
  filename: string,
  maxDepth: number,
): Promise<string | undefined> {
  if (maxDepth <= 0) return undefined;

  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === filename) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        const found = await findFileRecursive(fullPath, filename, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch {
    // Directory not readable
  }

  return undefined;
}
