import * as fs from 'fs';
import * as path from 'path';
import type { DoctorRun } from './types';
import { parseJsonValue } from '../parsers/safeJson';

export class DoctorStore {
  constructor(private readonly projectRoot: string) {}

  async save(run: DoctorRun): Promise<void> {
    const dir = this.runDirectory(run.id);
    await fs.promises.mkdir(dir, { recursive: true });
    await atomicWrite(path.join(dir, 'summary.json'), JSON.stringify(run, null, 2));
    await atomicWrite(path.join(dir, 'report.md'), renderMarkdown(run));
    await atomicWrite(path.join(this.rootDirectory(), 'latest.json'), JSON.stringify(run, null, 2));
  }

  async appendEvent(runId: string, event: Record<string, unknown>): Promise<void> {
    const dir = this.runDirectory(runId);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.appendFile(
      path.join(dir, 'events.jsonl'),
      JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n',
      'utf8',
    );
  }

  async writeArtifact(runId: string, name: string, value: unknown): Promise<string> {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`Invalid artifact name: ${name}`);
    const file = path.join(this.runDirectory(runId), name);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return file;
  }

  async get(runId: string): Promise<DoctorRun> {
    validateRunId(runId);
    const file = path.join(this.runDirectory(runId), 'summary.json');
    return parseJsonValue<DoctorRun>(await fs.promises.readFile(file), file);
  }

  runDirectory(runId: string): string {
    validateRunId(runId);
    return path.join(this.rootDirectory(), runId);
  }

  private rootDirectory(): string {
    return path.join(this.projectRoot, 'Saved', 'EngineLink', 'Doctor', 'Runs');
  }
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

function renderMarkdown(run: DoctorRun): string {
  const counts = {
    total: run.issues.length,
    p0: run.issues.filter((issue) => issue.severity === 'P0').length,
    p1: run.issues.filter((issue) => issue.severity === 'P1').length,
    p2: run.issues.filter((issue) => issue.severity === 'P2').length,
    confirmed: run.issues.filter((issue) => issue.confidence === 'confirmed').length,
    inferred: run.issues.filter((issue) => issue.confidence === 'inferred').length,
    unconfirmed: run.issues.filter((issue) => issue.confidence === 'unconfirmed').length,
  };
  const history = Array.isArray(run.build.history) ? run.build.history : [];
  const lines = [
    `# EngineLink Project Doctor ${run.id}`,
    '',
    `- Status: ${run.status}`,
    `- Mode: ${run.mode}`,
    `- Project: ${run.project}`,
    `- Started: ${run.startedAt}`,
    `- Finished: ${run.finishedAt ?? 'running'}`,
    `- Conclusion: ${run.conclusion ?? 'Pending'}`,
    `- Checks complete: ${run.summary?.checksComplete ?? false}`,
    `- Findings: ${counts.total} (P0 ${counts.p0}, P1 ${counts.p1}, P2 ${counts.p2})`,
    `- Confidence: confirmed ${counts.confirmed}, inferred ${counts.inferred}, unconfirmed ${counts.unconfirmed}`,
    `- Blocking issues: ${run.summary?.hasBlockingIssues ?? false}`,
    '',
    '## EngineLink runtime',
    '',
    `- Identity: ${JSON.stringify(run.engineLink ?? null)}`,
    '',
    '## Coverage',
    '',
    ...Object.entries(run.coverage).map(([name, coverage]) => `- ${name}: ${coverage.status}${coverage.detail ? ` — ${coverage.detail}` : ''}`),
    '',
    '## Build evidence',
    '',
    `- Authoritative: ${JSON.stringify(run.build.authoritative ?? null)}`,
    '',
    `<details><summary>History (${history.length} candidates)</summary>`,
    '',
    '```json',
    JSON.stringify(history, null, 2),
    '```',
    '',
    '</details>',
    '',
    '## Scenarios',
    '',
    ...(run.scenarios.length ? run.scenarios.map((scenario) => `- ${scenario.name}: ${scenario.status}${scenario.error ? ` — ${scenario.error}` : ''}`) : ['No scenarios requested.']),
    '',
    '## Issues',
    '',
  ];
  if (run.issues.length === 0) lines.push('No issues recorded. This does not prove unexecuted checks are correct.', '');
  for (const issue of run.issues) {
    lines.push(
      `### ${issue.severity} ${issue.id}`,
      '',
      `- Path: ${issue.path}`,
      `- Confidence: ${issue.confidence}`,
      `- Evidence: ${issue.evidence}`,
      `- Impact: ${issue.impact}`,
      `- Verify: ${issue.verification}`,
      `- Recommendation: ${issue.recommendation}`,
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}
