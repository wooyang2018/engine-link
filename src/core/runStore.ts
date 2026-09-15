import * as fs from 'fs';
import * as path from 'path';
import { parseJsonValue } from '../parsers/safeJson';

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
  details?: Record<string, unknown>;
}

export class RunStore {
  constructor(private readonly projectRoot: string) {}

  async save(record: RunRecord): Promise<void> {
    if (record.kind !== 'build') return;
    const dir = path.join(this.projectRoot, 'Saved', 'EngineLink');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, 'latest-build.json'),
      JSON.stringify(record, null, 2),
      'utf8',
    );
  }

  async getLatest(kind = 'build'): Promise<RunRecord | undefined> {
    if (kind !== 'build') return undefined;
    const file = path.join(this.projectRoot, 'Saved', 'EngineLink', 'latest-build.json');
    return fs.promises.readFile(file).then(
      (text) => parseJsonValue<RunRecord>(text, file),
      () => undefined,
    );
  }
}

export function createRunId(kind: string): string {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${kind}-${Math.random().toString(16).slice(2, 10)}`;
}
