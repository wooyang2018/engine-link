import * as path from 'path';

export type BuildCandidateStatus = 'succeeded' | 'failed' | 'running' | 'skipped' | 'blocked' | 'unknown';
export type BuildClassification = 'authoritative' | 'current' | 'stale' | 'historical' | 'blocked' | 'superseded';

export interface BuildEvidenceCandidate {
  source: string;
  status: BuildCandidateStatus;
  timestamp?: string;
  project?: string;
  editorPid?: number;
  sessionStartUtc?: string;
  raw: unknown;
  classifications: BuildClassification[];
  reason?: string;
}

export interface BuildEvidenceSelection extends Record<string, unknown> {
  authoritative: BuildEvidenceCandidate | null;
  history: BuildEvidenceCandidate[];
}

export interface BuildEvidenceContext {
  project: string;
  editorPid?: number;
  editorStartedAt?: string;
  sessionStartUtc?: string;
  readinessSessionStartUtc?: string;
  healthSessionStartUtc?: string;
  latestSourceTime?: string;
}

export function selectBuildEvidence(input: BuildEvidenceCandidate[], context: BuildEvidenceContext): BuildEvidenceSelection {
  const sessionTimes = [context.sessionStartUtc, context.readinessSessionStartUtc, context.healthSessionStartUtc].filter(Boolean).map(String);
  const parsedSessions = sessionTimes.map((value) => Date.parse(value)).filter(Number.isFinite);
  const sessionsAgree = parsedSessions.length < 2 || Math.max(...parsedSessions) - Math.min(...parsedSessions) <= 5_000;
  const evaluated = input.map((candidate) => evaluate(candidate, context, sessionsAgree));
  const eligible = evaluated.filter((candidate) => candidate.classifications.includes('current'))
    .sort((a, b) => timestamp(b) - timestamp(a));
  const authoritative = eligible[0] ?? null;
  if (authoritative) authoritative.classifications.unshift('authoritative');
  const history = evaluated.filter((candidate) => candidate !== authoritative);
  for (const candidate of history) {
    if (eligible.includes(candidate) && !candidate.classifications.includes('superseded')) candidate.classifications.push('superseded');
  }
  return { authoritative, history };
}

export function candidateFromRecord(source: string, raw: unknown): BuildEvidenceCandidate | undefined {
  if (!isRecord(raw)) return undefined;
  const blocked = isRecord(raw.details) && raw.details.blocked === true;
  const status = blocked ? 'blocked' : normalizeStatus(raw.status ?? raw.verdict ?? (typeof raw.success === 'boolean' ? (raw.success ? 'succeeded' : 'failed') : undefined));
  return {
    source, status,
    timestamp: stringValue(raw.completedAtIso ?? raw.finishedAt ?? raw.timestamp),
    project: stringValue(raw.projectFile ?? raw.project),
    editorPid: numberValue(raw.editorPid ?? (isRecord(raw.details) ? raw.details.editorPid : undefined)),
    sessionStartUtc: stringValue(raw.sessionStartUtc), raw, classifications: [],
  };
}

function evaluate(candidate: BuildEvidenceCandidate, context: BuildEvidenceContext, sessionsAgree: boolean): BuildEvidenceCandidate {
  const value = { ...candidate, classifications: [...candidate.classifications] };
  const time = timestamp(value);
  const session = Date.parse(context.sessionStartUtc ?? '');
  const source = Date.parse(context.latestSourceTime ?? '');
  if (value.status === 'blocked') return classify(value, 'blocked', 'Blocked build records are not build evidence.');
  if (value.status !== 'succeeded' && value.status !== 'failed') return classify(value, 'historical', `Build status '${value.status}' is not a completed real build.`);
  if (!value.project || normalizePath(value.project) !== normalizePath(context.project)) return classify(value, 'historical', 'Build project path does not match the current project.');
  if (!time) return classify(value, 'stale', 'Build timestamp is missing or invalid.');
  if (Number.isFinite(source) && source > time) return classify(value, 'stale', 'Project source is newer than this build.');
  if (!sessionsAgree) return classify(value, 'stale', 'Readiness, health, and environment session identities disagree.');
  if (context.editorPid !== undefined && value.editorPid !== undefined && value.editorPid !== context.editorPid) return classify(value, 'historical', 'Build Editor PID does not match the current Editor.');
  if (context.editorStartedAt && Date.parse(context.editorStartedAt) > time + 10 * 60_000) return classify(value, 'historical', 'Build predates the current process beyond the build-and-launch window.');
  if (Number.isFinite(session) && time < session - 10 * 60_000) return classify(value, 'historical', 'Build predates the current session beyond the build-and-launch window.');
  if (value.sessionStartUtc && context.sessionStartUtc && Math.abs(Date.parse(value.sessionStartUtc) - Date.parse(context.sessionStartUtc)) > 5_000) return classify(value, 'historical', 'Build session does not match the current session.');
  value.classifications.push('current');
  return value;
}

function classify(candidate: BuildEvidenceCandidate, classification: BuildClassification, reason: string): BuildEvidenceCandidate {
  candidate.classifications.push(classification);
  candidate.reason = reason;
  return candidate;
}

function normalizeStatus(value: unknown): BuildCandidateStatus {
  const status = String(value ?? '').toLowerCase();
  return ['succeeded', 'failed', 'running', 'skipped', 'blocked'].includes(status) ? status as BuildCandidateStatus : 'unknown';
}
function normalizePath(value: string): string { return path.resolve(value).replace(/\\/g, '/').toLowerCase(); }
function timestamp(candidate: BuildEvidenceCandidate): number { return Date.parse(candidate.timestamp ?? '') || 0; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
function numberValue(value: unknown): number | undefined { const number = Number(value); return Number.isFinite(number) ? number : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
