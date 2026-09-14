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
  it('derives severity totals from final issues and folds build history', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-store-'));
    roots.push(root);
    const issue = (severity: DoctorIssue['severity'], confidence: DoctorIssue['confidence'], id: string): DoctorIssue => ({
      id, ruleId: id, severity, confidence, path: '/Game/Test', evidence: 'e', impact: 'i', verification: 'v', recommendation: 'r',
      discoveredAt: '2026-09-13T00:00:00Z', sessionId: 'session', source: 'test',
    });
    const run: DoctorRun = {
      schema: 'enginelink.doctor-run.v1', id: 'run-1', mode: 'changed', status: 'passed_with_findings', startedAt: '2026-09-13T00:00:00Z',
      project: 'D:/Game/Test.uproject', projectRoot: root, requestedPaths: [], referenceQueries: [], scenarioNames: [], progress: { phase: 'done', completed: 1, total: 1 },
      coverage: {}, engineLink: { version: '0.2.1', serverPid: 42 }, editor: {}, build: { authoritative: { status: 'succeeded' }, history: [{ editorPid: 11028, status: 'failed' }] },
      issues: [issue('P2', 'confirmed', 'a'), issue('P2', 'inferred', 'b')], artifacts: [], scenarios: [],
      summary: { total: 14, p0: 9, p1: 9, p2: 14, confirmed: 0, inferred: 0, unconfirmed: 0, checksComplete: true, hasFindings: true, hasBlockingIssues: false },
    };
    const store = new DoctorStore(root);
    await store.save(run);
    const report = await fs.promises.readFile(path.join(store.runDirectory(run.id), 'report.md'), 'utf8');
    expect(report).toContain('Findings: 2 (P0 0, P1 0, P2 2)');
    expect(report).toContain('Confidence: confirmed 1, inferred 1, unconfirmed 0');
    expect(report).toContain('<details><summary>History (1 candidates)</summary>');
    expect(report).toContain('"editorPid": 11028');
    expect(report).toContain('EngineLink runtime');
  });
});
