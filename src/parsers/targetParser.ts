import * as fs from 'fs';
import * as path from 'path';
import { TARGET_SUFFIXES } from '../constants';
import type { BuildTargetType, UEBuildTarget, UEProject } from '../types';

const TARGET_TYPE_BY_UBT: Record<string, BuildTargetType> = {
  Editor: 'Editor',
  Game: 'Game',
  Client: 'Client',
  Server: 'Server',
};

/**
 * Discover UBT targets from .Target.cs files under the project's Source directory.
 */
export async function discoverProjectTargets(projectRoot: string): Promise<UEBuildTarget[]> {
  const sourceRoot = path.join(projectRoot, 'Source');
  const targetFiles = await findTargetFiles(sourceRoot);
  const targets: UEBuildTarget[] = [];

  for (const targetFile of targetFiles) {
    const content = await fs.promises.readFile(targetFile, 'utf-8');
    const type = parseTargetType(content);
    if (!type) continue;

    targets.push({
      name: path.basename(targetFile, '.Target.cs'),
      type,
      targetFile,
    });
  }

  return targets.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve the UBT target name for a project and target type.
 * Falls back to {ProjectName}{Suffix} when no .Target.cs files are found.
 */
export function pickTargetForType(project: UEProject, targetType: BuildTargetType): string {
  const suffix = TARGET_SUFFIXES[targetType] ?? '';
  const conventional = project.name + suffix;
  const discovered = project.targets.filter((target) => target.type === targetType);

  if (discovered.length === 0) {
    return conventional;
  }

  const byName = (name: string) => discovered.find((target) => target.name === name);

  const conventionalMatch = byName(conventional);
  if (conventionalMatch) {
    return conventionalMatch.name;
  }

  const primaryModule =
    project.modules.find((module) => module.type === 'Runtime')?.name ?? project.modules[0]?.name;

  if (primaryModule) {
    const moduleCandidates =
      targetType === 'Game' ? [primaryModule] : [primaryModule + suffix, primaryModule];

    for (const candidate of moduleCandidates) {
      const match = byName(candidate);
      if (match) {
        return match.name;
      }
    }
  }

  return [...discovered].sort((a, b) => targetPreferenceScore(a.name) - targetPreferenceScore(b.name))[0]
    .name;
}

function parseTargetType(content: string): BuildTargetType | undefined {
  const match = content.match(/Type\s*=\s*TargetType\.(\w+)/);
  if (!match) {
    return undefined;
  }

  return TARGET_TYPE_BY_UBT[match[1]];
}

function targetPreferenceScore(name: string): number {
  let score = name.length;
  if (/Steam|EOS|Android|IOS|Linux|Mac/.test(name)) {
    score += 100;
  }
  return score;
}

async function findTargetFiles(sourceRoot: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith('.Target.cs')) {
        results.push(fullPath);
      }
    }
  }

  await walk(sourceRoot);
  return results;
}
