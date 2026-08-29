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
});

describe('normalizeClangdArguments', () => {
  it('converts /FI to -include and removes /Yu /Fp', () => {
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

    expect(normalized).toContain('-include');
    expect(normalized.some((arg) => arg.replace(/\\/g, '/').includes('SharedPCH.h'))).toBe(true);
    expect(normalized.some((arg) => arg.includes('.pch'))).toBe(false);
    expect(normalized.some((arg) => arg.replace(/\\/g, '/').includes('Engine/Classes'))).toBe(true);
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
    expect(engineEntry?.arguments).toEqual(entries[0].arguments);
    expect(coreEntry?.arguments).toEqual(entries[0].arguments);
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
    expect(headerEntry?.arguments).toEqual(cppEntry?.arguments);
  });
});
