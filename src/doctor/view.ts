import * as path from 'path';
import type { DoctorFinalStatus, DoctorRun, DoctorView } from './types';

export function toDoctorView(run: DoctorRun): DoctorView {
  const coverage: DoctorView['coverage'] = {};
  for (const [name, item] of Object.entries(run.coverage)) {
    coverage[name] = { status: item.status, ...(item.detail ? { detail: item.detail } : {}) };
  }
  return {
    schema: 'enginelink.doctor-view.v1',
    status: run.status === 'running' ? 'incomplete' : run.status as DoctorFinalStatus,
    conclusion: run.conclusion,
    coverage,
    issues: run.issues.map((issue) => ({
      ruleId: issue.ruleId,
      severity: issue.severity,
      path: issue.path,
      evidence: issue.evidence,
      recommendation: issue.recommendation,
    })),
    reportPath: path.join(run.projectRoot, 'Saved', 'EngineLink', 'Doctor', 'Runs', run.id, 'report.md'),
  };
}
