import * as path from 'path';
import { parseUProject } from '../parsers/uprojectParser';
import { discoverProjectTargets } from '../parsers/targetParser';
import { resolveEditorPath, resolveUBTPath } from '../platform/paths';
import { readRegistryKeyValues, readRegistryValue } from '../platform/registry';
import { Registry } from '../constants';
import type { UEInstallation, UEProject } from '../types';
import { exists, findProjectRoot, findUniqueUProject } from './config';

export interface StandaloneContext {
  projectRoot: string;
  project: UEProject;
  engine: UEInstallation;
}

export async function resolveStandaloneContext(startPath: string): Promise<StandaloneContext> {
  const projectRoot = await findProjectRoot(startPath);
  const uproject = await findUniqueUProject(projectRoot);
  const uprojectPath = path.resolve(projectRoot, uproject);
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
  const engine = await resolveEngine(data.engineAssociation);
  return { projectRoot, project, engine };
}

async function resolveEngine(association: string): Promise<UEInstallation> {
  const registryRoot = await resolveAssociationFromRegistry(association);
  const envRoot = process.env.ENGINELINK_ENGINE_ROOT;
  const candidates = [
    envRoot,
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
        source: envRoot && path.resolve(envRoot) === normalized ? 'manual' : 'uproject-association',
        ubtPath,
        editorPath: resolveEditorPath(normalized),
        isSourceBuild: await exists(path.join(normalized, 'Engine', 'Source', 'Programs', 'UnrealBuildTool')),
      };
    }
  }

  throw new Error(
    `Unable to resolve UE ${association || '(unassociated)'}. Set ENGINELINK_ENGINE_ROOT or enginelink.engineRoot.`,
  );
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
