import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProjectRoot, loadProjectConfig } from './config';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe('standalone project configuration', () => {
  it('discovers a project from a nested working directory', async () => {
    const root = await makeProject();
    const nested = path.join(root, 'Source', 'Game');
    await fs.promises.mkdir(nested, { recursive: true });
    expect(await findProjectRoot(nested)).toBe(root);
    expect((await loadProjectConfig(root)).uproject).toBe('Game.uproject');
  });

  it('rejects absolute uproject paths in shared configuration', async () => {
    const root = await makeProject({ schemaVersion: 1, uproject: 'C:/Other/Game.uproject' });
    await expect(loadProjectConfig(root)).rejects.toThrow('project-relative');
  });
});

async function makeProject(config?: object): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-config-'));
  tempRoots.push(root);
  await fs.promises.writeFile(path.join(root, 'Game.uproject'), '{}', 'utf8');
  if (config) {
    await fs.promises.mkdir(path.join(root, '.enginelink'));
    await fs.promises.writeFile(path.join(root, '.enginelink', 'project.json'), JSON.stringify(config), 'utf8');
  }
  return root;
}
