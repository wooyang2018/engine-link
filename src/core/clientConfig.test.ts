import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { generateClientConfigs, registerCodexMcp } from './clientConfig';

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

  it('registers EngineLink in the project-local Codex config without replacing existing servers', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-codex-'));
    try {
      await fs.promises.mkdir(path.join(root, '.codex'), { recursive: true });
      await fs.promises.writeFile(
        path.join(root, '.codex', 'config.toml'),
        '[mcp_servers.unreal-mcp]\nurl = "http://127.0.0.1:8000/mcp"\n',
        'utf8',
      );

      const configPath = await registerCodexMcp({
        projectRoot: root,
        serverPath: 'D:/Tools/enginelink/mcp-server.js',
      });
      const first = await fs.promises.readFile(configPath, 'utf8');
      expect(first).toContain('[mcp_servers.unreal-mcp]');
      expect(first).toContain('[mcp_servers.enginelink]');
      expect(first).toContain('"D:/Tools/enginelink/mcp-server.js"');

      await registerCodexMcp({
        projectRoot: root,
        serverPath: 'D:/Tools/enginelink/updated-mcp-server.js',
      });
      const second = await fs.promises.readFile(configPath, 'utf8');
      expect(second.match(/\[mcp_servers\.enginelink\]/g)).toHaveLength(1);
      expect(second).toContain('"D:/Tools/enginelink/updated-mcp-server.js"');
      expect(second).not.toContain('D:/Tools/enginelink/mcp-server.js');
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
