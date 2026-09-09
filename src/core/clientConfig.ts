import * as fs from 'fs';
import * as path from 'path';

export type ClientName = 'codex' | 'cursor' | 'claude';
export type ClientMode = 'both' | 'enginelink' | 'unreal';

export interface GeneratedClientConfig {
  client: ClientName;
  path: string;
}

export interface CodexMcpRegistrationOptions {
  projectRoot: string;
  serverPath: string;
}

export async function generateClientConfigs(options: {
  projectRoot: string;
  serverPath: string;
  clients: ClientName[];
  mode: ClientMode;
  unrealUrl?: string;
}): Promise<GeneratedClientConfig[]> {
  const outputRoot = path.join(options.projectRoot, '.enginelink', 'generated');
  await fs.promises.mkdir(outputRoot, { recursive: true });
  const results: GeneratedClientConfig[] = [];

  for (const client of options.clients) {
    const outputPath = path.join(outputRoot, client === 'codex' ? 'codex-config.toml' : `${client}-mcp.json`);
    const content = client === 'codex'
      ? renderCodex(options)
      : JSON.stringify({ mcpServers: jsonServers(options) }, null, 2) + '\n';
    await fs.promises.writeFile(outputPath, content, 'utf8');
    results.push({ client, path: outputPath });
  }
  return results;
}

/**
 * Register EngineLink in the project-local Codex configuration.
 *
 * Codex uses TOML configuration for project-scoped MCP servers. Keep existing
 * server sections intact and make this operation idempotent so extension
 * activation and the CLI can safely call it more than once.
 */
export async function registerCodexMcp(options: CodexMcpRegistrationOptions): Promise<string> {
  const codexDirectory = path.join(options.projectRoot, '.codex');
  const configPath = path.join(codexDirectory, 'config.toml');
  await fs.promises.mkdir(codexDirectory, { recursive: true });

  let existing = '';
  try {
    existing = await fs.promises.readFile(configPath, 'utf8');
  } catch {
    // A missing project config is normal on first registration.
  }

  const section = '[mcp_servers.enginelink]';
  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  const sectionIndex = lines.findIndex((line) => line.trim() === section);
  const entry = [
    section,
    `command = ${tomlString('node')}`,
    `args = [${[options.serverPath, '--project', options.projectRoot].map(tomlString).join(', ')}]`,
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
    lines.splice(sectionIndex, sectionEnd - sectionIndex, ...[section, ...entry.slice(1), ...sectionBody]);
  } else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push(...entry);
  }

  await fs.promises.writeFile(configPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
  return configPath;
}

function jsonServers(options: { projectRoot: string; serverPath: string; mode: ClientMode; unrealUrl?: string }) {
  const servers: Record<string, unknown> = {};
  if (options.mode !== 'unreal') {
    servers.enginelink = { command: 'node', args: [options.serverPath, '--project', options.projectRoot] };
  }
  if (options.mode !== 'enginelink') servers.unreal = { url: options.unrealUrl ?? 'http://127.0.0.1:8000/mcp' };
  return servers;
}

function renderCodex(options: { projectRoot: string; serverPath: string; mode: ClientMode; unrealUrl?: string }): string {
  const lines: string[] = [];
  if (options.mode !== 'unreal') {
    lines.push('[mcp_servers.enginelink]');
    lines.push(`command = ${tomlString('node')}`);
    lines.push(`args = [${[options.serverPath, '--project', options.projectRoot].map(tomlString).join(', ')}]`);
    lines.push('');
  }
  if (options.mode !== 'enginelink') {
    lines.push('[mcp_servers.unreal]');
    lines.push(`url = ${tomlString(options.unrealUrl ?? 'http://127.0.0.1:8000/mcp')}`);
    lines.push('');
  }
  return lines.join('\n');
}

function tomlString(value: string): string {
  return JSON.stringify(value.replace(/\\/g, '/'));
}
