import { describe, expect, it } from 'vitest';
import { resolveDoctorEvidence } from './evidence';
import type { McpToolOutput } from './unrealMcpClient';

const output = (text = '', structured?: Record<string, unknown>): McpToolOutput => ({ text, structured, content: text ? [{ type: 'text', text }] : [], isError: false });

describe('Doctor MCP evidence resolution', () => {
  it('uses the documented source priority', () => {
    expect(resolveDoctorEvidence(output('', { ok: true }), 'test').evidenceSource).toBe('structuredContent');
    expect(resolveDoctorEvidence(output('{"ok":true}'), 'test').evidenceSource).toBe('textJson');
    expect(resolveDoctorEvidence(output('plain'), 'test', { ok: true }).evidenceSource).toBe('persistedArtifact');
    expect(resolveDoctorEvidence(output('log\nENGINELINK_DOCTOR_RESULT={"ok":true}'), 'test').evidenceSource).toBe('marker');
  });

  it('keeps a broken lower-priority marker as a warning', () => {
    const result = resolveDoctorEvidence(output('ENGINELINK_DOCTOR_RESULT={bad', { ok: true }), 'test');
    expect(result.value).toEqual({ ok: true });
    expect(result.parseWarnings.length).toBeGreaterThan(0);
    expect(result.conflict).toBeUndefined();
  });

  it('reports conflicting valid sources', () => {
    const result = resolveDoctorEvidence(output('{"ok":false}', { ok: true }), 'test');
    expect(result.evidenceSource).toBe('structuredContent');
    expect(result.conflict).toContain('textJson');
  });
});
