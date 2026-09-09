import * as fs from 'fs';
import * as path from 'path';

export const VSCODE_SETTINGS_MANAGED_BEGIN = '// <<< enginelink-managed >>>';
export const VSCODE_SETTINGS_MANAGED_END = '// <<< end-enginelink-managed >>>';

function managedSettingsBlock(): string {
  return [
    VSCODE_SETTINGS_MANAGED_BEGIN,
    '"C_Cpp.default.compileCommands": "${workspaceFolder}/compile_commands.json",',
    '"clangd.arguments": [',
    '  "--compile-commands-dir=${workspaceFolder}",',
    '  "--query-driver=**/clang-cl.exe"',
    ']',
    VSCODE_SETTINGS_MANAGED_END,
  ].join('\n  ');
}

function wrapManagedBlock(inner: string): string {
  return `{\n  ${inner}\n}\n`;
}

/**
 * Upsert EngineLink-managed IntelliSense settings in the UE project `.vscode/settings.json`.
 *
 * @returns `true` if the file was created or changed.
 */
export async function ensureVscodeSettings(projectRoot: string): Promise<boolean> {
  const vscodeDir = path.join(projectRoot, '.vscode');
  const filePath = path.join(vscodeDir, 'settings.json');
  const block = managedSettingsBlock();

  await fs.promises.mkdir(vscodeDir, { recursive: true });

  let content = '';
  try {
    content = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    content = '';
  }

  const beginIdx = content.indexOf(VSCODE_SETTINGS_MANAGED_BEGIN);
  const endIdx = content.indexOf(VSCODE_SETTINGS_MANAGED_END);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = content.slice(0, beginIdx).replace(/[,\s]+$/, '').trim();
    const afterEnd = endIdx + VSCODE_SETTINGS_MANAGED_END.length;
    const after = content.slice(afterEnd).replace(/^[\s,]+/, '').trim();
    const beforeIsObjectOpen = before === '{';
    const outerParts: string[] = [];
    if (before && !beforeIsObjectOpen) {
      outerParts.push(before.endsWith(',') ? before : `${before},`);
    }
    outerParts.push(block);
    if (after && after !== '}') {
      outerParts.push(after.startsWith(',') ? after.slice(1).trim() : after);
    }
    const newContent = wrapManagedBlock(outerParts.join('\n  '));
    if (newContent === content) {
      return false;
    }
    await fs.promises.writeFile(filePath, newContent, 'utf-8');
    return true;
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    await fs.promises.writeFile(filePath, wrapManagedBlock(block), 'utf-8');
    return true;
  }

  // Existing user settings without managed block — append ours before closing brace.
  const withoutClosing = trimmed.replace(/\}\s*$/, '').trimEnd();
  const separator = withoutClosing.endsWith('{') ? '\n  ' : ',\n  ';
  const newContent = `${withoutClosing}${separator}${block}\n}\n`;
  if (newContent === content) {
    return false;
  }
  await fs.promises.writeFile(filePath, newContent, 'utf-8');
  return true;
}
