import { describe, expect, it } from 'vitest';
import { calculateDoctorStatus, isSuccessfulDoctorStatus, summarizeDoctor } from './status';
import type { DoctorIssue, DoctorRun } from './types';

describe('Doctor final status', () => {
  const coverage: DoctorRun['coverage'] = { editor: { status: 'completed' } };
  const issue = (severity: DoctorIssue['severity']): DoctorIssue => ({
    id: severity, ruleId: severity, severity, path: '/Game', evidence: 'e', impact: 'i', verification: 'v',
    recommendation: 'r', confidence: 'confirmed', discoveredAt: 'now', sessionId: 'run', source: 'test',
  });

  it.each([
    [[], coverage, 'passed'],
    [[issue('P2')], coverage, 'passed_with_findings'],
    [[issue('P1')], coverage, 'failed'],
    [[], { editor: { status: 'unavailable' as const } }, 'incomplete'],
    [[], { editor: { status: 'incomplete' as const } }, 'incomplete'],
  ])('maps issues and coverage to %s', (issues, actualCoverage, expected) => {
    expect(calculateDoctorStatus({ mode: 'changed', issues, coverage: actualCoverage }).status).toBe(expected);
  });

  it('reports completion and finding/blocking counts', () => {
    expect(summarizeDoctor({ coverage, issues: [issue('P1'), issue('P2')] })).toMatchObject({
      total: 2, checksComplete: true, hasFindings: true, hasBlockingIssues: true, p1: 1, p2: 1, confirmed: 2,
    });
  });

  it('uses CLI success semantics for both passing states', () => {
    expect(isSuccessfulDoctorStatus('passed')).toBe(true);
    expect(isSuccessfulDoctorStatus('passed_with_findings')).toBe(true);
    expect(isSuccessfulDoctorStatus('failed')).toBe(false);
    expect(isSuccessfulDoctorStatus('incomplete')).toBe(false);
    expect(isSuccessfulDoctorStatus('cancelled')).toBe(false);
  });
});
