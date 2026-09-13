import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { ProjectDoctorLock } from './projectLock';

describe('Project Doctor project lock', () => {
  it('serializes runs and permits recovery from a stale lock', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-doctor-lock-'));
    try {
      const first = new ProjectDoctorLock(root);
      const second = new ProjectDoctorLock(root);
      await first.acquire('one');
      await expect(second.acquire('two')).rejects.toThrow('owns this project');
      await first.release();

      const file = path.join(root, 'Saved', 'EngineLink', 'doctor.lock');
      await fs.promises.writeFile(file, '{}', 'utf8');
      const old = new Date(Date.now() - 10_000);
      await fs.promises.utimes(file, old, old);
      const recovered = new ProjectDoctorLock(root, 1_000);
      await recovered.acquire('recovered');
      await recovered.release();
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
