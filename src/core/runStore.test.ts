import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from './runStore';

function record(kind: string): RunRecord {
  return {
    schema: 'enginelink.run.v1', id: `test-${kind}`, kind, taskId: 'task-1', reason: 'verify',
    startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z',
    success: true, durationMs: 1000, project: 'Game.uproject', engine: 'UE_5.8',
  };
}

describe('host-side run records', () => {
  it('persists only latest-build.json for build records', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-runs-'));
    try {
      const store = new RunStore(root);
      await store.save(record('build'));
      const latestPath = path.join(root, 'Saved', 'EngineLink', 'latest-build.json');
      expect(await fs.promises.readFile(latestPath, 'utf8')).toContain('"kind": "build"');
      await expect(fs.promises.access(path.join(root, 'Saved', 'EngineLink', 'Runs'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await store.getLatest('build'))?.taskId).toBe('task-1');
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('does not persist clean or launch records', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-runs-'));
    try {
      const store = new RunStore(root);
      await store.save(record('clean'));
      await store.save(record('launch'));
      await expect(fs.promises.access(path.join(root, 'Saved', 'EngineLink'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await store.getLatest('clean')).toBeUndefined();
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
