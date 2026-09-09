import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addEngineHeaderEntries,
  expandResponseFile,
  extractResponseFilePaths,
  flattenCommand,
  hasMissingResponseFiles,
  normalizeClangdArguments,
  postProcessCompileCommands,
  splitGluedMsvcToken,
  tokenizeCommandLine,
  writeCompileCommandsAtomic,
  type CompileCommandEntry,
} from './compileCommandsPostProcess';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enginelink-'));
  tempDirs.push(dir);
  return dir;
}

describe('tokenizeCommandLine', () => {
  it('splits quoted and unquoted tokens', () => {
    const tokens = tokenizeCommandLine(
      '"C:/clang-cl.exe" @"C:/project/foo.cpp.obj.rsp" /TP',
    );
    expect(tokens).toEqual(['"C:/clang-cl.exe"', '@"C:/project/foo.cpp.obj.rsp"', '/TP']);
  });
});

describe('splitGluedMsvcToken', () => {
  it('splits /FI glued paths', () => {
    expect(splitGluedMsvcToken('/FI"D:/pch/SharedPCH.h"')).toEqual([
      '/FI',
      'D:/pch/SharedPCH.h',
    ]);
  });

  it('does not split /imsvc into /I and msvc', () => {
    expect(splitGluedMsvcToken('/imsvc')).toEqual(['/imsvc']);
    expect(splitGluedMsvcToken('/imsvc"ThirdParty/RapidJSON/1.1.0"')).toEqual([
      '/imsvc"ThirdParty/RapidJSON/1.1.0"',
    ]);
  });

  it('does not split /diagnostics or /d2 MSVC switches', () => {
    expect(splitGluedMsvcToken('/diagnostics:caret')).toEqual(['/diagnostics:caret']);
    expect(splitGluedMsvcToken('/d2ExtendedWarningInfo')).toEqual(['/d2ExtendedWarningInfo']);
  });

  it('splits glued /D defines', () => {
    expect(splitGluedMsvcToken('/DUE_BUILD_DEVELOPMENT=1')).toEqual([
      '/D',
      'UE_BUILD_DEVELOPMENT=1',
    ]);
  });
});

describe('normalizeClangdArguments', () => {
  it('keeps /FI and removes /Yu /Fp', () => {
    const directory = 'D:/Software/UE_5.8/Engine/Source';
    const normalized = normalizeClangdArguments(
      [
        '/FI"D:/Workspace/project/Intermediate/SharedPCH.h"',
        '/Yu"D:/Workspace/project/Intermediate/SharedPCH.h"',
        '/Fp"D:/Workspace/project/Intermediate/SharedPCH.h.pch"',
        '/I',
        'Runtime/Engine/Classes',
      ],
      directory,
    );

    expect(normalized).toContain('/FI');
    expect(normalized.some((arg) => arg.replace(/\\/g, '/').includes('SharedPCH.h'))).toBe(true);
    expect(normalized.some((arg) => arg.includes('.pch'))).toBe(false);
    expect(normalized.some((arg) => arg.replace(/\\/g, '/').includes('Engine/Classes'))).toBe(true);
  });

  it('converts /external:I to clangd-friendly /I pairs', () => {
    const directory = 'D:/Software/UE_5.8/Engine/Source';
    const normalized = normalizeClangdArguments(
      ['/external:I', 'ThirdParty/RapidJSON/1.1.0'],
      directory,
    );

    expect(normalized[0]).toBe('/I');
    expect(normalized[1].replace(/\\/g, '/')).toBe(
      path.join(directory, 'ThirdParty/RapidJSON/1.1.0').replace(/\\/g, '/'),
    );
  });

  it('converts /imsvc to clangd-friendly /I pairs', () => {
    const directory = 'D:/Software/UE_5.8/Engine/Source';
    const msvcInclude = 'D:/Software/Microsoft Visual Studio/2026/VC/Tools/MSVC/14.51.36231/INCLUDE';
    const normalized = normalizeClangdArguments(['/imsvc', msvcInclude], directory);

    expect(normalized[0]).toBe('/I');
    expect(normalized[1].replace(/\\/g, '/')).toBe(msvcInclude);
  });
});

describe('extractResponseFilePaths', () => {
  it('finds @rsp paths', () => {
    const paths = extractResponseFilePaths(
      '"C:/clang-cl.exe" @"D:/Workspace/project/Intermediate/foo.cpp.obj.rsp"',
    );
    expect(paths).toEqual(['D:/Workspace/project/Intermediate/foo.cpp.obj.rsp']);
  });
});

