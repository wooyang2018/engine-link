import * as crypto from 'crypto';
import * as path from 'path';
import { exists } from '../core/config';
import type { StandaloneContext } from '../core/discovery';
import { detectBuildTools } from '../detection/buildToolsDetector';
import { spawnAsync } from '../platform/process';
import type { DoctorRun } from './types';

export interface HostCheckDeps {
  detectBuildTools?: typeof detectBuildTools;
  detectClang?: (buildToolsRoot?: string) => Promise<boolean>;
}

export async function applyHostChecks(
  ctx: StandaloneContext,
  run: DoctorRun,
  deps: HostCheckDeps = {},
): Promise<void> {
  const resolveBuildTools = deps.detectBuildTools ?? detectBuildTools;
  const resolveClang = deps.detectClang ?? detectClang;
  const buildTools = await resolveBuildTools();
  const clang = await resolveClang(buildTools?.installationPath);
  const ubtExists = await exists(ctx.engine.ubtPath);
  const editorBinaryExists = await exists(ctx.engine.editorPath);

  if (!buildTools) {
    addHostIssue(run, 'host.build_tools', 'P1', ctx.project.uprojectPath,
      'Visual Studio C++ Build Tools were not detected.',
      'Install MSVC build tools before relying on host-side compile workflows.');
  } else if (!buildTools.hasWindowsSDK) {
    addHostIssue(run, 'host.windows_sdk', 'P1', ctx.project.uprojectPath,
      'Visual Studio was found, but the expected Windows SDK component was not detected.',
      'Install a supported Windows SDK for UE Win64 builds.');
  }

  if (!clang) {
    addHostIssue(run, 'host.clang', 'P2', ctx.project.uprojectPath,
      'clang-cl was not found; compile_commands.json can be generated but IntelliSense may be incomplete.',
      'Provide clang-cl on PATH when compile_commands-based navigation is required.');
  }

  if (!ubtExists) {
    addHostIssue(run, 'host.ubt_missing', 'P1', ctx.engine.ubtPath,
      `UnrealBuildTool was not found at the resolved engine path.`,
      'Point the project at a complete UE installation that includes UBT.');
  }

  if (!editorBinaryExists) {
    addHostIssue(run, 'host.editor_binary_missing', 'P1', ctx.engine.editorPath,
      `Unreal Editor was not found at the resolved engine path.`,
      'Point the project at a complete UE installation that includes UnrealEditor.');
  }

  const blockingHost = run.issues.some((issue) =>
    issue.ruleId.startsWith('host.') && (issue.severity === 'P0' || issue.severity === 'P1'));
  run.coverage.host = {
    status: 'completed',
    detail: blockingHost
      ? 'Host toolchain or engine layout issues require attention.'
      : run.issues.some((issue) => issue.ruleId.startsWith('host.'))
        ? 'Host checks completed with non-blocking warnings.'
        : 'Host toolchain and engine layout look usable.',
  };
}

async function detectClang(buildToolsRoot?: string): Promise<boolean> {
  const lookup: [string, string[]] = process.platform === 'win32'
    ? ['where.exe', ['clang-cl.exe']]
    : ['which', ['clang++']];
  if ((await spawnAsync(lookup[0], lookup[1]).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))).exitCode === 0) {
    return true;
  }
  if (!buildToolsRoot) return false;
  return exists(path.join(buildToolsRoot, 'VC', 'Tools', 'Llvm', 'x64', 'bin', 'clang-cl.exe'));
}

function addHostIssue(
  run: DoctorRun,
  ruleId: string,
  severity: 'P0' | 'P1' | 'P2',
  targetPath: string,
  evidence: string,
  recommendation: string,
): void {
  const id = `UEPD-${ruleId.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}-${hashTarget(ruleId, targetPath)}`;
  if (run.issues.some((issue) => issue.id === id)) return;
  run.issues.push({ id, ruleId, severity, path: targetPath, evidence, recommendation });
}

function hashTarget(ruleId: string, target: string): string {
  return crypto.createHash('sha1').update(`${ruleId}\0${target.replace(/\\/g, '/').toLowerCase()}`).digest('hex').slice(0, 10);
}
