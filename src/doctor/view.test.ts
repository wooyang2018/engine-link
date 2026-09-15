import { describe, expect, it } from 'vitest';
import type { DoctorRun } from './types';
import { toDoctorView } from './view';

describe('Doctor MCP view', () => {
  it('returns status, coverage, issues, and reportPath without run identity or issue ids', () => {
    const run: DoctorRun = {
      schema: 'enginelink.doctor-run.v1',
      id: 'run-1',
      status: 'failed',
      startedAt: '2026-09-14T00:00:00Z',
      project: 'D:/Game/Game.uproject',
      projectRoot: 'D:/Game',
      requestedPaths: ['/Game/BP/BP_Test'],
      phase: 'done',
      coverage: { host: { status: 'completed', detail: 'ok' } },
      editor: { pieRunning: false },
      build: { authoritative: { status: 'succeeded' } },
      issues: [{
        id: 'UEPD-HOST', ruleId: 'host.clang', severity: 'P2', path: 'D:/Game',
        evidence: 'clang missing', recommendation: 'Install clang-cl',
      }],
    };
    const view = toDoctorView(run);
    expect(view).toEqual({
      schema: 'enginelink.doctor-view.v1',
      status: 'failed',
      conclusion: undefined,
      coverage: { host: { status: 'completed', detail: 'ok' } },
      issues: [{
        ruleId: 'host.clang', severity: 'P2', path: 'D:/Game',
        evidence: 'clang missing', recommendation: 'Install clang-cl',
      }],
      reportPath: expect.stringContaining('report.md'),
    });
    expect(view).not.toHaveProperty('id');
    expect(view).not.toHaveProperty('progress');
    expect(view).not.toHaveProperty('summary');
    expect(view).not.toHaveProperty('comparison');
    expect(view).not.toHaveProperty('runDir');
    expect(view.issues[0]).not.toHaveProperty('id');
  });
});
