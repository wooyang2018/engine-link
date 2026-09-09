import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { registerProjectMcpServers } from './clientRegistration';

describe('project MCP registration', () => {
  it('registers Cursor, Codex, and Claude without replacing existing servers', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-mcp-'));
    try {
      await fs.promises.mkdir(path.join(root, '.cursor'), { recursive: true });
      await fs.promises.writeFile(
        path.join(root, '.cursor', 'mcp.json'),
        JSON.stringify({ mcpServers: { unreal: { url: 'http://127.0.0.1:8000/mcp' } } }),
        'utf8',
      );
      await fs.promises.mkdir(path.join(root, '.codex'), { recursive: true });
      await fs.promises.writeFile(
        path.join(root, '.codex', 'config.toml'),
        '[mcp_servers.unreal-mcp]\nurl = "http://127.0.0.1:8000/mcp"\n',
        'utf8',
      );
      await fs.promises.writeFile(
        path.join(root, '.mcp.json'),
        JSON.stringify({ mcpServers: { unreal: { url: 'http://127.0.0.1:8000/mcp' } } }),
        'utf8',
      );

      const first = await registerProjectMcpServers({
        projectRoot: root,
        serverPath: 'D:\\Tools\\enginelink\\mcp-server.js',
      });

      const cursor = JSON.parse(await fs.promises.readFile(first.cursor, 'utf8')) as { mcpServers: Record<string, { args: string[] }> };
      const claude = JSON.parse(await fs.promises.readFile(first.claude, 'utf8')) as { mcpServers: Record<string, { args: string[] }> };
      const codex = await fs.promises.readFile(first.codex, 'utf8');
      expect(cursor.mcpServers.unreal).toBeDefined();
      expect(cursor.mcpServers.enginelink.args[0]).toBe('D:/Tools/enginelink/mcp-server.js');
      expect(claude.mcpServers.unreal).toBeDefined();
      expect(claude.mcpServers.enginelink.args[0]).toBe('D:/Tools/enginelink/mcp-server.js');
      expect(codex).toContain('[mcp_servers.unreal-mcp]');
      expect(codex).toContain('[mcp_servers.enginelink]');

      await registerProjectMcpServers({
        projectRoot: root,
        serverPath: 'D:\\Tools\\enginelink\\updated-mcp-server.js',
      });
      const updatedCodex = await fs.promises.readFile(first.codex, 'utf8');
      const updatedCursor = JSON.parse(await fs.promises.readFile(first.cursor, 'utf8')) as { mcpServers: Record<string, { args: string[] }> };
      expect(updatedCodex.match(/\[mcp_servers\.enginelink\]/g)).toHaveLength(1);
      expect(updatedCodex).toContain('D:/Tools/enginelink/updated-mcp-server.js');
      expect(updatedCursor.mcpServers.enginelink.args[0]).toBe('D:/Tools/enginelink/updated-mcp-server.js');
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
