import * as fs from 'fs';
import * as path from 'path';

/**
 * Boundaries for the YAML block EngineLink owns inside `.clangd`.
 * We replace only this region on updates so user config outside it is preserved.
 */
export const CLANGD_MANAGED_BEGIN = '# <<< enginelink-managed >>>';
export const CLANGD_MANAGED_END = '# <<< end-enginelink-managed >>>';

export interface ClangdConfigOptions {
  engineRoot?: string;
  templateFlags?: string[];
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '/')}"`;
}

function formatTemplateFlags(flags: string[]): string[] {
  const lines: string[] = [];
  const maxFlags = 256;

  for (let i = 0; i < flags.length && lines.length < maxFlags; i++) {
    const flag = flags[i];
    if (flag.startsWith('/Fo') || flag.startsWith('/fp') || flag.startsWith('/Fp')) {
      continue;
    }

    if (flag === '/I' || flag === '-I') {
      const includePath = flags[i + 1];
      if (includePath) {
        lines.push(`    - ${yamlQuote('/I')}`);
        lines.push(`    - ${yamlQuote(includePath)}`);
        i++;
      }
      continue;
    }

    lines.push(`    - ${yamlQuote(flag)}`);
  }

  return lines;
}

function managedBlock(options: ClangdConfigOptions = {}): string {
  const lines = [
    CLANGD_MANAGED_BEGIN,
    '# MSVC intrinsics vs Clang builtins when parsing with clangd (IDE-only; real UE builds still use MSVC).',
    'Diagnostics:',
    '  Suppress: builtin_definition',
    'CompileFlags:',
    '  Add:',
    '    - --query-driver=**/clang-cl.exe',
  ];

  if (options.engineRoot && options.templateFlags && options.templateFlags.length > 0) {
    const engineSourceGlob = `${options.engineRoot.replace(/\\/g, '/')}/Engine/Source/.*`;
    lines.push(
      '---',
      'If:',
      `  PathMatch: ${yamlQuote(engineSourceGlob)}`,
      'CompileFlags:',
      '  Add:',
      ...formatTemplateFlags(options.templateFlags),
    );
  }

  lines.push(CLANGD_MANAGED_END);
  return lines.join('\n');
}

/**
 * Upsert a `.clangd` file in the UE project root so clangd suppresses false
 * `builtin_definition` diagnostics when MSVC headers define intrinsics Clang also treats as builtins.
 *
 * @returns `true` if the file was created or changed.
 */
export async function ensureClangdConfig(
  projectRoot: string,
  options: ClangdConfigOptions = {},
): Promise<boolean> {
  const filePath = path.join(projectRoot, '.clangd');
  const block = managedBlock(options);

  let content = '';
  try {
    content = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    content = '';
  }

  const beginIdx = content.indexOf(CLANGD_MANAGED_BEGIN);
  const endIdx = content.indexOf(CLANGD_MANAGED_END);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = content.slice(0, beginIdx).replace(/\s+$/, '');
    const afterEnd = endIdx + CLANGD_MANAGED_END.length;
    const after = content.slice(afterEnd).replace(/^\s+/, '');
    const pieces = [before, block];
    if (after.length > 0) {
      pieces.push(after);
    }
    const newContent = pieces.join('\n\n') + '\n';
    if (newContent === content) {
      return false;
    }
    await fs.promises.writeFile(filePath, newContent, 'utf-8');
    return true;
  }

  if (/\bbuiltin_definition\b/.test(content)) {
    return false;
  }

  const trimmed = content.trimEnd();
  const newContent = trimmed.length === 0 ? `${block}\n` : `${trimmed}\n\n${block}\n`;
  if (newContent === content) {
    return false;
  }
  await fs.promises.writeFile(filePath, newContent, 'utf-8');
  return true;
}
