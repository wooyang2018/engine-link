import * as fs from 'fs';
import * as path from 'path';
import type { BuildConfiguration, BuildPlatform, BuildTargetType } from '../types';
import { parseJsonValue } from '../parsers/safeJson';

export interface UnrealMcpConfig {
  /** Local Streamable HTTP endpoint exposed by Unreal Editor. */
  url?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface EngineLinkProjectConfig {
  schemaVersion: 1;
  uproject: string;
  engineRoot?: string;
  build?: {
    configuration?: BuildConfiguration;
    targetType?: BuildTargetType;
    platform?: BuildPlatform;
    /** Explicit UBT Editor target (e.g. LyraEditor). Used for Editor builds and compile_commands. */
    editorTargetName?: string;
  };
  editor?: { map?: string; args?: string[] };
  unrealMcp?: UnrealMcpConfig;
  agentGuide?: string;
}

export const CONFIG_RELATIVE_PATH = path.join('.enginelink', 'project.json');

export async function findProjectRoot(startPath: string): Promise<string> {
  let current = path.resolve(startPath);
  const stat = await fs.promises.stat(current).catch(() => undefined);
  if (stat?.isFile()) current = path.dirname(current);

  for (;;) {
    if (await exists(path.join(current, CONFIG_RELATIVE_PATH))) return current;
    const entries = await fs.promises.readdir(current).catch(() => [] as string[]);
    if (entries.some((entry) => entry.toLowerCase().endsWith('.uproject'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`No Unreal project or ${CONFIG_RELATIVE_PATH} found from ${startPath}`);
}

export async function loadProjectConfig(projectRoot: string): Promise<EngineLinkProjectConfig> {
  const configPath = path.join(projectRoot, CONFIG_RELATIVE_PATH);
  if (!(await exists(configPath))) {
    const entries = await fs.promises.readdir(projectRoot);
    const uprojects = entries.filter((entry) => entry.toLowerCase().endsWith('.uproject'));
    if (uprojects.length !== 1) {
      throw new Error(`Expected one .uproject in ${projectRoot}; add ${CONFIG_RELATIVE_PATH}`);
    }
    return { schemaVersion: 1, uproject: uprojects[0] };
  }

  const parsed = parseJsonValue<EngineLinkProjectConfig>(await fs.promises.readFile(configPath), configPath);
  if (parsed.schemaVersion !== 1) throw new Error(`Unsupported EngineLink schemaVersion: ${parsed.schemaVersion}`);
  if (!parsed.uproject || path.isAbsolute(parsed.uproject)) {
    throw new Error('project.json uproject must be a project-relative path');
  }
  return parsed;
}

export async function exists(target: string): Promise<boolean> {
  return fs.promises.access(target).then(() => true, () => false);
}
