#!/usr/bin/env node
import { EngineLinkService } from './core/service';
import { isSuccessfulDoctorStatus } from './doctor/status';

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(helpText());
    return;
  }
  const projectArg = option(rest, '--project') ?? process.cwd();
  const service = new EngineLinkService(projectArg);
  const context = { taskId: option(rest, '--task-id'), reason: option(rest, '--reason') };

  switch (command) {
    case 'environment': return print(await service.getEnvironment());
    case 'project-doctor': {
      const paths = options(rest, '--path');
      const completed = await service.runProjectDoctor({
        paths: paths.length ? paths : undefined,
        timeoutMs: numberOption(rest, '--timeout-ms'),
      });
      print(completed);
      if (!isSuccessfulDoctorStatus(completed.status)) process.exitCode = 1;
      return;
    }
    case 'build': return printOperation(await service.build({ ...context, ...buildOptions(rest) }));
    case 'clean': return printOperation(await service.clean({ ...context, ...buildOptions(rest), confirm: flag(rest, '--confirm') }));
    case 'compile-commands': return printOperation(await service.generateCompileCommands({
      ...context,
      configuration: option(rest, '--configuration') as 'Debug' | 'DebugGame' | 'Development' | 'Shipping' | 'Test' | undefined,
      platform: option(rest, '--platform') as 'Win64' | 'Linux' | 'Mac' | undefined,
    }));
    case 'launch': return print(await service.launchEditor(context));
    default:
      throw new Error(`Unknown command '${command}'.\n\n${helpText()}`);
  }
}

function buildOptions(args: string[]) {
  return {
    configuration: option(args, '--configuration') as 'Debug' | 'DebugGame' | 'Development' | 'Shipping' | 'Test' | undefined,
    targetType: option(args, '--target') as 'Editor' | 'Game' | 'Client' | 'Server' | undefined,
    platform: option(args, '--platform') as 'Win64' | 'Linux' | 'Mac' | undefined,
  };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function options(args: string[], name: string): string[] {
  return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]] : []);
}

function numberOption(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function flag(args: string[], name: string): boolean { return args.includes(name); }

function print(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }

function printOperation(value: { success: boolean }): void {
  print(value);
  if (!value.success) process.exitCode = 1;
}

function helpText(): string {
  return `EngineLink CLI\n\nCommands:\n  environment | build | clean --confirm | compile-commands | launch\n  project-doctor [--path PATH] [--timeout-ms MS]\n\nCommon options:\n  --project PATH\nBuild/clean/launch options:\n  --task-id ID --reason TEXT\n`;
}

main().catch((error) => {
  process.stderr.write(`EngineLink: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
