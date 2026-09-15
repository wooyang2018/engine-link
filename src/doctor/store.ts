import type { DoctorCoverage, DoctorRun, DoctorViewIssue } from './types';
import * as fs from 'fs';
import * as path from 'path';

export interface DoctorPersistedRun {
  schema: 'enginelink.doctor-run.v1';
  id: string;
  status: DoctorRun['status'];
  startedAt: string;
  finishedAt?: string;
  project: string;
  projectRoot: string;
  requestedPaths: string[];
  coverage: Record<string, DoctorCoverage>;
  issues: DoctorViewIssue[];
  conclusion?: string;
  error?: string;
}

export class DoctorStore {
  constructor(private readonly projectRoot: string) {}

  async save(run: DoctorRun): Promise<void> {
    const persisted = persistable(run);
    const dir = this.runDirectory(run.id);
    await fs.promises.mkdir(dir, { recursive: true });
    await atomicWrite(path.join(dir, 'summary.json'), JSON.stringify(persisted, null, 2));
    await atomicWrite(path.join(dir, 'report.md'), renderMarkdown(persisted));
    await atomicWrite(path.join(this.rootDirectory(), 'latest.json'), JSON.stringify(persisted, null, 2));
  }

  async writeArtifact(runId: string, name: string, value: unknown): Promise<string> {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`Invalid artifact name: ${name}`);
    const file = path.join(this.runDirectory(runId), name);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return file;
  }

  runDirectory(runId: string): string {
    validateRunId(runId);
    return path.join(this.rootDirectory(), runId);
  }

  private rootDirectory(): string {
    return path.join(this.projectRoot, 'Saved', 'EngineLink', 'Doctor', 'Runs');
  }
}

export function persistable(run: DoctorRun): DoctorPersistedRun {
  const coverage: Record<string, DoctorCoverage> = {};
  for (const [name, item] of Object.entries(run.coverage)) {
    coverage[name] = { status: item.status, ...(item.detail ? { detail: item.detail } : {}) };
  }
  return {
    schema: run.schema,
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    project: run.project,
    projectRoot: run.projectRoot,
    requestedPaths: run.requestedPaths,
    coverage,
    issues: run.issues.map(({ ruleId, severity, path: issuePath, evidence, recommendation }) => ({
      ruleId, severity, path: issuePath, evidence, recommendation,
    })),
    conclusion: run.conclusion,
    error: run.error,
  };
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, content, 'utf8');
  await fs.promises.rename(temporary, file).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    await fs.promises.rm(file, { force: true });
    await fs.promises.rename(temporary, file);
  });
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(runId)) throw new Error('Invalid doctor run id');
}

function renderMarkdown(run: DoctorPersistedRun): string {
  const counts = {
    total: run.issues.length,
    p0: run.issues.filter((issue) => issue.severity === 'P0').length,
    p1: run.issues.filter((issue) => issue.severity === 'P1').length,
    p2: run.issues.filter((issue) => issue.severity === 'P2').length,
  };
  const lines = [
    `# EngineLink Project Doctor`,
    '',
    `- Status: ${run.status}`,
    `- Project: ${run.project}`,
    `- Started: ${run.startedAt}`,
    `- Finished: ${run.finishedAt ?? 'running'}`,
    `- Conclusion: ${run.conclusion ?? 'Pending'}`,
    `- Findings: ${counts.total} (P0 ${counts.p0}, P1 ${counts.p1}, P2 ${counts.p2})`,
    '',
    'Read Coverage before Issues. incomplete means a requested check did not run; an empty issue list is not a project pass.',
    '',
    '## Coverage',
    '',
    ...Object.entries(run.coverage).map(([name, coverage]) => `- ${name}: ${coverage.status}${coverage.detail ? ` — ${coverage.detail}` : ''}`),
    '',
    '## Issues',
    '',
  ];
  if (run.issues.length === 0) lines.push('No issues recorded. This does not prove unexecuted checks are correct.', '');
  for (const issue of run.issues) {
    lines.push(
      `### ${issue.severity} ${issue.ruleId}`,
      '',
      `- Path: ${issue.path}`,
      `- Evidence: ${issue.evidence}`,
      `- Recommendation: ${issue.recommendation}`,
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}
