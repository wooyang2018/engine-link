import { describe, expect, it } from 'vitest';
import { calculateDoctorStatus, isSuccessfulDoctorStatus } from './status';
import type { DoctorIssue, DoctorRun } from './types';

describe('Doctor final status', () => {
  const coverage: DoctorRun['coverage'] = { editor: { status: 'completed' } };
  const issue = (severity: DoctorIssue['severity']): DoctorIssue => ({
    id: severity, ruleId: severity, severity, path: '/Game', evidence: 'e', recommendation: 'r',
  });

  it.each([
    [[], coverage, 'passed'],
    [[issue('P2')], coverage, 'passed_with_findings'],
    [[issue('P1')], coverage, 'failed'],
    [[], { editor: { status: 'unavailable' as const } }, 'incomplete'],
    [[], { editor: { status: 'incomplete' as const } }, 'incomplete'],
  ])('maps issues and coverage to %s', (issues, actualCoverage, expected) => {
    expect(calculateDoctorStatus({ issues, coverage: actualCoverage }).status).toBe(expected);
  });

  it('uses CLI success semantics for both passing states', () => {
    expect(isSuccessfulDoctorStatus('passed')).toBe(true);
    expect(isSuccessfulDoctorStatus('passed_with_findings')).toBe(true);
    expect(isSuccessfulDoctorStatus('failed')).toBe(false);
    expect(isSuccessfulDoctorStatus('incomplete')).toBe(false);
    expect(isSuccessfulDoctorStatus('running')).toBe(false);
  });
});
