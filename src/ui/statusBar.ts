import * as vscode from 'vscode';
import { Commands } from '../constants';
import type { EngineLinkContext } from '../types';
import type { EngineLinkSettings } from '../config/settings';

/**
 * EngineLink status bar — Rider-style toolbar at the bottom.
 *
 * Layout (left to right):
 *   [▶ Build] | [🗑 Clean] | [Development ▾] | [Editor ▾] | [Win64] | [ProjectName] | [UE 5.4] | [🚀 Launch]
 */
export class StatusBarManager {
  private buildBtn: vscode.StatusBarItem;
  private cleanBtn: vscode.StatusBarItem;
  private launchBtn: vscode.StatusBarItem;
  private configBtn: vscode.StatusBarItem;
  private targetBtn: vscode.StatusBarItem;
  private platformBtn: vscode.StatusBarItem;
  private projectBtn: vscode.StatusBarItem;
  private engineBtn: vscode.StatusBarItem;

  constructor() {
    this.buildBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 300);
    this.buildBtn.command = Commands.Build;
    this.buildBtn.name = 'EngineLink: Build';

    this.cleanBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 298);
    this.cleanBtn.command = Commands.Clean;
    this.cleanBtn.name = 'EngineLink: Clean';

    this.configBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 297);
    this.configBtn.command = Commands.SelectBuildConfig;
    this.configBtn.name = 'EngineLink: Configuration';

    this.targetBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 296);
    this.targetBtn.command = Commands.SelectTarget;
    this.targetBtn.name = 'EngineLink: Target';

    this.platformBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 295);
    this.platformBtn.name = 'EngineLink: Platform';

    this.projectBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 294);
    this.projectBtn.command = Commands.SelectProject;
    this.projectBtn.name = 'EngineLink: Project';

    this.engineBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 293);
    this.engineBtn.command = Commands.SelectEngine;
    this.engineBtn.name = 'EngineLink: Engine';

    this.launchBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 291);
    this.launchBtn.command = Commands.LaunchEditor;
    this.launchBtn.name = 'EngineLink: Launch';
  }

  update(ctx: EngineLinkContext, settings: EngineLinkSettings): void {
    this.buildBtn.text = '$(play)  Build';
    this.buildBtn.tooltip = 'Build project (Ctrl+Shift+B)';
    this.buildBtn.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    this.buildBtn.color = undefined;
    this.buildBtn.command = Commands.Build;

    this.cleanBtn.text = '$(trash)  Clean';
    this.cleanBtn.tooltip = 'Clean build artifacts';

    this.configBtn.text = `$(gear)  ${settings.buildConfiguration}`;
    this.configBtn.tooltip = 'Build configuration — click to change';

    this.targetBtn.text = `$(symbol-class)  ${settings.buildTarget}`;
    this.targetBtn.tooltip = 'Build target — click to change';

    this.platformBtn.text = `$(device-desktop)  ${settings.platform}`;
    this.platformBtn.tooltip = `Target platform: ${settings.platform}`;

    if (ctx.project) {
      this.projectBtn.text = `$(file-code)  ${ctx.project.name}`;
      this.projectBtn.tooltip = ctx.project.uprojectPath;
      this.projectBtn.backgroundColor = undefined;
    } else {
      this.projectBtn.text = '$(warning)  No Project';
      this.projectBtn.tooltip = 'No .uproject found — click to select';
      this.projectBtn.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }

    if (ctx.engine) {
      this.engineBtn.text = `$(package)  UE ${ctx.engine.version}`;
      this.engineBtn.tooltip = ctx.engine.root;
      this.engineBtn.backgroundColor = undefined;
    } else {
      this.engineBtn.text = '$(warning)  No Engine';
      this.engineBtn.tooltip = 'No engine found — click to select';
      this.engineBtn.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }

    this.launchBtn.text = '$(rocket)  Launch';
    this.launchBtn.tooltip = 'Launch Unreal Editor';
    this.launchBtn.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');

    if (ctx.project) {
      this.buildBtn.show();
      this.cleanBtn.show();
      this.configBtn.show();
      this.targetBtn.show();
      if (settings.statusBarShowContextInfo) {
        this.platformBtn.show();
        this.projectBtn.show();
      } else {
        this.platformBtn.hide();
        this.projectBtn.hide();
      }
      this.engineBtn.show();
      this.launchBtn.show();
    } else {
      this.buildBtn.hide();
      this.cleanBtn.hide();
      this.configBtn.hide();
      this.targetBtn.hide();
      this.platformBtn.hide();
      this.projectBtn.show();
      this.engineBtn.hide();
      this.launchBtn.hide();
    }
  }

  dispose(): void {
    this.buildBtn.dispose();
    this.cleanBtn.dispose();
    this.configBtn.dispose();
    this.targetBtn.dispose();
    this.platformBtn.dispose();
    this.projectBtn.dispose();
    this.engineBtn.dispose();
    this.launchBtn.dispose();
  }
}
