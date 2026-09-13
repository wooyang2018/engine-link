import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseJsonValue } from '../parsers/safeJson';

export interface UnrealMcpGateway {
  listTools(): Promise<string[]>;
  call(name: string, args?: Record<string, unknown>, options?: { timeoutMs?: number; retry?: boolean }): Promise<McpToolOutput>;
  close(): Promise<void>;
}

export interface McpToolOutput {
  text: string;
  structured?: Record<string, unknown>;
  content: CallToolResult['content'];
  isError: boolean;
}

export class UnrealMcpClient implements UnrealMcpGateway {
  private client: Client | undefined;
  private connectPromise: Promise<void> | undefined;

  constructor(
    private readonly endpoint: string,
    private readonly connectTimeoutMs = 5_000,
    private readonly requestTimeoutMs = 60_000,
  ) {
    validateEndpoint(endpoint);
  }

  async listTools(): Promise<string[]> {
    await this.connect();
    const response = await this.client!.listTools(undefined, { timeout: this.requestTimeoutMs });
    return response.tools.map((tool) => tool.name);
  }

  async call(
    name: string,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number; retry?: boolean } = {},
  ): Promise<McpToolOutput> {
    const attempts = options.retry === false ? 1 : 2;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.connect();
        const result = await this.client!.callTool(
          { name, arguments: args },
          undefined,
          { timeout: options.timeoutMs ?? this.requestTimeoutMs },
        ) as CallToolResult;
        const textItems = result.content
          .filter((item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text')
          .map((item) => decodeTextEnvelope(item.text));
        const text = textItems.map((item) => item.text).join('\n');
        return {
          text,
          structured: result.structuredContent as Record<string, unknown> | undefined,
          content: result.content,
          isError: result.isError === true || textItems.some((item) => item.isError),
        };
      } catch (error) {
        lastError = error;
        await this.reset();
      }
    }
    throw lastError;
  }

  async close(): Promise<void> {
    await this.reset();
  }

  private async connect(): Promise<void> {
    if (this.client) return;
    if (!this.connectPromise) {
      this.connectPromise = this.open().finally(() => { this.connectPromise = undefined; });
    }
    await this.connectPromise;
  }

  private async open(): Promise<void> {
    const client = new Client({ name: 'enginelink-project-doctor', version: '0.3.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.endpoint));
    await withTimeout(client.connect(transport), this.connectTimeoutMs, 'Timed out connecting to Unreal MCP.');
    this.client = client;
  }

  private async reset(): Promise<void> {
    const current = this.client;
    this.client = undefined;
    if (current) await current.close().catch(() => undefined);
  }
}

function decodeTextEnvelope(text: string): { text: string; isError: boolean } {
  try {
    const value = parseJsonValue<{ success?: unknown; output?: unknown; error?: unknown }>(text, 'Unreal MCP text envelope');
    if (typeof value.output === 'string') return { text: value.output, isError: value.success === false };
    if (value.success === false && typeof value.error === 'string') return { text: value.error, isError: true };
  } catch {
    // Other MCP tools legitimately return plain text.
  }
  return { text, isError: false };
}

function validateEndpoint(value: string): void {
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('Unreal MCP endpoint must use HTTP or HTTPS.');
  }
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('Project Doctor MVP only permits a loopback Unreal MCP endpoint.');
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
