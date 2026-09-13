import * as fs from 'fs';
import * as path from 'path';

export class ProjectDoctorLock {
  private handle: fs.promises.FileHandle | undefined;
  private lockPath: string | undefined;

  constructor(private readonly projectRoot: string, private readonly staleMs = 10 * 60 * 1000) {}

  async acquire(runId: string): Promise<void> {
    const directory = path.join(this.projectRoot, 'Saved', 'EngineLink');
    const file = path.join(directory, 'doctor.lock');
    await fs.promises.mkdir(directory, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.handle = await fs.promises.open(file, 'wx');
        this.lockPath = file;
        await this.handle.writeFile(JSON.stringify({ pid: process.pid, runId, acquiredAt: new Date().toISOString() }), 'utf8');
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = await fs.promises.stat(file).catch(() => undefined);
        if (!stat || Date.now() - stat.mtimeMs <= this.staleMs) {
          throw new Error('Another EngineLink Project Doctor run owns this project.');
        }
        await fs.promises.rm(file, { force: true });
      }
    }
    throw new Error('Unable to acquire the Project Doctor lock.');
  }

  async release(): Promise<void> {
    if (!this.handle) return;
    const file = this.lockPath;
    await this.handle.close();
    this.handle = undefined;
    this.lockPath = undefined;
    if (file) await fs.promises.rm(file, { force: true });
  }
}