describe('expandResponseFile', () => {
  it('inlines nested response files', () => {
    const root = makeTempDir();
    const sharedRsp = path.join(root, 'shared.rsp');
    const leafRsp = path.join(root, 'leaf.rsp');
    fs.writeFileSync(sharedRsp, '/I "Runtime/Engine/Classes"\n/nologo\n');
    fs.writeFileSync(leafRsp, `@${sharedRsp}\n/TP\n`);

    const args = expandResponseFile(leafRsp, root);
    expect(args).toContain('/I');
    expect(args).toContain('Runtime/Engine/Classes');
    expect(args).toContain('/TP');
    expect(args).toContain('/nologo');
  });
});

describe('flattenCommand', () => {
  it('expands a top-level @rsp into arguments', () => {
    const root = makeTempDir();
    const rsp = path.join(root, 'foo.cpp.obj.rsp');
    fs.writeFileSync(rsp, '/I "Runtime/Engine/Classes"\n/std:c++20\n');

    const { arguments: args, broken } = flattenCommand(
      `"C:/clang-cl.exe" @"${rsp}"`,
      root,
    );

    expect(broken).toBe(false);
    expect(args).toContain('/I');
    expect(args).toContain('Runtime/Engine/Classes');
    expect(args).toContain('/std:c++20');
  });

  it('marks missing response files as broken', () => {
    const root = makeTempDir();
    const missing = path.join(root, 'missing.cpp.obj.rsp');
    const { broken } = flattenCommand(`"clang-cl.exe" @"${missing}"`, root);
    expect(broken).toBe(true);
    expect(hasMissingResponseFiles(`"clang-cl.exe" @"${missing}"`, root)).toBe(true);
  });

  it('treats an existing empty rsp as success', () => {
    const root = makeTempDir();
    const rsp = path.join(root, 'empty.cpp.obj.rsp');
    fs.writeFileSync(rsp, '');

    const { arguments: args, broken } = flattenCommand(`"clang-cl.exe" @"${rsp}"`, root);

    expect(broken).toBe(false);
    expect(args).toContain('clang-cl.exe');
  });
});

describe('addEngineHeaderEntries', () => {
  it('creates compile entries for engine headers included from project source', async () => {
    const projectRoot = makeTempDir();
    const engineRoot = makeTempDir();
    const engineSource = path.join(engineRoot, 'Engine', 'Source', 'Runtime', 'AudioMixer', 'Public');
    const corePublic = path.join(engineRoot, 'Engine', 'Source', 'Runtime', 'Core', 'Public');
    fs.mkdirSync(engineSource, { recursive: true });
    fs.mkdirSync(corePublic, { recursive: true });

    const engineHeader = path.join(engineSource, 'AudioMixerBlueprintLibrary.h');
    const coreMinimal = path.join(corePublic, 'CoreMinimal.h');
    fs.writeFileSync(coreMinimal, '#pragma once\n');
    fs.writeFileSync(
      engineHeader,
      '#include "CoreMinimal.h"\nDECLARE_DYNAMIC_DELEGATE_TwoParams(FOnSoundLoadComplete, int, A, int, B);\n',
    );

    const sourceCpp = path.join(projectRoot, 'Source', 'LyraGame', 'Audio', 'LyraAudioMixEffectsSubsystem.cpp');
    fs.mkdirSync(path.dirname(sourceCpp), { recursive: true });
    fs.writeFileSync(sourceCpp, '#include "AudioMixerBlueprintLibrary.h"\n');

    const includeRoot = path.join(engineRoot, 'Engine', 'Source');
    const entries: CompileCommandEntry[] = [
      {
        file: sourceCpp.replace(/\\/g, '/'),
        directory: includeRoot.replace(/\\/g, '/'),
        arguments: [
          'clang-cl.exe',
          '/I',
          path.join(includeRoot, 'Runtime', 'AudioMixer', 'Public').replace(/\\/g, '/'),
          '/I',
          path.join(includeRoot, 'Runtime', 'Core', 'Public').replace(/\\/g, '/'),
        ],
      },
    ];

    const result = await addEngineHeaderEntries(projectRoot, engineRoot, entries);
    const engineEntry = result.entries.find((entry) => entry.file.endsWith('AudioMixerBlueprintLibrary.h'));
    const coreEntry = result.entries.find((entry) => entry.file.endsWith('CoreMinimal.h'));

    expect(result.engineHeaderEntries).toBeGreaterThanOrEqual(2);
    expect(engineEntry?.arguments?.slice(0, entries[0].arguments!.length)).toEqual(
      entries[0].arguments,
    );
    expect(engineEntry?.arguments?.includes(engineEntry!.file)).toBe(true);
    expect(coreEntry?.arguments?.includes(coreEntry!.file)).toBe(true);
  });
});

