import * as fs from 'fs';
import * as path from 'path';

export interface ProjectMcpRegistrationOptions {
  projectRoot: string;
  serverPath: string;
}

export interface ProjectMcpRegistrationResult {
  cursor: string;
  codex: string;
  claude: string;
}

interface JsonMcpServer {
  command: string;
  args: string[];
}

/**
 * Register EngineLink for every supported AI client when the Cursor extension
 * activates in an Unreal project.
 *
 * Each client owns its project-level configuration format. The registration is
 * deliberately idempotent and only replaces the EngineLink entry, preserving
 * unrelated MCP servers configured by the user or the Unreal MCP extension.
 */
export async function registerProjectMcpServers(
  options: ProjectMcpRegistrationOptions,
): Promise<ProjectMcpRegistrationResult> {
  const server = createStdioServer(options);
  const [cursor, codex, claude] = await Promise.all([
    registerJsonMcp(path.join(options.projectRoot, '.cursor', 'mcp.json'), server),
    registerCodexMcp(path.join(options.projectRoot, '.codex', 'config.toml'), server),
    registerJsonMcp(path.join(options.projectRoot, '.mcp.json'), server),
  ]);

  return { cursor, codex, claude };
}

function createStdioServer(options: ProjectMcpRegistrationOptions): JsonMcpServer {
  return {
    command: 'node',
    args: [normalizePath(options.serverPath), '--project', normalizePath(options.projectRoot)],
  };
}

async function registerJsonMcp(configPath: string, server: JsonMcpServer): Promise<string> {
  let config: Record<string, unknown> = {};
  const existing = await readOptionalFile(configPath);
  if (existing !== undefined) {
    const parsed = JSON.parse(existing) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`MCP configuration must be a JSON object: ${configPath}`);
    }
    config = parsed;
  }

  let mcpServers: Record<string, unknown>;
  if (config.mcpServers === undefined) {
    mcpServers = {};
  } else if (isRecord(config.mcpServers)) {
    mcpServers = config.mcpServers;
  } else {
    throw new Error(`mcpServers must be an object: ${configPath}`);
  }
  mcpServers.enginelink = server;
  config.mcpServers = mcpServers;

  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return configPath;
}

async function registerCodexMcp(
  configPath: string,
  server: JsonMcpServer,
): Promise<string> {
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });

  const existing = await readOptionalFile(configPath) ?? '';

  const section = '[mcp_servers.enginelink]';
  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  const sectionIndex = lines.findIndex((line) => line.trim() === section);
  const entry = [
    section,
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(', ')}]`,
  ];

  if (sectionIndex >= 0) {
    let sectionEnd = lines.length;
    for (let index = sectionIndex + 1; index < lines.length; index += 1) {
      if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
        sectionEnd = index;
        break;
      }
    }

    const sectionBody = lines.slice(sectionIndex + 1, sectionEnd)
      .filter((line) => !/^\s*(command|args)\s*=/.test(line));
    lines.splice(sectionIndex, sectionEnd - sectionIndex, ...[...entry, ...sectionBody]);
  } else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push(...entry);
  }

  await fs.promises.writeFile(configPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
  return configPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
