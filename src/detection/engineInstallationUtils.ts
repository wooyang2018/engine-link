import * as path from 'path';
import { resolveUBTPath } from '../platform/paths';

/**
 * Parse a UE version label from an engine root path (e.g. D:\Software\UE_5.8 → 5.8).
 */
export function parseVersionFromEngineRoot(engineRoot: string): string {
  const baseName = path.basename(engineRoot);
  const match = baseName.match(/^UE_(.+)$/i);
  return match ? match[1] : 'manual';
}

/**
 * Describe why a configured enginelink.engineRoot path failed validation.
 */
export function formatManualInstallationFailure(engineRoot: string): string {
  const ubtPath = resolveUBTPath(engineRoot);
  return `Configured enginelink.engineRoot is invalid. UBT not found at: ${ubtPath}`;
}
