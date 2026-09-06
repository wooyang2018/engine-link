import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { generateClientConfigs } from './clientConfig';

describe('client configuration generation', () => {
  it('keeps EngineLink and Unreal as independent MCP servers', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-clients-'));
    try {
      const generated = await generateClientConfigs({
        projectRoot: root,
        serverPath: 'D:/Tools/enginelink/mcp-server.js',
        clients: ['codex', 'cursor', 'claude'],
        mode: 'both',
      });
      expect(generated).toHaveLength(3);
      const cursor = JSON.parse(await fs.promises.readFile(path.join(root, '.enginelink', 'generated', 'cursor-mcp.json'), 'utf8'));
      expect(cursor.mcpServers.enginelink.command).toBe('node');
      expect(cursor.mcpServers.unreal.url).toBe('http://127.0.0.1:8000/mcp');
      const codex = await fs.promises.readFile(path.join(root, '.enginelink', 'generated', 'codex-config.toml'), 'utf8');
      expect(codex).toContain('[mcp_servers.enginelink]');
      expect(codex).toContain('[mcp_servers.unreal]');
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
