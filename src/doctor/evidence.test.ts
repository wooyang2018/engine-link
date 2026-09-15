import { describe, expect, it } from 'vitest';
import { resolveDoctorEvidence } from './evidence';
import type { McpToolOutput } from './unrealMcpClient';

const output = (text = '', structured?: Record<string, unknown>): McpToolOutput => ({ text, structured, content: text ? [{ type: 'text', text }] : [], isError: false });

describe('Doctor MCP evidence resolution', () => {
  it('uses structuredContent then text JSON', () => {
    expect(resolveDoctorEvidence(output('', { ok: true }), 'test').evidenceSource).toBe('structuredContent');
    expect(resolveDoctorEvidence(output('{"ok":true}'), 'test').evidenceSource).toBe('textJson');
  });

  it('does not parse print markers as evidence', () => {
    expect(() => resolveDoctorEvidence(output('log\nENGINELINK_DOCTOR_RESULT={"ok":true}'), 'test')).toThrow(/No usable Doctor evidence/);
  });

  it('reports conflicting valid sources', () => {
    const result = resolveDoctorEvidence(output('{"ok":false}', { ok: true }), 'test');
    expect(result.evidenceSource).toBe('structuredContent');
    expect(result.conflict).toContain('textJson');
  });
});
