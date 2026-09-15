import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StandaloneContext } from '../core/discovery';
import { applyHostChecks } from './hostChecks';
import type { DoctorRun } from './types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe('Project Doctor host checks', () => {
  it('records missing toolchain components as auditable issues', async () => {
    const ctx = await hostContext();
    const run = emptyRun(ctx);

    await applyHostChecks(ctx, run, {
      detectBuildTools: async () => undefined,
      detectClang: async () => false,
    });

    expect(run.coverage.host?.status).toBe('completed');
    expect(run.issues.some((issue) => issue.ruleId === 'host.build_tools')).toBe(true);
    expect(run.issues.some((issue) => issue.ruleId === 'host.clang')).toBe(true);
  });
});

async function hostContext(): Promise<StandaloneContext> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enginelink-host-'));
  roots.push(root);
  await fs.promises.writeFile(path.join(root, 'Game.uproject'), '{}', 'utf8');
  const engineRoot = path.join(root, 'FakeEngine');
  const ubtPath = path.join(engineRoot, 'Build.bat');
  const editorPath = path.join(engineRoot, 'UnrealEditor.exe');
  await fs.promises.mkdir(engineRoot, { recursive: true });
  await fs.promises.writeFile(ubtPath, '', 'utf8');
  await fs.promises.writeFile(editorPath, '', 'utf8');
  return {
    projectRoot: root,
    config: { schemaVersion: 1, uproject: 'Game.uproject' },
    project: {
      name: 'Game',
      uprojectPath: path.join(root, 'Game.uproject'),
      projectRoot: root,
      engineAssociation: '5.8',
      modules: [],
      targets: [],
    },
    engine: {
      version: '5.8',
      root: engineRoot,
      source: 'manual',
      ubtPath,
      editorPath,
      isSourceBuild: false,
    },
  };
}

function emptyRun(ctx: StandaloneContext): DoctorRun {
  return {
    schema: 'enginelink.doctor-run.v1',
    id: 'test-run',
    status: 'running',
    startedAt: new Date().toISOString(),
    project: ctx.project.uprojectPath,
    projectRoot: ctx.projectRoot,
    requestedPaths: [],
    phase: 'preflight',
    coverage: {},
    editor: {},
    build: {},
    issues: [],
  };
}
