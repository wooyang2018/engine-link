import { describe, expect, it } from 'vitest';
import { UnrealMcpClient, withTimeout } from './unrealMcpClient';

describe('Unreal MCP client safety boundary', () => {
  it('accepts loopback and rejects remote endpoints', () => {
    expect(() => new UnrealMcpClient('http://127.0.0.1:8000/mcp')).not.toThrow();
    expect(() => new UnrealMcpClient('https://example.com/mcp')).toThrow('loopback');
    expect(() => new UnrealMcpClient('file:///tmp/mcp')).toThrow('HTTP');
  });

  it('bounds stalled operations with an explicit timeout', async () => {
    await expect(withTimeout(new Promise(() => undefined), 5, 'MCP timed out')).rejects.toThrow('MCP timed out');
  });
});
