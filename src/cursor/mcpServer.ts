import * as fs from 'fs';
import * as path from 'path';
import type { EngineLinkContext } from '../types';
import type { EngineLinkSettings } from '../config/settings';
import { registerCodexMcp } from '../core/clientConfig';

/**
 * Register the independent EngineLink stdio server for Cursor.
 * Cursor owns the server process; the VS Code extension does not pre-spawn it or exchange IPC.
 */
export async function startMcpServer(
  extensionPath: string,
  ctx: EngineLinkContext,
  _settings: EngineLinkSettings,
): Promise<void> {
  if (!ctx.project) return;
  const serverPath = path.join(extensionPath, 'dist', 'mcp-server.js');
  try {
    await fs.promises.access(serverPath);
  } catch {
    ctx.outputChannel.appendLine('[EngineLink] Standalone MCP bundle not found; run npm run build.');
    return;
  }
  await registerInCursorConfig(ctx.project.projectRoot, serverPath);
  const codexConfigPath = await registerCodexMcp({
    projectRoot: ctx.project.projectRoot,
    serverPath,
  });
  ctx.outputChannel.appendLine('[EngineLink] Registered independent EngineLink MCP for Cursor.');
  ctx.outputChannel.appendLine(`[EngineLink] Registered EngineLink MCP for Codex: ${codexConfigPath}`);
}

/** Standalone MCP resolves its own context; extension state synchronization is intentionally absent. */
export function sendStateToMcp(_ctx: EngineLinkContext, _settings: EngineLinkSettings): void {}

/** Cursor owns the MCP process, so extension deactivation has nothing to stop. */
export function stopMcpServer(): void {}

async function registerInCursorConfig(projectRoot: string, serverPath: string): Promise<void> {
  const mcpConfigPath = path.join(projectRoot, '.cursor', 'mcp.json');
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await fs.promises.readFile(mcpConfigPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // Create a new configuration while preserving the Unreal MCP as a separate server when present.
  }
  const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>;
  mcpServers.enginelink = {
    command: 'node',
    args: [serverPath, '--project', projectRoot],
  };
  config.mcpServers = mcpServers;
  await fs.promises.mkdir(path.dirname(mcpConfigPath), { recursive: true });
  await fs.promises.writeFile(mcpConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}
