import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureVscodeSettings } from './vscodeSettings';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enginelink-settings-'));
  tempDirs.push(dir);
  return dir;
}

function readSettings(projectRoot: string): string {
  return fs.readFileSync(path.join(projectRoot, '.vscode', 'settings.json'), 'utf-8');
}

describe('ensureVscodeSettings', () => {
  it('does not inject --compile-commands-dir (breaks multi-root clangd)', async () => {
    const projectRoot = makeTempDir();
    const changed = await ensureVscodeSettings(projectRoot);

    expect(changed).toBe(true);
    const content = readSettings(projectRoot);
    expect(content).not.toContain('--compile-commands-dir');
    expect(content).toContain('--query-driver=**/clang-cl.exe');
    expect(content).toContain('C_Cpp.default.compileCommands');
  });

  it('migrates a stale managed block that still contains --compile-commands-dir', async () => {
    const projectRoot = makeTempDir();
    const vscodeDir = path.join(projectRoot, '.vscode');
    await fs.promises.mkdir(vscodeDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(vscodeDir, 'settings.json'),
      [
        '{',
        '  // <<< enginelink-managed >>>',
        '  "C_Cpp.default.compileCommands": "${workspaceFolder}/compile_commands.json",',
        '  "clangd.arguments": [',
        '    "--compile-commands-dir=${workspaceFolder}",',
        '    "--query-driver=**/clang-cl.exe"',
        '  ]',
        '  // <<< end-enginelink-managed >>>',
        '}',
        '',
      ].join('\n'),
    );

    const changed = await ensureVscodeSettings(projectRoot);

    expect(changed).toBe(true);
    const content = readSettings(projectRoot);
    expect(content).not.toContain('--compile-commands-dir');
    expect(content).toContain('--query-driver=**/clang-cl.exe');
  });

  it('is a no-op once the managed block is current', async () => {
    const projectRoot = makeTempDir();
    await ensureVscodeSettings(projectRoot);

    const changed = await ensureVscodeSettings(projectRoot);

    expect(changed).toBe(false);
  });
});
