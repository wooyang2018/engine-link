import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DoctorStore } from './store';
import type { DoctorIssue, DoctorRun } from './types';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe('Doctor markdown report', () => {
  it('writes a slim summary and report without history JSON or events', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-store-'));
    roots.push(root);
    const issue = (severity: DoctorIssue['severity'], id: string): DoctorIssue => ({
      id, ruleId: id, severity, path: '/Game/Test', evidence: 'e', recommendation: 'r',
    });
    const run: DoctorRun = {
      schema: 'enginelink.doctor-run.v1', id: 'run-1', status: 'passed_with_findings', startedAt: '2026-09-13T00:00:00Z',
      finishedAt: '2026-09-13T00:00:01Z',
      project: 'D:/Game/Test.uproject', projectRoot: root, requestedPaths: ['/Game/Test'], phase: 'done',
      coverage: { build: { status: 'completed', detail: 'Authoritative EngineLink build succeeded.' } },
      editor: {}, build: { authoritative: { status: 'succeeded' }, history: [{ editorPid: 11028, status: 'failed' }] },
      issues: [issue('P2', 'a'), issue('P2', 'b')],
      conclusion: 'All requested checks completed, with non-blocking P2 findings.',
    };
    const store = new DoctorStore(root);
    await store.save(run);
    const dir = store.runDirectory(run.id);
    const report = await fs.promises.readFile(path.join(dir, 'report.md'), 'utf8');
    const summary = JSON.parse(await fs.promises.readFile(path.join(dir, 'summary.json'), 'utf8'));
    expect(report).toContain('Findings: 2 (P0 0, P1 0, P2 2)');
    expect(report).toContain('Read Coverage before Issues');
    expect(report).not.toContain('History');
    expect(report).not.toContain('editorPid');
    expect(report).not.toContain('EngineLink runtime');
    expect(report).not.toContain('Checks complete');
    expect(summary).toMatchObject({
      schema: 'enginelink.doctor-run.v1',
      status: 'passed_with_findings',
      requestedPaths: ['/Game/Test'],
    });
    expect(summary.issues).toHaveLength(2);
    expect(summary.issues[0]).toEqual({
      ruleId: 'a', severity: 'P2', path: '/Game/Test', evidence: 'e', recommendation: 'r',
    });
    expect(summary).not.toHaveProperty('progress');
    expect(summary).not.toHaveProperty('comparison');
    expect(summary).not.toHaveProperty('editor');
    expect(summary).not.toHaveProperty('build');
    expect(summary.issues[0]).not.toHaveProperty('id');
    await expect(fs.promises.access(path.join(dir, 'events.jsonl'))).rejects.toThrow();
  });
});
