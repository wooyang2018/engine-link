import { describe, expect, it } from 'vitest';
import { candidateFromRecord, selectBuildEvidence } from './buildEvidence';

const project = 'D:/Game/Game.uproject';
const current = { project, editorPid: 42, sessionStartUtc: '2026-09-13T10:00:00Z', latestSourceTime: '2026-09-13T09:00:00Z' };
const candidate = (source: string, status: string, time: string, extra = {}) => candidateFromRecord(source, { status, projectFile: project, completedAtIso: time, ...extra })!;

describe('authoritative build evidence', () => {
  it('lets a current success supersede an old failure', () => {
    const result = selectBuildEvidence([candidate('old', 'failed', '2026-09-13T08:00:00Z'), candidate('new', 'succeeded', '2026-09-13T10:01:00Z')], current);
    expect(result.authoritative?.source).toBe('new');
    expect(result.history[0].classifications).toContain('stale');
  });
  it('lets a current failure supersede an old success', () => {
    const result = selectBuildEvidence([candidate('old', 'succeeded', '2026-09-13T09:00:00Z'), candidate('new', 'failed', '2026-09-13T10:02:00Z')], current);
    expect(result.authoritative?.status).toBe('failed');
  });
  it('rejects different and reused PIDs and mismatched sessions', () => {
    expect(selectBuildEvidence([candidate('pid', 'succeeded', '2026-09-13T10:01:00Z', { editorPid: 7 })], current).authoritative).toBeNull();
    expect(selectBuildEvidence([candidate('session', 'succeeded', '2026-09-13T10:01:00Z', { sessionStartUtc: '2026-09-12T10:00:00Z' })], current).authoritative).toBeNull();
  });
  it('rejects blocked, stale-source, and missing current builds', () => {
    const blocked = candidateFromRecord('blocked', { success: false, project, finishedAt: '2026-09-13T10:01:00Z', details: { blocked: true } })!;
    expect(selectBuildEvidence([blocked], current).authoritative).toBeNull();
    expect(selectBuildEvidence([candidate('stale', 'succeeded', '2026-09-13T08:30:00Z')], current).authoritative).toBeNull();
    expect(selectBuildEvidence([], current).authoritative).toBeNull();
  });
});
