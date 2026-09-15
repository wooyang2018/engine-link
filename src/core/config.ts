import * as fs from 'fs';
import * as path from 'path';

export async function findProjectRoot(startPath: string): Promise<string> {
  let current = path.resolve(startPath);
  const stat = await fs.promises.stat(current).catch(() => undefined);
  if (stat?.isFile()) current = path.dirname(current);

  for (;;) {
    const entries = await fs.promises.readdir(current).catch(() => [] as string[]);
    if (entries.some((entry) => entry.toLowerCase().endsWith('.uproject'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`No Unreal project found from ${startPath}`);
}

export async function findUniqueUProject(projectRoot: string): Promise<string> {
  const entries = await fs.promises.readdir(projectRoot);
  const uprojects = entries.filter((entry) => entry.toLowerCase().endsWith('.uproject'));
  if (uprojects.length !== 1) {
    throw new Error(`Expected one .uproject in ${projectRoot}`);
  }
  return uprojects[0];
}

export async function exists(target: string): Promise<boolean> {
  return fs.promises.access(target).then(() => true, () => false);
}
