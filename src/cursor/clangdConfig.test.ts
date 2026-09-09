import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLANGD_MANAGED_BEGIN, ensureClangdConfig } from './clangdConfig';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enginelink-clangd-'));
  tempDirs.push(dir);
  return dir;
}

describe('ensureClangdConfig', () => {
  it('writes valid YAML for resource-dir template flags', async () => {
    const projectRoot = makeTempDir();
    const changed = await ensureClangdConfig(projectRoot, {
      engineRoot: 'D:/Software/UE_5.8',
      templateFlags: [
        'clang-cl.exe',
        '-resource-dir="D:/Software/Microsoft Visual Studio/2026/VC/Tools/Llvm/x64/lib/clang/22"',
        '/TP',
      ],
    });

    expect(changed).toBe(true);
    const content = fs.readFileSync(path.join(projectRoot, '.clangd'), 'utf-8');
    expect(content).toContain(CLANGD_MANAGED_BEGIN);
    expect(content).not.toMatch(/- "-resource-dir="/);
    expect(content).toContain('-resource-dir');
    expect(content).toContain('D:/Software/Microsoft Visual Studio/2026/VC/Tools/Llvm/x64/lib/clang/22');
  });

  it('adds project Source PathMatch with forced includes', async () => {
    const projectRoot = makeTempDir();
    const changed = await ensureClangdConfig(projectRoot, {
      engineRoot: 'D:/Software/UE_5.8',
      projectRoot,
      projectForcedIncludes: {
        sharedPch:
          'D:/Workspace/project/Intermediate/Build/SharedPCH.UnrealEd.Project.h',
        definitions: 'D:/Workspace/project/Intermediate/Build/Definitions.Test.h',
      },
    });

    expect(changed).toBe(true);
    const content = fs.readFileSync(path.join(projectRoot, '.clangd'), 'utf-8');
    expect(content).toContain('Workspace/');
    expect(content).toContain('Source.*');
    expect(content).toContain('PathExclude: ".*Engine.*Source.*"');
    expect(content).toContain('/clang:-ferror-limit=0');
    expect(content).toContain('SharedPCH.UnrealEd.Project.h');
    expect(content).toContain('Definitions.Test.h');
  });

  it('preserves generated compile flags when activation only refreshes diagnostics', async () => {
    const projectRoot = makeTempDir();
    const forced = {
      sharedPch: 'D:/Workspace/project/Intermediate/Build/SharedPCH.Project.h',
      definitions: 'D:/Workspace/project/Intermediate/Build/Definitions.Test.h',
    };

    await ensureClangdConfig(projectRoot, {
      engineRoot: 'D:/Software/UE_5.8',
      templateFlags: ['/TP'],
      projectRoot,
      projectForcedIncludes: forced,
    });
    const before = fs.readFileSync(path.join(projectRoot, '.clangd'), 'utf-8');

    const changed = await ensureClangdConfig(projectRoot, {
      engineRoot: 'D:/Software/UE_5.8',
    });
    const after = fs.readFileSync(path.join(projectRoot, '.clangd'), 'utf-8');

    expect(changed).toBe(false);
    expect(after).toBe(before);
    expect(after).toContain('SharedPCH.Project.h');
    expect(after).toContain('Definitions.Test.h');
  });
});
