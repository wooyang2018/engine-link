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
      const referenceQueries = options(rest, '--reference');
      const scenarioNames = options(rest, '--scenario');
      const started = await service.startProjectDoctor({
        ...context,
        mode: option(rest, '--mode') as 'preflight' | 'changed' | 'scenario' | undefined,
        paths: paths.length ? paths : undefined,
        referenceQueries: referenceQueries.length ? referenceQueries : undefined,
        scenarioNames: scenarioNames.length ? scenarioNames : undefined,
        baselineRunId: option(rest, '--baseline'),
      });
      const completed = await service.waitForProjectDoctorRun(started.id, numberOption(rest, '--timeout-ms') ?? 180_000);
      print(completed);
      if (!isSuccessfulDoctorStatus(completed.status)) process.exitCode = 1;
      return;
    }
    case 'doctor-run': return print(await service.getProjectDoctorRun(requiredOption(rest, '--id')));
    case 'doctor-cancel': return print(await service.cancelProjectDoctorRun(requiredOption(rest, '--id')));
    case 'build': return printOperation(await service.build({ ...context, ...buildOptions(rest) }));
    case 'clean': return printOperation(await service.clean({ ...context, ...buildOptions(rest), confirm: flag(rest, '--confirm') }));
    case 'diagnostics': return print(await service.getBuildDiagnostics());
    case 'compile-commands': return printOperation(await service.generateCompileCommands({ ...context, ...buildOptions(rest) }));
    case 'editor-process': return print(await service.getEditorProcess());
    case 'launch': return print(await service.launchEditor(context));
    case 'accept': return printOperation(await service.runAcceptance({
      ...context,
      tier: option(rest, '--tier') ?? 'L1',
      evidenceNotes: option(rest, '--evidence-notes'),
    }));
    case 'run': return print(await service.getRun(requiredOption(rest, '--id')));
    case 'explain': process.stdout.write(await service.explainRun(requiredOption(rest, '--id'))); return;
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

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function flag(args: string[], name: string): boolean { return args.includes(name); }

function print(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }

function printOperation(value: { success: boolean }): void {
  print(value);
  if (!value.success) process.exitCode = 1;
}

function helpText(): string {
  return `EngineLink CLI\n\nCommands:\n  environment | build | clean --confirm | diagnostics\n  project-doctor --mode preflight|changed|scenario [--path PATH] [--reference /Game/Path] [--scenario NAME] [--baseline ID]\n  doctor-run --id ID | doctor-cancel --id ID\n  compile-commands | editor-process | launch\n  accept --tier L1|L2|L3 [--evidence-notes TEXT]\n  run --id ID | explain --id ID\n\nCommon options:\n  --project PATH --task-id ID --reason TEXT\n`;
}

main().catch((error) => {
  process.stderr.write(`EngineLink: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
