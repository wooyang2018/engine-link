import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractClangDatabasePath, placeCompileCommands } from './placeCompileCommands';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-place-'));
  tempDirs.push(dir);
  return dir;
}

describe('extractClangDatabasePath', () => {
  it('reads the path UBT prints', () => {
    expect(extractClangDatabasePath('ClangDatabase written to D:\\UE\\compile_commands.json\n')).toBe(
      'D:\\UE\\compile_commands.json',
    );
  });
});

describe('placeCompileCommands', () => {
  it('replaces a stale project database with the current UBT output', async () => {
    const projectRoot = await makeTempDir();
    const engineRoot = await makeTempDir();
    const targetPath = path.join(projectRoot, 'compile_commands.json');
    const engineDatabase = path.join(engineRoot, 'compile_commands.json');

    await fs.promises.writeFile(targetPath, 'stale');
    await fs.promises.writeFile(engineDatabase, 'fresh');

    const placed = await placeCompileCommands({
      projectRoot,
      engineRoot,
      ubtReportedPath: engineDatabase,
    });

    expect(placed.ok).toBe(true);
    expect(placed.placedFrom).toBe('UBT output');
    await expect(fs.promises.readFile(targetPath, 'utf8')).resolves.toBe('fresh');
  });

  it('does not treat an existing project database as a successful generation', async () => {
    const projectRoot = await makeTempDir();
    const engineRoot = await makeTempDir();
    const targetPath = path.join(projectRoot, 'compile_commands.json');

    await fs.promises.writeFile(targetPath, 'stale');

    const placed = await placeCompileCommands({
      projectRoot,
      engineRoot,
      ubtReportedPath: path.join(engineRoot, 'missing-compile_commands.json'),
    });

    expect(placed.ok).toBe(false);
    await expect(fs.promises.readFile(targetPath, 'utf8')).resolves.toBe('stale');
  });

  it('copies from the engine root when UBT did not report a path', async () => {
    const projectRoot = await makeTempDir();
    const engineRoot = await makeTempDir();
    await fs.promises.writeFile(path.join(engineRoot, 'compile_commands.json'), 'from-engine');

    const placed = await placeCompileCommands({ projectRoot, engineRoot });

    expect(placed.ok).toBe(true);
    expect(placed.placedFrom).toBe('engine root');
    await expect(fs.promises.readFile(path.join(projectRoot, 'compile_commands.json'), 'utf8')).resolves.toBe('from-engine');
  });
});
