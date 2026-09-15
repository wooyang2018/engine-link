import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProjectRoot, findUniqueUProject } from './config';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe('standalone project discovery', () => {
  it('discovers a project from a nested working directory', async () => {
    const root = await makeProject();
    const nested = path.join(root, 'Source', 'Game');
    await fs.promises.mkdir(nested, { recursive: true });
    expect(await findProjectRoot(nested)).toBe(root);
    expect(await findUniqueUProject(root)).toBe('Game.uproject');
  });

  it('rejects a directory with more than one .uproject', async () => {
    const root = await makeProject();
    await fs.promises.writeFile(path.join(root, 'Other.uproject'), '{}', 'utf8');
    await expect(findUniqueUProject(root)).rejects.toThrow('Expected one .uproject');
  });

  it('does not treat a leftover EngineLink directory as a project root', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-config-'));
    tempRoots.push(root);
    await fs.promises.mkdir(path.join(root, '.enginelink'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.enginelink', 'ignored.json'), '{}', 'utf8');
    await expect(findProjectRoot(root)).rejects.toThrow('No Unreal project found');
  });
});

async function makeProject(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-config-'));
  tempRoots.push(root);
  await fs.promises.writeFile(path.join(root, 'Game.uproject'), '{}', 'utf8');
  return root;
}
