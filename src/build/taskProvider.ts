import * as vscode from 'vscode';
import { buildCommandLine, cleanCommandLine } from './ubt';
import { EXTENSION_ID } from '../constants';
import type { EngineLinkContext, EngineLinkTaskDefinition, BuildConfiguration, BuildTargetType, BuildPlatform } from '../types';
import { EngineLinkSettings } from '../config/settings';

/**
 * Task provider for EngineLink build tasks.
 */
export class EngineLinkTaskProvider implements vscode.TaskProvider<vscode.Task> {
  static readonly type = EXTENSION_ID;

  constructor(
    private ctx: EngineLinkContext,
    private settings: EngineLinkSettings,
  ) {}

  provideTasks(): vscode.ProviderResult<vscode.Task[]> {
    if (!this.ctx.project || !this.ctx.engine) return [];

    const config = this.settings.buildConfiguration;
    const target = this.settings.buildTarget;
    const platform = this.settings.platform;

    try {
      return [
        this.createTask('build', `Build (${config} ${target})`, config, target, platform),
        this.createTask('clean', 'Clean', config, target, platform),
        this.createTask('generateCompileCommands', 'Generate compile_commands.json', config, target, platform),
      ];
    } catch (error) {
      this.ctx.outputChannel.appendLine(`[EngineLink] ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  resolveTask(task: vscode.Task): vscode.ProviderResult<vscode.Task> {
    const definition = task.definition as EngineLinkTaskDefinition;
    if (!this.ctx.project || !this.ctx.engine) return undefined;

    const config = definition.configuration ?? this.settings.buildConfiguration;
    const target = definition.targetType ?? this.settings.buildTarget;
    const platform = definition.platform ?? this.settings.platform;

    try {
      return this.createTask(definition.action, task.name, config, target, platform);
    } catch (error) {
      this.ctx.outputChannel.appendLine(`[EngineLink] ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private createTask(
    action: string,
    label: string,
    config: BuildConfiguration,
    target: BuildTargetType,
    platform: BuildPlatform,
  ): vscode.Task {
    const definition: EngineLinkTaskDefinition = {
      type: EXTENSION_ID,
      action: action as EngineLinkTaskDefinition['action'],
      configuration: config,
      targetType: target,
      platform,
    };

    const execution = action === 'generateCompileCommands'
      ? this.compileCommandsExecution(config, platform)
      : this.ubtExecution(action, config, target, platform);

    const task = new vscode.Task(
      definition,
      vscode.TaskScope.Workspace,
      `EngineLink: ${label}`,
      EXTENSION_ID,
      execution,
      ['$enginelink-msvc', '$enginelink-ubt'],
    );

    task.group = vscode.TaskGroup.Build;
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Shared,
      clear: true,
    };

    return task;
  }

  private compileCommandsExecution(config: BuildConfiguration, platform: BuildPlatform): vscode.ShellExecution {
    if (!this.ctx.cliPath || !this.ctx.project) {
      throw new Error('EngineLink CLI path is not available.');
    }
    return new vscode.ShellExecution('node', [
      this.ctx.cliPath,
      'compile-commands',
      '--project', this.ctx.project.projectRoot,
      '--configuration', config,
      '--platform', platform,
    ]);
  }

  private ubtExecution(
    action: string,
    config: BuildConfiguration,
    target: BuildTargetType,
    platform: BuildPlatform,
  ): vscode.ShellExecution {
    const cmd = action === 'clean'
      ? cleanCommandLine(this.ctx.engine!, this.ctx.project!, {
          configuration: config,
          targetType: target,
          platform,
          editorTargetName: this.ctx.editorTargetName,
        })
      : buildCommandLine(this.ctx.engine!, this.ctx.project!, {
          configuration: config,
          targetType: target,
          platform,
          editorTargetName: this.ctx.editorTargetName,
        });
    return new vscode.ShellExecution(`"${cmd.executable}"`, cmd.args);
  }
}
