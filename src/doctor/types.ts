export const DEFAULT_DOCTOR_TIMEOUT_MS = 180_000;
export const DOCTOR_LOCK_STALE_MS = DEFAULT_DOCTOR_TIMEOUT_MS + 60_000;

export type DoctorFinalStatus = 'passed' | 'passed_with_findings' | 'failed' | 'incomplete';
export type DoctorStatus = 'running' | DoctorFinalStatus;
export type DoctorSeverity = 'P0' | 'P1' | 'P2';
export type DoctorCoverageStatus = 'completed' | 'unavailable' | 'incomplete' | 'failed';

export interface DoctorIssue {
  id: string;
  ruleId: string;
  severity: DoctorSeverity;
  path: string;
  evidence: string;
  recommendation: string;
}

export interface DoctorStartOptions {
  paths?: string[];
  timeoutMs?: number;
}

export interface DoctorCoverage {
  status: DoctorCoverageStatus;
  detail?: string;
}

export interface DoctorRun {
  schema: 'enginelink.doctor-run.v1';
  id: string;
  status: DoctorStatus;
  startedAt: string;
  finishedAt?: string;
  project: string;
  projectRoot: string;
  requestedPaths: string[];
  phase: string;
  coverage: Record<string, DoctorCoverage>;
  editor: Record<string, unknown>;
  build: Record<string, unknown>;
  issues: DoctorIssue[];
  conclusion?: string;
  error?: string;
}

export interface DoctorViewIssue {
  ruleId: string;
  severity: DoctorSeverity;
  path: string;
  evidence: string;
  recommendation: string;
}

export interface DoctorView {
  schema: 'enginelink.doctor-view.v1';
  status: DoctorFinalStatus;
  conclusion?: string;
  coverage: Record<string, DoctorCoverage>;
  issues: DoctorViewIssue[];
  reportPath: string;
}

export interface UnrealScanResult {
  editor: Record<string, unknown>;
  inventory: Array<{ path: string; class: string }>;
  references: Array<{ from: string; to: string; direction: 'dependency' | 'referencer'; resolved: boolean }>;
  blueprints: Array<{
    path: string;
    compileStatus: string;
    issues: Array<{ ruleId: string; severity: DoctorSeverity; graph?: string; node?: string; evidence: string }>;
  }>;
  missingTools: string[];
}
