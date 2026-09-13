import { describe, expect, it } from 'vitest';
import { parseJsonInput, parseJsonValue, SafeJsonError } from './safeJson';

describe('safe JSON parser', () => {
  it('accepts UTF-8 and UTF-16 BOM input', () => {
    expect(parseJsonInput<Record<string, number>>(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('{"ok":1}')]), 'utf8').value.ok).toBe(1);
    expect(parseJsonInput<Record<string, number>>(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"ok":2}', 'utf16le')]), 'utf16le').value.ok).toBe(2);
    const be = Buffer.from('{"ok":3}', 'utf16le');
    for (let index = 0; index < be.length; index += 2) [be[index], be[index + 1]] = [be[index + 1], be[index]];
    expect(parseJsonInput<Record<string, number>>(Buffer.concat([Buffer.from([0xfe, 0xff]), be]), 'utf16be').value.ok).toBe(3);
  });

  it('extracts balanced JSON from CRLF log wrappers', () => {
    const result = parseJsonInput<Record<string, boolean>>('prefix\r\nnoise {"ok":true}\r\nsuffix', 'mcp');
    expect(result.value.ok).toBe(true);
    expect(result.extracted).toBe(true);
  });

  it('reports source, encoding, position, length, digest, and redacted summary', () => {
    expect(() => parseJsonValue('', 'empty.json')).toThrow(SafeJsonError);
    try { parseJsonValue('{"token":"secret","bad":}', 'broken.json'); } catch (error) {
      expect(String(error)).toContain('source=broken.json');
      expect(String(error)).toContain('sha256=');
      expect(String(error)).not.toContain('"secret"');
    }
  });
});
