import { spawn } from 'child_process';
import type { SpawnResult } from '../types';

/** Minimal cancellation contract shared by the Cursor extension and standalone callers. */
export interface ProcessCancellationToken {
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/**
 * Spawn a process and return the result as a promise.
 * Supports line-by-line streaming and cancellation.
 */
export function spawnAsync(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    onStdout?: (line: string) => void;
    onStderr?: (line: string) => void;
    token?: ProcessCancellationToken;
    shell?: boolean;
  },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      shell: options?.shell ?? false,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    let stdoutRemainder = '';
    let stderrRemainder = '';

    if (options?.token) {
      const disposable = options.token.onCancellationRequested(() => {
        proc.kill('SIGTERM');
        disposable.dispose();
      });
    }

    proc.stdout.on('data', (data: Buffer) => {
      const text = stdoutRemainder + data.toString();
      const lines = text.split('\n');
      stdoutRemainder = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '');
        stdout += trimmed + '\n';
        options?.onStdout?.(trimmed);
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      const text = stderrRemainder + data.toString();
      const lines = text.split('\n');
      stderrRemainder = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '');
        stderr += trimmed + '\n';
        options?.onStderr?.(trimmed);
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });

    proc.on('close', (code) => {
      // Flush remainders
      if (stdoutRemainder) {
        stdout += stdoutRemainder + '\n';
        options?.onStdout?.(stdoutRemainder);
      }
      if (stderrRemainder) {
        stderr += stderrRemainder + '\n';
        options?.onStderr?.(stderrRemainder);
      }
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
