import * as fs from 'fs';
import * as path from 'path';

export type ClientName = 'codex' | 'cursor' | 'claude';
export type ClientMode = 'both' | 'enginelink' | 'unreal';

export interface GeneratedClientConfig {
  client: ClientName;
  path: string;
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
