#!/usr/bin/env node
import * as path from 'path';
import { generateClientConfigs, type ClientMode, type ClientName } from './core/clientConfig';
import { findProjectRoot } from './core/config';
import { EngineLinkService } from './core/service';

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const projectArg = option(rest, '--project') ?? process.cwd();
  const service = new EngineLinkService(projectArg);
  const context = { taskId: option(rest, '--task-id'), reason: option(rest, '--reason') };

  switch (command) {
    case 'environment': return print(await service.getEnvironment());
    case 'doctor': return print(await service.doctor());
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
    case 'configure': {
      const projectRoot = await findProjectRoot(projectArg);
      const clients = parseClients(option(rest, '--clients') ?? 'all');
      const mode = (option(rest, '--mode') ?? 'both') as ClientMode;
      if (!['both', 'enginelink', 'unreal'].includes(mode)) throw new Error(`Invalid --mode: ${mode}`);
      const serverPath = path.resolve(option(rest, '--server-path') ?? path.join(__dirname, 'mcp-server.js'));
      return print(await generateClientConfigs({ projectRoot, serverPath, clients, mode }));
    }
    default:
      process.stdout.write(helpText());
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

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function flag(args: string[], name: string): boolean { return args.includes(name); }

function parseClients(value: string): ClientName[] {
  if (value === 'all') return ['codex', 'cursor', 'claude'];
  const clients = value.split(',') as ClientName[];
  if (clients.some((client) => !['codex', 'cursor', 'claude'].includes(client))) throw new Error(`Invalid clients: ${value}`);
  return clients;
}

function print(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }

function printOperation(value: { success: boolean }): void {
  print(value);
  if (!value.success) process.exitCode = 1;
}

function helpText(): string {
  return `EngineLink CLI\n\nCommands:\n  environment | doctor | build | clean --confirm | diagnostics\n  compile-commands | editor-process | launch\n  accept --tier L1|L2|L3 [--evidence-notes TEXT]\n  run --id ID | explain --id ID\n  configure --clients all|codex,cursor,claude --mode both|enginelink|unreal\n\nCommon options:\n  --project PATH --task-id ID --reason TEXT\n`;
}

main().catch((error) => {
  process.stderr.write(`EngineLink: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
