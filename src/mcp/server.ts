#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { EngineLinkService } from '../core/service';
import { TOOL_DEFINITIONS } from './tools';

const projectPath = getOption('--project') ?? process.env.ENGINELINK_PROJECT ?? process.cwd();
const service = new EngineLinkService(projectPath);
const server = new Server(
  { name: 'enginelink', version: '0.2.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOL_DEFINITIONS] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await dispatch(request.params.name, args);
    const operationFailed = isFailedRun(result);
    return {
      ...(operationFailed ? { isError: true } : {}),
      content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
      structuredContent: toObject(result),
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
    };
  }
});

async function dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
  const context = { taskId: stringArg(args, 'taskId'), reason: stringArg(args, 'reason') };
  const build = {
    ...context,
    configuration: stringArg(args, 'configuration') as 'Debug' | 'DebugGame' | 'Development' | 'Shipping' | 'Test' | undefined,
    targetType: stringArg(args, 'targetType') as 'Editor' | 'Game' | 'Client' | 'Server' | undefined,
    platform: stringArg(args, 'platform') as 'Win64' | 'Linux' | 'Mac' | undefined,
  };
  switch (name) {
    case 'enginelink_get_environment': return service.getEnvironment();
    case 'enginelink_doctor': return service.doctor();
    case 'enginelink_build': return service.build(build);
    case 'enginelink_clean': return service.clean({ ...build, confirm: args.confirm === true });
    case 'enginelink_get_build_diagnostics': return service.getBuildDiagnostics();
    case 'enginelink_generate_compile_commands': return service.generateCompileCommands(build);
    case 'enginelink_get_editor_process': return service.getEditorProcess();
    case 'enginelink_launch_editor': return service.launchEditor(context);
    case 'enginelink_run_acceptance': return service.runAcceptance({
      ...context,
      tier: requiredString(args, 'tier'),
      evidenceNotes: stringArg(args, 'evidenceNotes'),
    });
    case 'enginelink_get_run': return service.getRun(requiredString(args, 'runId'));
    default: throw new Error(`Unknown EngineLink tool: ${name}`);
  }
}

function getOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  return typeof args[name] === 'string' ? args[name] as string : undefined;
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = stringArg(args, name);
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function toObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isFailedRun(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { schema?: unknown; success?: unknown };
  return candidate.schema === 'enginelink.run.v1' && candidate.success === false;
}

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`EngineLink MCP: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
