import * as fs from 'fs';
import * as path from 'path';
import { fileExists } from '../platform/paths';

export interface PlaceCompileCommandsOptions {
  projectRoot: string;
  engineRoot: string;
  ubtOutput?: string;
  ubtReportedPath?: string;
  onLog?: (line: string) => void;
}

export interface PlaceCompileCommandsResult {
  ok: boolean;
  compileCommandsPath: string;
  placedFrom?: string;
  sourcePath?: string;
}

/**
 * Parse UBT log line: "ClangDatabase written to C:\...\compile_commands.json"
 */
export function extractClangDatabasePath(ubtOutput: string): string | undefined {
  const match = ubtOutput.match(/ClangDatabase written to\s+(.+?)(?:\r?\n|$)/im);
  if (!match) return undefined;
  return match[1].trim().replace(/[/\\]+$/, '');
}

/**
 * Copy this UBT run's compile_commands.json to the project root.
 * UBT 5.x often writes next to the engine, not inside the .uproject folder.
 */
export async function placeCompileCommands(
  options: PlaceCompileCommandsOptions,
): Promise<PlaceCompileCommandsResult> {
  const targetPath = path.join(options.projectRoot, 'compile_commands.json');
  const log = options.onLog ?? (() => undefined);
  const reported = options.ubtReportedPath ?? extractClangDatabasePath(options.ubtOutput ?? '');

  const tryCopyFrom = async (sourcePath: string, label: string): Promise<PlaceCompileCommandsResult | undefined> => {
    if (!(await fileExists(sourcePath))) return undefined;
    const normalized = path.normalize(sourcePath);
    if (normalized === path.normalize(targetPath)) {
      log(`[EngineLink] compile_commands.json at project root (${label}).`);
      return { ok: true, compileCommandsPath: targetPath, placedFrom: label, sourcePath: normalized };
    }
    log(`[EngineLink] Found compile_commands.json (${label}): ${normalized}`);
    log(`[EngineLink] Copying to project root: ${targetPath}`);
    await fs.promises.copyFile(normalized, targetPath);
    return { ok: true, compileCommandsPath: targetPath, placedFrom: label, sourcePath: normalized };
  };

  if (reported) {
    const fromLog = await tryCopyFrom(reported, 'UBT output');
    if (fromLog) return fromLog;
  }

  const fromEngine = await tryCopyFrom(path.join(options.engineRoot, 'compile_commands.json'), 'engine root');
  if (fromEngine) return fromEngine;

  for (const searchBase of [
    path.join(options.projectRoot, 'Intermediate', 'Build'),
    path.join(options.engineRoot, 'Intermediate', 'Build'),
  ]) {
    const found = await findFileRecursive(searchBase, 'compile_commands.json', 6);
    if (!found) continue;
    const fromSearch = await tryCopyFrom(found, 'Intermediate/Build search');
    if (fromSearch) return fromSearch;
  }

  log('[EngineLink] No compile_commands.json produced by this generation was found; refusing to use an existing project-root file.');
  return { ok: false, compileCommandsPath: targetPath };
}

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
      if (entry.isFile() && entry.name === filename) return fullPath;
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
