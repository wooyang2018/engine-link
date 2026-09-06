import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from './runStore';

describe('host-side run records', () => {
  it('persists summaries and output without depending on Unreal MCP', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-runs-'));
    try {
      const store = new RunStore(root);
      const record: RunRecord = {
        schema: 'enginelink.run.v1', id: 'test-build', kind: 'build', taskId: 'task-1', reason: 'verify',
        startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z',
        success: true, durationMs: 1000, project: 'Game.uproject', engine: 'UE_5.8',
      };
      await store.save(record, 'build output');
      expect(await store.get('test-build')).toEqual(record);
      expect((await store.getLatest('build'))?.taskId).toBe('task-1');
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
