import * as fs from 'fs';
import * as path from 'path';
import type { ProjectForcedIncludes } from './compileCommandsPostProcess';

/**
 * Boundaries for the YAML block EngineLink owns inside `.clangd`.
 * We replace only this region on updates so user config outside it is preserved.
 */
export const CLANGD_MANAGED_BEGIN = '# <<< enginelink-managed >>>';
export const CLANGD_MANAGED_END = '# <<< end-enginelink-managed >>>';

export interface ClangdConfigOptions {
  engineRoot?: string;
  templateFlags?: string[];
  projectRoot?: string;
  projectForcedIncludes?: ProjectForcedIncludes;
}

function yamlQuote(value: string): string {
  const cleaned = value.replace(/\\/g, '/').replace(/"/g, '');
  return `"${cleaned}"`;
}

function pathMatch(root: string, suffix: string): string {
  // clangd's PathMatch is evaluated against the workspace-relative source
  // path here. Match stable source components instead of absolute Windows
  // drive paths, whose representation differs between CDB and LSP requests.
  if (suffix.includes('/Engine/Source/')) {
    return '.*Engine.*Source.*';
  }
  return '.*Source.*';
}

function formatForcedIncludeFlags(forced: ProjectForcedIncludes): string[] {
  const lines = [
    `    - ${yamlQuote('/FI')}`,
    `    - ${yamlQuote(forced.sharedPch)}`,
  ];
  if (forced.definitions) {
    lines.push(`    - ${yamlQuote('/FI')}`, `    - ${yamlQuote(forced.definitions)}`);
  }
  return lines;
}

function formatTemplateFlags(flags: string[]): string[] {
  const lines: string[] = [];
  const maxFlags = 256;

  for (let i = 0; i < flags.length && lines.length < maxFlags; i++) {
    const flag = flags[i];
    if (
      flag.startsWith('/Fo') ||
      flag.startsWith('/fp') ||
      flag.startsWith('/Fp') ||
      flag.endsWith('.cpp') ||
      flag.endsWith('.c') ||
      flag.endsWith('clang-cl.exe')
    ) {
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
    '  Suppress:',
    '    - builtin_definition',
    '    - member_function_call_bad_type',
    '    - user_defined_literal',
    '    - err_ovl_no_viable_member_function_in_call',
    '    - ovl_no_viable_function_in_call',
    // UE 5.8's generated/UHT code and clangd's MSVC compatibility mode can
    // disagree on these generated declarations without affecting UBT/MSVC.
    '    - ovl_no_viable_literal_operator',
    '    - function_marked_override_not_overriding',
    '    - member_decl_does_not_match',
    '    - -Woverloaded-virtual',
    '    - err_member_function_call_bad_type',
    '    - err_member_function_call_bad_cxx',
    '    - static_assert_requirement_failed',
    '    - unknown_typename',
    '    - typename_nested_not_found',
    '    - init_conversion_failed',
    '    - err_init_conversion_failed',
    '    - override_keyword_only_allowed_on_virtual_member_functions',
    '    - err_override_keyword_hides_overload',
    '    - err_hiding_overload',
    '    - fatal_too_many_errors',
  ];

  if (options.engineRoot && options.templateFlags && options.templateFlags.length > 0) {
    const engineSourceGlob = pathMatch(options.engineRoot, '/Engine/Source/.*');
    lines.push(
      '---',
      'If:',
      `  PathMatch: ${yamlQuote(engineSourceGlob)}`,
      'CompileFlags:',
      '  Add:',
      '    - "/clang:-ferror-limit=0"',
      ...formatTemplateFlags(options.templateFlags),
    );
  }

  if (options.projectRoot && options.projectForcedIncludes) {
    const projectSourceGlob = pathMatch(options.projectRoot, '/Source/.*');
    lines.push(
      '---',
      'If:',
      `  PathMatch: ${yamlQuote(projectSourceGlob)}`,
      `  PathExclude: ${yamlQuote('.*Engine.*Source.*')}`,
      'CompileFlags:',
      '  Add:',
      '    - "/clang:-ferror-limit=0"',
      ...formatForcedIncludeFlags(options.projectForcedIncludes),
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
    // Extension activation only supplies engineRoot. Preserve the compile
    // command sections generated by post-processing instead of erasing them.
    const hasCompileOptions =
      Object.prototype.hasOwnProperty.call(options, 'templateFlags') ||
      Object.prototype.hasOwnProperty.call(options, 'projectForcedIncludes');
    if (!hasCompileOptions) {
      return false;
    }

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
