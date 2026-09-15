import type { DoctorFinalStatus, DoctorRun, DoctorStatus } from './types';

export function calculateDoctorStatus(run: Pick<DoctorRun, 'coverage' | 'issues'>): { status: DoctorFinalStatus; conclusion: string } {
  const requested = Object.values(run.coverage);
  const incomplete = requested.some((coverage) => coverage.status === 'unavailable' || coverage.status === 'incomplete');
  const failed = requested.some((coverage) => coverage.status === 'failed');
  const blocking = run.issues.some((issue) => issue.severity === 'P0' || issue.severity === 'P1');
  if (incomplete) return { status: 'incomplete', conclusion: 'One or more requested checks are incomplete, unavailable, or missing trustworthy evidence.' };
  if (failed || blocking) return { status: 'failed', conclusion: 'One or more executed checks failed or reported a P0/P1 blocking issue.' };
  if (run.issues.length > 0) return { status: 'passed_with_findings', conclusion: 'All requested checks completed, with non-blocking P2 findings.' };
  return { status: 'passed', conclusion: 'All requested host, editor, and changed-scope checks passed.' };
}

export function isSuccessfulDoctorStatus(status: DoctorStatus): boolean {
  return status === 'passed' || status === 'passed_with_findings';
}
