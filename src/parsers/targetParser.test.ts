import { describe, expect, it } from 'vitest';
import { pickTargetForType } from './targetParser';
import type { UEProject } from '../types';

function makeLyraProject(targets: UEProject['targets']): UEProject {
  return {
    name: 'LyraStarterGame',
    uprojectPath: 'D:/Workspace/extraction-ops/LyraStarterGame.uproject',
    projectRoot: 'D:/Workspace/extraction-ops',
    engineAssociation: '5.8',
    modules: [
      { name: 'LyraGame', type: 'Runtime', loadingPhase: 'Default' },
      { name: 'LyraEditor', type: 'Editor', loadingPhase: 'Default' },
    ],
    targets,
  };
}

describe('pickTargetForType', () => {
  it('uses conventional names when they exist', () => {
    const project: UEProject = {
      name: 'MyGame',
      uprojectPath: 'D:/Projects/MyGame/MyGame.uproject',
      projectRoot: 'D:/Projects/MyGame',
      engineAssociation: '5.8',
      modules: [{ name: 'MyGame', type: 'Runtime', loadingPhase: 'Default' }],
      targets: [
        {
          name: 'MyGameEditor',
          type: 'Editor',
          targetFile: 'D:/Projects/MyGame/Source/MyGameEditor.Target.cs',
        },
      ],
    };

    expect(pickTargetForType(project, 'Editor')).toBe('MyGameEditor');
  });

  it('resolves Lyra editor target from discovered .Target.cs files', () => {
    const project = makeLyraProject([
      {
        name: 'LyraEditor',
        type: 'Editor',
        targetFile: 'D:/Workspace/extraction-ops/Source/LyraEditor.Target.cs',
      },
      {
        name: 'LyraGame',
        type: 'Game',
        targetFile: 'D:/Workspace/extraction-ops/Source/LyraGame.Target.cs',
      },
      {
        name: 'LyraGameSteam',
        type: 'Game',
        targetFile: 'D:/Workspace/extraction-ops/Source/LyraGameSteam.Target.cs',
      },
    ]);

    expect(pickTargetForType(project, 'Editor')).toBe('LyraEditor');
    expect(pickTargetForType(project, 'Game')).toBe('LyraGame');
  });

  it('falls back to project name when no targets are discovered', () => {
    const project = makeLyraProject([]);

    expect(pickTargetForType(project, 'Editor')).toBe('LyraStarterGameEditor');
    expect(pickTargetForType(project, 'Game')).toBe('LyraStarterGame');
  });
});
