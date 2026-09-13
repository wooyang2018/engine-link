import type { DoctorIssue, DoctorRun, DoctorStatus } from './types';

export function calculateDoctorStatus(run: Pick<DoctorRun, 'mode' | 'coverage' | 'issues'>): { status: Exclude<DoctorStatus, 'running' | 'cancelled'>; conclusion: string } {
  const requested = Object.values(run.coverage).filter((coverage) => coverage.status !== 'not-requested');
  const incomplete = requested.some((coverage) => coverage.status === 'unavailable' || coverage.status === 'incomplete');
  const failed = requested.some((coverage) => coverage.status === 'failed');
  const blocking = run.issues.some((issue) => issue.severity === 'P0' || issue.severity === 'P1');
  if (incomplete) return { status: 'incomplete', conclusion: 'One or more requested checks are incomplete, unavailable, or missing trustworthy evidence.' };
  if (failed || blocking) return { status: 'failed', conclusion: 'One or more executed checks failed or reported a P0/P1 blocking issue.' };
  if (run.issues.length > 0) return { status: 'passed_with_findings', conclusion: 'All requested checks completed, with non-blocking P2 findings.' };
  return {
    status: 'passed',
    conclusion: run.mode === 'preflight'
      ? 'All requested preflight checks passed.'
      : run.mode === 'changed'
        ? 'All requested static checks passed; runtime behavior was not requested.'
        : 'All requested runtime scenarios passed.',
  };
}

export function summarizeDoctor(run: Pick<DoctorRun, 'coverage' | 'issues'>): NonNullable<DoctorRun['summary']> {
  const counts = countIssues(run.issues);
  const requested = Object.values(run.coverage).filter((coverage) => coverage.status !== 'not-requested');
  const checksComplete = requested.length > 0 && requested.every((coverage) => coverage.status === 'completed' || coverage.status === 'failed');
  return {
    ...counts,
    total: run.issues.length,
    checksComplete,
    hasFindings: run.issues.length > 0,
    hasBlockingIssues: counts.p0 + counts.p1 > 0,
  };
}

export function isSuccessfulDoctorStatus(status: DoctorStatus): boolean {
  return status === 'passed' || status === 'passed_with_findings';
}

function countIssues(issues: DoctorIssue[]) {
  return {
    p0: issues.filter((issue) => issue.severity === 'P0').length,
    p1: issues.filter((issue) => issue.severity === 'P1').length,
    p2: issues.filter((issue) => issue.severity === 'P2').length,
    confirmed: issues.filter((issue) => issue.confidence === 'confirmed').length,
    unconfirmed: issues.filter((issue) => issue.confidence === 'unconfirmed').length,
    inferred: issues.filter((issue) => issue.confidence === 'inferred').length,
  };
}
