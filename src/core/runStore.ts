import * as fs from 'fs';
import * as path from 'path';

export interface RunRecord {
  schema: 'enginelink.run.v1';
  id: string;
  kind: string;
  taskId?: string;
  reason?: string;
  startedAt: string;
  finishedAt: string;
  success: boolean;
  command?: { executable: string; args: string[] };
  exitCode?: number;
  durationMs: number;
  project: string;
  engine: string;
  diagnostics?: unknown[];
  evidencePath?: string;
  details?: Record<string, unknown>;
}

export class RunStore {
  constructor(private readonly projectRoot: string) {}

  async save(record: RunRecord, rawOutput = ''): Promise<void> {
    const dir = path.join(this.projectRoot, 'Saved', 'EngineLink', 'Runs', record.id);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'summary.json'), JSON.stringify(record, null, 2), 'utf8');
    if (rawOutput) await fs.promises.writeFile(path.join(dir, 'output.log'), rawOutput, 'utf8');
    await fs.promises.writeFile(
      path.join(this.projectRoot, 'Saved', 'EngineLink', `latest-${record.kind}.json`),
      JSON.stringify(record, null, 2),
      'utf8',
    );
  }

  async get(id: string): Promise<RunRecord> {
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error('Invalid run id');
    const file = path.join(this.projectRoot, 'Saved', 'EngineLink', 'Runs', id, 'summary.json');
    return JSON.parse(await fs.promises.readFile(file, 'utf8')) as RunRecord;
  }

  async getLatest(kind: string): Promise<RunRecord | undefined> {
    const file = path.join(this.projectRoot, 'Saved', 'EngineLink', `latest-${kind}.json`);
    return fs.promises.readFile(file, 'utf8').then(
      (text) => JSON.parse(text) as RunRecord,
      () => undefined,
    );
  }
}

export function createRunId(kind: string): string {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${kind}-${Math.random().toString(16).slice(2, 10)}`;
}
