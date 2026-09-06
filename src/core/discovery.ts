import * as fs from 'fs';
import * as path from 'path';
import { parseUProject } from '../parsers/uprojectParser';
import { discoverProjectTargets } from '../parsers/targetParser';
import { resolveEditorPath, resolveUBTPath } from '../platform/paths';
import { readRegistryKeyValues, readRegistryValue } from '../platform/registry';
import { Registry } from '../constants';
import type { UEInstallation, UEProject } from '../types';
import { exists, findProjectRoot, loadProjectConfig, type EngineLinkProjectConfig } from './config';

export interface StandaloneContext {
  projectRoot: string;
  config: EngineLinkProjectConfig;
  project: UEProject;
  engine: UEInstallation;
}

export async function resolveStandaloneContext(startPath: string): Promise<StandaloneContext> {
  const projectRoot = await findProjectRoot(startPath);
  const config = await loadProjectConfig(projectRoot);
  const uprojectPath = path.resolve(projectRoot, config.uproject);
  if (!(await exists(uprojectPath))) throw new Error(`Missing project file: ${uprojectPath}`);
  const data = await parseUProject(uprojectPath);
  const project: UEProject = {
    name: path.basename(uprojectPath, '.uproject'),
    uprojectPath,
    projectRoot,
    engineAssociation: data.engineAssociation,
    modules: data.modules,
    targets: await discoverProjectTargets(projectRoot),
  };
  const engine = await resolveEngine(config.engineRoot, data.engineAssociation);
  return { projectRoot, config, project, engine };
}

async function resolveEngine(configuredRoot: string | undefined, association: string): Promise<UEInstallation> {
  const registryRoot = await resolveAssociationFromRegistry(association);
  const candidates = [
    configuredRoot,
    process.env.ENGINELINK_ENGINE_ROOT,
    registryRoot,
    association ? `D:\\Software\\UE_${association}` : undefined,
    association ? `C:\\Program Files\\Epic Games\\UE_${association}` : undefined,
    association ? `D:\\Program Files\\Epic Games\\UE_${association}` : undefined,
  ].filter((value): value is string => !!value);

  for (const root of candidates) {
    const normalized = path.resolve(root);
    const ubtPath = resolveUBTPath(normalized);
    if (await exists(ubtPath)) {
      return {
        version: association || path.basename(normalized).replace(/^UE_/, ''),
        root: normalized,
        source: configuredRoot === root ? 'manual' : 'uproject-association',
        ubtPath,
        editorPath: resolveEditorPath(normalized),
        isSourceBuild: await exists(path.join(normalized, 'Engine', 'Source', 'Programs', 'UnrealBuildTool')),
      };
    }
  }

  throw new Error(`Unable to resolve UE ${association || '(unassociated)'}. Set engineRoot in .enginelink/project.json or ENGINELINK_ENGINE_ROOT.`);
}

async function resolveAssociationFromRegistry(association: string): Promise<string | undefined> {
  if (process.platform !== 'win32' || !association) return undefined;
  if (association.startsWith('{') && association.endsWith('}')) {
    const builds = await readRegistryKeyValues(Registry.SourceBuilds);
    for (const [key, value] of builds) {
      if (key.toLowerCase() === association.toLowerCase()) return value;
    }
    return undefined;
  }
  return readRegistryValue(`${Registry.LauncherInstalls}\\${association}`, 'InstalledDirectory');
}

export async function listProjectPlugins(projectRoot: string): Promise<Array<{ name: string; nestedGit: boolean }>> {
  const pluginsRoot = path.join(projectRoot, 'Plugins');
  const entries = await fs.promises.readdir(pluginsRoot, { withFileTypes: true }).catch(() => []);
  const result: Array<{ name: string; nestedGit: boolean }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    result.push({ name: entry.name, nestedGit: await exists(path.join(pluginsRoot, entry.name, '.git')) });
  }
  return result;
}
