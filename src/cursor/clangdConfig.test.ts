import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLANGD_MANAGED_BEGIN,
  IDE_OVERRIDES_FILE_NAME,
  ensureClangdConfig,
  ensureIdeOverridesHeader,
} from './clangdConfig';

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

  it('suppresses include-cleaner unused-includes warnings', async () => {
    const projectRoot = makeTempDir();
    const changed = await ensureClangdConfig(projectRoot, {
      engineRoot: 'D:/Software/UE_5.8',
      templateFlags: ['/TP'],
    });

    expect(changed).toBe(true);
    const content = fs.readFileSync(path.join(projectRoot, '.clangd'), 'utf-8');
    expect(content).toMatch(/Suppress:[\s\S]*- unused-includes/);
    expect(content).toMatch(/Suppress:[\s\S]*- ovl_no_viable_function_in_init/);
    expect(content).toMatch(/Suppress:[\s\S]*- no_member/);
    expect(content).toMatch(/Suppress:[\s\S]*- access/);
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

  it('shares one IDE overrides header from storage and force-includes it last', async () => {
    const projectRoot = makeTempDir();
    const storageDir = makeTempDir();
    const ideOverridesHeader = await ensureIdeOverridesHeader(storageDir);

    const changed = await ensureClangdConfig(projectRoot, {
      engineRoot: 'D:/Software/UE_5.8',
      templateFlags: ['/TP'],
      projectRoot,
      projectForcedIncludes: {
        sharedPch: 'D:/Workspace/project/Intermediate/Build/SharedPCH.Project.h',
        definitions: 'D:/Workspace/project/Intermediate/Build/Definitions.Test.h',
      },
      ideOverridesHeader,
    });

    expect(changed).toBe(true);

    // The header lives in the shared storage dir, NOT inside the project.
    const header = fs.readFileSync(path.join(storageDir, IDE_OVERRIDES_FILE_NAME), 'utf-8');
    expect(header).toContain('#define UE_VALIDATE_FORMAT_STRINGS 0');
    // The SharedPCH locks in the checker alias before this header runs, so the
    // derived macro must be redefined directly — flipping the gate is too late.
    expect(header).toContain('#undef UE_VALIDATE_FORMAT_STRING');
    expect(header).toContain('#define UE_VALIDATE_FORMAT_STRING(Format, ...)');
    // Nothing is written into the project besides .clangd itself.
    expect(fs.readdirSync(projectRoot)).toEqual(['.clangd']);

    const content = fs.readFileSync(path.join(projectRoot, '.clangd'), 'utf-8');
    // Every fragment force-includes the shared override after the Definitions header.
    expect(content).toMatch(/Definitions\.Test\.h[\s\S]*?clangd-ide-overrides\.h/);
    expect(content).toContain(ideOverridesHeader);
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

  it('heals a stale diagnostics-only block written by an older version', async () => {
    const projectRoot = makeTempDir();
    await fs.promises.writeFile(
      path.join(projectRoot, '.clangd'),
      [
        '# <<< enginelink-managed >>>',
        'Diagnostics:',
        '  Suppress: builtin_definition',
        'CompileFlags:',
        '  Add:',
        '    - --query-driver=**/clang-cl.exe',
        '# <<< end-enginelink-managed >>>',
        '',
      ].join('\n'),
    );

    const changed = await ensureClangdConfig(projectRoot, {
      engineRoot: 'D:/Software/UE_5.8',
    });

    expect(changed).toBe(true);
    const content = fs.readFileSync(path.join(projectRoot, '.clangd'), 'utf-8');
    expect(content).toContain('- builtin_definition');
    expect(content).toContain('- unused-includes');
    expect(content).toContain('- constexpr_var_requires_const_init');
    // The bogus CLI flag in CompileFlags is dropped with the stale section.
    expect(content).not.toContain('--query-driver');
  });

  it('keeps If/CompileFlags fragments when healing the diagnostics section', async () => {
    const projectRoot = makeTempDir();
    await fs.promises.writeFile(
      path.join(projectRoot, '.clangd'),
      [
        '# <<< enginelink-managed >>>',
        'Diagnostics:',
        '  Suppress: builtin_definition',
        '---',
        'If:',
        '  PathMatch: ".*Source.*"',
        'CompileFlags:',
        '  Add:',
        '    - "/FI"',
        '    - "D:/Workspace/project/Intermediate/Build/SharedPCH.Project.h"',
        '# <<< end-enginelink-managed >>>',
        '',
      ].join('\n'),
    );

    const changed = await ensureClangdConfig(projectRoot, {
      engineRoot: 'D:/Software/UE_5.8',
    });

    expect(changed).toBe(true);
    const content = fs.readFileSync(path.join(projectRoot, '.clangd'), 'utf-8');
    expect(content).toContain('- unused-includes');
    expect(content).toContain('PathMatch: ".*Source.*"');
    expect(content).toContain('SharedPCH.Project.h');

    // A second activation with the healed block is a no-op.
    const again = await ensureClangdConfig(projectRoot, { engineRoot: 'D:/Software/UE_5.8' });
    expect(again).toBe(false);
  });
});
