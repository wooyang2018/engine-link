import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { findAndPlaceCompileCommands } from './generateCommands';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-generate-'));
  tempDirs.push(dir);
  return dir;
}

function makeContext(projectRoot: string, engineRoot: string) {
  return {
    project: { projectRoot },
    engine: { root: engineRoot },
    outputChannel: { appendLine: vi.fn() },
  } as never;
}

describe('findAndPlaceCompileCommands', () => {
  it('replaces a stale project database with the current UBT output', async () => {
    const projectRoot = await makeTempDir();
    const engineRoot = await makeTempDir();
    const targetPath = path.join(projectRoot, 'compile_commands.json');
    const engineDatabase = path.join(engineRoot, 'compile_commands.json');

    await fs.promises.writeFile(targetPath, 'stale');
    await fs.promises.writeFile(engineDatabase, 'fresh');

    const placed = await findAndPlaceCompileCommands(
      makeContext(projectRoot, engineRoot),
      engineDatabase,
    );

    expect(placed).toBe(true);
    await expect(fs.promises.readFile(targetPath, 'utf8')).resolves.toBe('fresh');
  });

  it('does not treat an existing project database as a successful generation', async () => {
    const projectRoot = await makeTempDir();
    const engineRoot = await makeTempDir();
    const targetPath = path.join(projectRoot, 'compile_commands.json');

    await fs.promises.writeFile(targetPath, 'stale');

    const placed = await findAndPlaceCompileCommands(
      makeContext(projectRoot, engineRoot),
      path.join(engineRoot, 'missing-compile_commands.json'),
    );

    expect(placed).toBe(false);
    await expect(fs.promises.readFile(targetPath, 'utf8')).resolves.toBe('stale');
  });
});