describe('postProcessCompileCommands', () => {
  it('remaps broken per-file entries via Module.*.cpp and adds header aliases', async () => {
    const projectRoot = makeTempDir();
    const moduleDir = path.join(
      projectRoot,
      'Intermediate',
      'Build',
      'Win64',
      'x64',
      'UnrealEditor',
      'Development',
      'LyraGame',
    );
    fs.mkdirSync(moduleDir, { recursive: true });

    const sourceCpp = path.join(projectRoot, 'Source', 'LyraGame', 'Animation', 'LyraAnimInstance.cpp');
    const sourceHeader = path.join(projectRoot, 'Source', 'LyraGame', 'Animation', 'LyraAnimInstance.h');
    fs.mkdirSync(path.dirname(sourceCpp), { recursive: true });
    fs.writeFileSync(sourceCpp, '#include "LyraAnimInstance.h"\n');
    fs.writeFileSync(sourceHeader, '#pragma once\n');

    const moduleCpp = path.join(moduleDir, 'Module.LyraGame.1.cpp');
    fs.writeFileSync(moduleCpp, `#include "${sourceCpp.replace(/\\/g, '/')}"\n`);

    const sharedRsp = path.join(moduleDir, 'LyraGame.Shared.rsp');
    const moduleRsp = path.join(moduleDir, 'Module.LyraGame.1.cpp.obj.rsp');
    fs.writeFileSync(sharedRsp, '/I "Runtime/Engine/Classes"\n');
    fs.writeFileSync(
      moduleRsp,
      `"${moduleCpp.replace(/\\/g, '/')}"\n@"${sharedRsp.replace(/\\/g, '/')}"\n`,
    );

    const missingRsp = path.join(moduleDir, 'LyraAnimInstance.cpp.obj.rsp');
    const entries: CompileCommandEntry[] = [
      {
        file: sourceCpp.replace(/\\/g, '/'),
        command: `"C:/clang-cl.exe" @"${missingRsp.replace(/\\/g, '/')}"`,
        directory: 'D:/Software/UE_5.8/Engine/Source',
        output: path.join(moduleDir, 'LyraAnimInstance.cpp.obj').replace(/\\/g, '/'),
      },
    ];

    const result = await postProcessCompileCommands(projectRoot, entries);
    const cppEntry = result.entries.find((e) => e.file.endsWith('LyraAnimInstance.cpp'));
    const headerEntry = result.entries.find((e) => e.file.endsWith('LyraAnimInstance.h'));

    expect(result.stats.remapped).toBe(1);
    expect(result.stats.headerAliases).toBe(1);
    expect(cppEntry?.arguments?.some((arg) => /Engine[\\/]Classes/i.test(arg))).toBe(true);
    expect(cppEntry?.command).toBeUndefined();
    expect(headerEntry?.arguments?.includes(headerEntry!.file)).toBe(true);
    expect(headerEntry?.arguments?.includes(cppEntry!.file)).toBe(false);
    expect(headerEntry?.command).toBeUndefined();
    expect(headerEntry?.output).toBeUndefined();
  });

  it('normalizes remapped unity rsp paths against moduleDir', async () => {
    const projectRoot = makeTempDir();
    const moduleDir = path.join(projectRoot, 'Intermediate', 'Build', 'LyraGame');
    const localInclude = path.join(moduleDir, 'ModuleOnly', 'Include');
    fs.mkdirSync(localInclude, { recursive: true });

    const sourceCpp = path.join(projectRoot, 'Source', 'LyraGame', 'Foo.cpp');
    fs.mkdirSync(path.dirname(sourceCpp), { recursive: true });
    fs.writeFileSync(sourceCpp, '//\n');

    const moduleCpp = path.join(moduleDir, 'Module.LyraGame.1.cpp');
    fs.writeFileSync(moduleCpp, `#include "${sourceCpp.replace(/\\/g, '/')}"\n`);

    const sharedRsp = path.join(moduleDir, 'Shared.rsp');
    fs.writeFileSync(sharedRsp, '/I "ModuleOnly/Include"\n');

    const moduleRsp = path.join(moduleDir, 'Module.LyraGame.1.cpp.obj.rsp');
    fs.writeFileSync(moduleRsp, `@${sharedRsp}\n`);

    const missingRsp = path.join(moduleDir, 'Foo.cpp.obj.rsp');
    const entries: CompileCommandEntry[] = [
      {
        file: sourceCpp.replace(/\\/g, '/'),
        command: `"clang-cl.exe" @"${missingRsp}"`,
        directory: 'D:/Software/UE_5.8/Engine/Source',
        output: path.join(moduleDir, 'Foo.cpp.obj').replace(/\\/g, '/'),
      },
    ];

    const result = await postProcessCompileCommands(projectRoot, entries);
    const cppEntry = result.entries.find((entry) => entry.file.endsWith('Foo.cpp'));
    const includeArg = cppEntry?.arguments?.find((arg) =>
      arg.replace(/\\/g, '/').includes('ModuleOnly/Include'),
    );

    expect(result.stats.remapped).toBe(1);
    expect(includeArg?.replace(/\\/g, '/')).toBe(localInclude.replace(/\\/g, '/'));
  });

  it('resolves relative output paths against entry.directory for obj.rsp', async () => {
    const projectRoot = makeTempDir();
    const buildDir = path.join(projectRoot, 'Intermediate', 'Build', 'Module');
    fs.mkdirSync(buildDir, { recursive: true });

    const sourceCpp = path.join(projectRoot, 'Source', 'Game', 'Foo.cpp');
    fs.mkdirSync(path.dirname(sourceCpp), { recursive: true });
    fs.writeFileSync(sourceCpp, '//\n');

    const relativeOutput = 'Intermediate/Build/Module/Foo.cpp.obj';
    const rspPath = path.join(projectRoot, `${relativeOutput}.rsp`);
    fs.writeFileSync(rspPath, '/TP\n');

    const entries: CompileCommandEntry[] = [
      {
        file: sourceCpp.replace(/\\/g, '/'),
        directory: projectRoot.replace(/\\/g, '/'),
        output: relativeOutput.replace(/\\/g, '/'),
      },
    ];

    const result = await postProcessCompileCommands(projectRoot, entries);
    const cppEntry = result.entries.find((entry) => entry.file.endsWith('Foo.cpp'));

    expect(cppEntry?.arguments).toContain('/TP');
    expect(cppEntry?.command).toBeUndefined();
  });

  it('maps Private/Subdir/Foo.cpp header aliases to Public/Subdir/Foo.h', async () => {
    const projectRoot = makeTempDir();
    const sourceCpp = path.join(
      projectRoot,
      'Plugins',
      'GameFeatures',
      'ExtractionOps',
      'Source',
      'ExtractionOpsRuntime',
      'Private',
      'Session',
      'ExtractionGameMode.cpp',
    );
    const sourceHeader = path.join(
      projectRoot,
      'Plugins',
      'GameFeatures',
      'ExtractionOps',
      'Source',
      'ExtractionOpsRuntime',
      'Public',
      'Session',
      'ExtractionGameMode.h',
    );
    fs.mkdirSync(path.dirname(sourceCpp), { recursive: true });
    fs.mkdirSync(path.dirname(sourceHeader), { recursive: true });
    fs.writeFileSync(sourceCpp, '#include "Session/ExtractionGameMode.h"\n');
    fs.writeFileSync(sourceHeader, '#pragma once\n');

    const entries: CompileCommandEntry[] = [
      {
        file: sourceCpp.replace(/\\/g, '/'),
        directory: 'D:/Software/UE_5.8/Engine/Source',
        arguments: ['clang-cl.exe', sourceCpp.replace(/\\/g, '/')],
      },
    ];

    const result = await postProcessCompileCommands(projectRoot, entries);
    const headerEntry = result.entries.find((e) => e.file.endsWith('Session/ExtractionGameMode.h'));

    expect(result.stats.headerAliases).toBe(1);
    expect(headerEntry?.file.replace(/\\/g, '/')).toContain('/Public/Session/ExtractionGameMode.h');
    expect(headerEntry?.arguments?.includes(headerEntry!.file)).toBe(true);
    expect(headerEntry?.output).toBeUndefined();
  });

  it('maps Private/Foo.cpp header aliases to Public/Foo.h for UE modules', async () => {
    const projectRoot = makeTempDir();
    const sourceCpp = path.join(projectRoot, 'Source', 'GAS_Learn', 'Private', 'AroundTargetActor.cpp');
    const sourceHeader = path.join(projectRoot, 'Source', 'GAS_Learn', 'Public', 'AroundTargetActor.h');
    fs.mkdirSync(path.dirname(sourceCpp), { recursive: true });
    fs.mkdirSync(path.dirname(sourceHeader), { recursive: true });
    fs.writeFileSync(sourceCpp, '#include "AroundTargetActor.h"\n');
    fs.writeFileSync(sourceHeader, '#pragma once\n');

    const entries: CompileCommandEntry[] = [
      {
        file: sourceCpp.replace(/\\/g, '/'),
        directory: 'D:/Software/UE_5.8/Engine/Source',
        arguments: [
          'clang-cl.exe',
          '/I',
          path.join(projectRoot, 'Source', 'GAS_Learn', 'Public').replace(/\\/g, '/'),
          '/I',
          path.join(projectRoot, 'Source', 'GAS_Learn', 'Private').replace(/\\/g, '/'),
          sourceCpp.replace(/\\/g, '/'),
        ],
      },
    ];

    const result = await postProcessCompileCommands(projectRoot, entries);
    const cppEntry = result.entries.find((e) => e.file.endsWith('AroundTargetActor.cpp'));
    const headerEntry = result.entries.find((e) => e.file.endsWith('AroundTargetActor.h'));

    expect(result.stats.headerAliases).toBe(1);
    expect(headerEntry?.file.replace(/\\/g, '/')).toContain('/Public/AroundTargetActor.h');
    expect(headerEntry?.file.replace(/\\/g, '/')).not.toContain('/Private/AroundTargetActor.h');
    expect(headerEntry?.arguments).not.toEqual(cppEntry?.arguments);
    expect(headerEntry?.arguments?.includes(headerEntry!.file)).toBe(true);
    expect(headerEntry?.arguments?.includes(cppEntry!.file)).toBe(false);
    expect(headerEntry?.output).toBeUndefined();
  });

  it('re-derives project header aliases from .cpp and ignores prior .h entries in input', async () => {
    const projectRoot = makeTempDir();
    const sourceCpp = path.join(projectRoot, 'Source', 'GAS_Learn', 'Private', 'AroundTargetActor.cpp');
    const sourceHeader = path.join(projectRoot, 'Source', 'GAS_Learn', 'Public', 'AroundTargetActor.h');
    const wrongHeader = path.join(projectRoot, 'Source', 'GAS_Learn', 'Private', 'AroundTargetActor.h');
    fs.mkdirSync(path.dirname(sourceCpp), { recursive: true });
    fs.mkdirSync(path.dirname(sourceHeader), { recursive: true });
    fs.writeFileSync(sourceCpp, '#include "AroundTargetActor.h"\n');
    fs.writeFileSync(sourceHeader, '#pragma once\n');

    const entries: CompileCommandEntry[] = [
      {
        file: sourceCpp.replace(/\\/g, '/'),
        directory: 'D:/Software/UE_5.8/Engine/Source',
        arguments: ['clang-cl.exe', '/I', path.dirname(sourceHeader).replace(/\\/g, '/')],
      },
      {
        file: wrongHeader.replace(/\\/g, '/'),
        directory: 'D:/Software/UE_5.8/Engine/Source',
        arguments: ['clang-cl.exe', '/I', path.dirname(sourceHeader).replace(/\\/g, '/')],
      },
    ];

    const result = await postProcessCompileCommands(projectRoot, entries);
    const headerPaths = result.entries
      .filter((entry) => entry.file.endsWith('AroundTargetActor.h'))
      .map((entry) => entry.file.replace(/\\/g, '/'));

    expect(headerPaths).toEqual([
      path.join(projectRoot, 'Source', 'GAS_Learn', 'Public', 'AroundTargetActor.h').replace(/\\/g, '/'),
    ]);
  });
});

describe('writeCompileCommandsAtomic', () => {
  it('overwrites an existing compile_commands.json', async () => {
    const projectRoot = makeTempDir();
    const targetPath = path.join(projectRoot, 'compile_commands.json');
    fs.writeFileSync(targetPath, '[]\n');

    await writeCompileCommandsAtomic(projectRoot, [
      { file: 'D:/project/Source/Foo.cpp', arguments: ['clang-cl.exe'] },
    ]);

    const written = JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as CompileCommandEntry[];
    expect(written).toHaveLength(1);
    expect(written[0].file).toContain('Foo.cpp');
    expect(fs.readdirSync(projectRoot).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});
