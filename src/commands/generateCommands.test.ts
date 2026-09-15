import { describe, expect, it, vi } from 'vitest';

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn() }));

vi.mock('vscode', () => ({
  commands: { executeCommand },
}));

import { clangdSyncFromRunDetails, restartClangdIfAvailable } from './generateCommands';

function makeContext() {
  return {
    project: { projectRoot: 'p' },
    engine: { root: 'e' },
    outputChannel: { appendLine: vi.fn() },
  } as never;
}

describe('clangdSyncFromRunDetails', () => {
  it('reads templateFlags captured before forced-include injection', () => {
    expect(clangdSyncFromRunDetails({
      templateFlags: ['clang-cl.exe', '/I', 'Source'],
      projectForcedIncludes: { sharedPch: 'PCH.h', definitions: 'Def.h' },
    })).toEqual({
      templateFlags: ['clang-cl.exe', '/I', 'Source'],
      projectForcedIncludes: { sharedPch: 'PCH.h', definitions: 'Def.h' },
    });
  });
});

describe('restartClangdIfAvailable', () => {
  it('invokes clangd.restart so the server reloads compile_commands.json', async () => {
    executeCommand.mockClear();
    executeCommand.mockResolvedValue(undefined);

    await restartClangdIfAvailable(makeContext());

    expect(executeCommand).toHaveBeenCalledWith('clangd.restart');
  });

  it('does not throw when the clangd extension is missing', async () => {
    executeCommand.mockClear();
    executeCommand.mockRejectedValue(new Error('command not found'));

    await expect(restartClangdIfAvailable(makeContext())).resolves.toBeUndefined();
  });
});
