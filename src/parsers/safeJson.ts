import * as crypto from 'crypto';

export type JsonEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be';

export interface SafeJsonMetadata {
  source: string;
  encoding: JsonEncoding;
  contentLength: number;
  sha256: string;
  extracted: boolean;
  summary: string;
}

export interface SafeJsonResult<T> extends SafeJsonMetadata {
  value: T;
}

export class SafeJsonError extends Error {
  constructor(
    message: string,
    readonly metadata: SafeJsonMetadata,
    readonly position?: number,
    readonly rawInput?: string | Buffer,
  ) {
    super(`${message} (source=${metadata.source}, encoding=${metadata.encoding}, position=${position ?? 'unknown'}, length=${metadata.contentLength}, sha256=${metadata.sha256}, summary=${metadata.summary})`);
    this.name = 'SafeJsonError';
  }
}

export function parseJsonInput<T = unknown>(input: string | Buffer, source = 'unknown'): SafeJsonResult<T> {
  const decoded = decodeJsonInput(input);
  const metadata: SafeJsonMetadata = {
    source,
    encoding: decoded.encoding,
    contentLength: decoded.text.length,
    sha256: crypto.createHash('sha256').update(Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')).digest('hex'),
    extracted: false,
    summary: redactSummary(decoded.text),
  };
  const trimmed = decoded.text.trim();
  if (!trimmed) throw new SafeJsonError('JSON input is empty', metadata, 0, input);

  try {
    return { ...metadata, value: JSON.parse(trimmed) as T };
  } catch (directError) {
    const extracted = extractBalancedJson(trimmed);
    if (extracted !== undefined && extracted !== trimmed) {
      try {
        return { ...metadata, extracted: true, value: JSON.parse(extracted) as T };
      } catch (extractedError) {
        throw jsonError(extractedError, { ...metadata, extracted: true }, input);
      }
    }
    throw jsonError(directError, metadata, input);
  }
}

export function parseJsonValue<T = unknown>(input: string | Buffer, source = 'unknown'): T {
  return parseJsonInput<T>(input, source).value;
}

function decodeJsonInput(input: string | Buffer): { text: string; encoding: JsonEncoding } {
  if (typeof input === 'string') {
    if (input.charCodeAt(0) === 0xfeff) return { text: input.slice(1), encoding: 'utf-8-bom' };
    return { text: input, encoding: 'utf-8' };
  }
  if (input.length >= 2 && input[0] === 0xff && input[1] === 0xfe) {
    return { text: input.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  }
  if (input.length >= 2 && input[0] === 0xfe && input[1] === 0xff) {
    const body = Buffer.from(input.subarray(2));
    for (let index = 0; index + 1 < body.length; index += 2) [body[index], body[index + 1]] = [body[index + 1], body[index]];
    return { text: body.toString('utf16le'), encoding: 'utf-16be' };
  }
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    return { text: input.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  return { text: input.toString('utf8'), encoding: 'utf-8' };
}

function extractBalancedJson(text: string): string | undefined {
  for (let start = 0; start < text.length; start++) {
    const first = text[start];
    if (first !== '{' && first !== '[') continue;
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        const open = stack.pop();
        if ((open === '{' && char !== '}') || (open === '[' && char !== ']')) break;
        if (stack.length === 0) return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

function jsonError(error: unknown, metadata: SafeJsonMetadata, rawInput: string | Buffer): SafeJsonError {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/position\s+(\d+)/i);
  return new SafeJsonError(`Invalid JSON: ${message}`, metadata, match ? Number(match[1]) : undefined, rawInput);
}

function redactSummary(text: string): string {
  return JSON.stringify(text.slice(0, 240)
    .replace(/("?(?:token|secret|password|api[-_]?key)"?\s*[:=]\s*")([^"]*)/gi, '$1[REDACTED]')
    .replace(/[\r\n\t]+/g, ' '));
}
