import * as path from 'path';
import * as fs from 'fs';

/**
 * Check if a file exists at the given path.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the UBT executable path from an engine root.
 */
export function resolveUBTPath(engineRoot: string): string {
  return path.join(
    engineRoot,
    'Engine',
    'Binaries',
    'DotNET',
    'UnrealBuildTool',
    'UnrealBuildTool.exe',
  );
}

/**
 * Resolve the Unreal Editor executable path from an engine root.
 */
export function resolveEditorPath(engineRoot: string): string {
  return path.join(engineRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe');
}

/**
 * Normalize a Windows path (backslashes → forward slashes not needed, just normalize).
 */
export function normalizePath(p: string): string {
  return path.normalize(p);
}
