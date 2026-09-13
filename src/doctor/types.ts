export type DoctorMode = 'preflight' | 'changed' | 'scenario';
export type DoctorStatus = 'running' | 'passed' | 'passed_with_findings' | 'failed' | 'incomplete' | 'cancelled';
export type DoctorSeverity = 'P0' | 'P1' | 'P2';
export type DoctorConfidence = 'confirmed' | 'unconfirmed' | 'inferred';

export interface DoctorIssue {
  id: string;
  ruleId: string;
  severity: DoctorSeverity;
  path: string;
  evidence: string;
  impact: string;
  verification: string;
  recommendation: string;
  confidence: DoctorConfidence;
  discoveredAt: string;
  sessionId: string;
  source: string;
}

export interface DoctorStartOptions {
  mode?: DoctorMode;
  paths?: string[];
  referenceQueries?: string[];
  scenarioNames?: string[];
  baselineRunId?: string;
  taskId?: string;
  reason?: string;
}

export interface DoctorCoverage {
  status: 'completed' | 'unavailable' | 'incomplete' | 'failed' | 'not-requested';
  detail?: string;
  evidenceSource?: string;
  evidenceCandidates?: string[];
  parseWarnings?: string[];
  rawArtifacts?: string[];
}

export interface DoctorRun {
  schema: 'enginelink.doctor-run.v1';
  id: string;
  mode: DoctorMode;
  status: DoctorStatus;
  taskId?: string;
  reason?: string;
  startedAt: string;
  finishedAt?: string;
  project: string;
  projectRoot: string;
  requestedPaths: string[];
  referenceQueries: string[];
  scenarioNames: string[];
  ruleIds?: string[];
  baselineRunId?: string;
  progress: { phase: string; completed: number; total: number };
  coverage: Record<string, DoctorCoverage>;
  host?: Record<string, unknown>;
  editor: Record<string, unknown>;
  build: Record<string, unknown>;
  issues: DoctorIssue[];
  artifacts: string[];
  scenarios: DoctorScenarioResult[];
  comparison?: {
    resolved: string[];
    persisting: string[];
    introduced: string[];
    unverified: string[];
  };
  summary?: {
    total: number;
    p0: number;
    p1: number;
    p2: number;
    confirmed: number;
    unconfirmed: number;
    inferred: number;
    checksComplete: boolean;
    hasFindings: boolean;
    hasBlockingIssues: boolean;
  };
  conclusion?: string;
  error?: string;
}

export interface DoctorScenarioSpec {
  schema: 'enginelink.doctor-scenario.v1';
  name: string;
  map: string;
  clients: number;
  timeoutSeconds?: number;
  preflight?: { compile_blueprints?: string[] };
  steps: Array<Record<string, unknown>>;
  teardown?: { stop_pie?: boolean };
}

export interface DoctorScenarioResult {
  name: string;
  status: 'passed' | 'failed' | 'incomplete' | 'cancelled';
  map: string;
  clients: number;
  evidence?: Record<string, unknown>;
  artifacts: string[];
  error?: string;
}

export type DoctorRule =
  | DoctorRuleBase<'asset_exists', { asset: string }>
  | DoctorRuleBase<'asset_absent', { asset: string }>
  | DoctorRuleBase<'reference_exists', { from: string; to: string }>
  | DoctorRuleBase<'reference_absent', { from: string; to: string }>
  | DoctorRuleBase<'config_contains', { file: string; value: string }>
  | DoctorRuleBase<'config_absent', { file: string; value: string }>
  | DoctorRuleBase<'property_equals', { asset: string; property: string; expected: unknown }>
  | DoctorRuleBase<'blueprint_node_present', { asset: string; graph: string; node: string }>
  | DoctorRuleBase<'blueprint_node_absent', { asset: string; graph: string; node: string }>
  | DoctorRuleBase<'blueprint_path_reaches', { asset: string; graph: string; from: string; to: string }>;

interface DoctorRuleBase<K extends string, P> {
  id: string;
  kind: K;
  domain: string;
  severity: DoctorSeverity;
  description: string;
  params: P;
}

export interface UnrealScanResult {
  environment: Record<string, unknown>;
  editor: Record<string, unknown>;
  inventory: Array<{ path: string; class: string }>;
  references: Array<{ from: string; to: string; direction: 'dependency' | 'referencer'; resolved: boolean }>;
  blueprints: Array<{
    path: string;
    compileStatus: string;
    issues: Array<{ ruleId: string; severity: DoctorSeverity; confidence: DoctorConfidence; graph?: string; node?: string; evidence: string }>;
  }>;
  rules: Array<{ id: string; passed: boolean; confidence: DoctorConfidence; evidence: string; path: string }>;
}
