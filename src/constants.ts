/** Extension identifier */
export const EXTENSION_ID = 'enginelink';

/** Command IDs */
export const Commands = {
  Build: `${EXTENSION_ID}.build`,
  Clean: `${EXTENSION_ID}.clean`,
  LaunchEditor: `${EXTENSION_ID}.launchEditor`,
  GenerateCompileCommands: `${EXTENSION_ID}.generateCompileCommands`,
  SelectEngine: `${EXTENSION_ID}.selectEngine`,
  SelectProject: `${EXTENSION_ID}.selectProject`,
  SelectBuildConfig: `${EXTENSION_ID}.selectBuildConfig`,
  SelectTarget: `${EXTENSION_ID}.selectTarget`,
} as const;

/** Context keys set via vscode.commands.executeCommand('setContext', ...) */
export const ContextKeys = {
  ProjectDetected: `${EXTENSION_ID}.projectDetected`,
  EngineFound: `${EXTENSION_ID}.engineFound`,
  BuildToolsFound: `${EXTENSION_ID}.buildToolsFound`,
} as const;

/** Windows registry paths */
export const Registry = {
  LauncherInstalls: 'HKLM\\SOFTWARE\\EpicGames\\Unreal Engine',
  SourceBuilds: 'HKCU\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds',
} as const;

/** Common UE installation paths to scan */
export const COMMON_ENGINE_PATHS = [
  'C:\\Program Files\\Epic Games',
  'D:\\Program Files\\Epic Games',
  'C:\\Epic Games',
  'D:\\Epic Games',
] as const;

/** Target name suffixes by target type */
export const TARGET_SUFFIXES: Record<string, string> = {
  Editor: 'Editor',
  Game: '',
  Client: 'Client',
  Server: 'Server',
};
