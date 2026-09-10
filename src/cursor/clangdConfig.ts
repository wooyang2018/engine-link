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
  /**
   * Absolute path to the shared IDE-only override header. EngineLink keeps a
   * single copy in the extension's global storage (stable across extension
   * updates) instead of writing one into every UE project.
   */
  ideOverridesHeader?: string;
}

/** File name of the IDE-only forced-include override header. */
export const IDE_OVERRIDES_FILE_NAME = 'clangd-ide-overrides.h';

const IDE_OVERRIDES_HEADER_CONTENT = `// <<< enginelink-managed >>>
// IDE-only overrides for clangd. Real UBT/MSVC builds never include this file.
//
// UE 5.8's consteval format-string validation fails to constant-evaluate under
// clangd, producing false UCFS_FChecker / non-constant-expression errors on
// UE_LOG/checkf lines. UBT SharedDefinitions headers set
// UE_VALIDATE_FORMAT_STRINGS=1 and the force-included SharedPCH usually pulls
// in String/FormatStringSan.h BEFORE this header runs, which locks in the
// derived UE_VALIDATE_FORMAT_STRING alias — flipping the gate macro here would
// be too late. So redefine the derived macro directly (it only expands at
// UE_LOG use sites, which are parsed after every /FI header), and also force
// the gate to 0 in case FormatStringSan.h has not been included yet.
#pragma once
#ifdef UE_VALIDATE_FORMAT_STRING
#undef UE_VALIDATE_FORMAT_STRING
#endif
#define UE_VALIDATE_FORMAT_STRING(Format, ...)
#ifdef UE_VALIDATE_FORMAT_STRINGS
#undef UE_VALIDATE_FORMAT_STRINGS
#endif
#define UE_VALIDATE_FORMAT_STRINGS 0
`;

/**
 * Write the single shared IDE-only override header into the extension's
 * global storage directory so every project's .clangd fragments can
 * force-include the same file. Idempotent.
 *
 * @returns the absolute path (forward slashes) to reference from .clangd.
 */
export async function ensureIdeOverridesHeader(storageDir: string): Promise<string> {
  const filePath = path.join(storageDir, IDE_OVERRIDES_FILE_NAME);
  try {
    const existing = await fs.promises.readFile(filePath, 'utf-8');
    if (existing === IDE_OVERRIDES_HEADER_CONTENT) {
      return filePath.replace(/\\/g, '/');
    }
  } catch {
    // missing — fall through and write
  }
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, IDE_OVERRIDES_HEADER_CONTENT, 'utf-8');
  return filePath.replace(/\\/g, '/');
}

function formatIdeOverrideFlags(overrideHeader?: string): string[] {
  if (!overrideHeader) {
    return [];
  }
  // Keep LAST: clang-cl processes /FI in order, and this header must win over
  // every UBT-generated Definitions/SharedDefinitions header.
  return [`    - ${yamlQuote('/FI')}`, `    - ${yamlQuote(overrideHeader)}`];
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

/**
 * clangd diagnostic names suppressed for UE projects. clangd's MSVC
 * compatibility mode disagrees with real UBT/MSVC builds on UHT-generated
 * code, delegate/TSubclassOf template machinery, and include-cleaner; UBT is
 * ground truth, so these IDE-only families are suppressed.
 */
const CLANGD_SUPPRESS_LIST = [
  'builtin_definition',
  'member_function_call_bad_type',
  'user_defined_literal',
  'err_ovl_no_viable_member_function_in_call',
  'ovl_no_viable_function_in_call',
  'ovl_no_viable_literal_operator',
  'function_marked_override_not_overriding',
  'member_decl_does_not_match',
  '-Woverloaded-virtual',
  'err_member_function_call_bad_type',
  'err_member_function_call_bad_cxx',
  'static_assert_requirement_failed',
  'unknown_typename',
  'typename_nested_not_found',
  'init_conversion_failed',
  'err_init_conversion_failed',
  'override_keyword_only_allowed_on_virtual_member_functions',
  'err_override_keyword_hides_overload',
  'err_hiding_overload',
  'fatal_too_many_errors',
  // UHT inline-generated registration (UE_INLINE_GENERATED_CPP_BY_NAME) uses
  // constexpr ClassInfo tables clang cannot constant-fold under MSVC compat.
  'constexpr_var_requires_const_init',
  // Dynamic-multicast Broadcast lookup and FGameplayAbilitySpec(TSubclassOf<
  // Derived>) overloads fail only in clangd's template instantiation.
  'ovl_no_viable_function_in_init',
  'no_member',
  // UE code routinely keeps umbrella/dependency includes that clangd's
  // include-cleaner flags as unused; these warnings are noise next to UBT.
  'unused-includes',
  // clangd's access checker rejects legal `friend class` access through
  // UHT/GENERATED_BODY classes (verified against successful UBT builds).
  'access',
] as const;

function diagnosticsSectionLines(): string[] {
  return [
    CLANGD_MANAGED_BEGIN,
    '# MSVC intrinsics vs Clang builtins when parsing with clangd (IDE-only; real UE builds still use MSVC).',
    'Diagnostics:',
    '  Suppress:',
    ...CLANGD_SUPPRESS_LIST.map((name) => `    - ${name}`),
  ];
}

/**
 * Replace only the Diagnostics section inside an existing managed block,
 * preserving any If/CompileFlags fragments. Used on activation to heal blocks
 * written by older EngineLink versions without erasing generated flags.
 *
 * @returns the updated content, or the original content when already current.
 */
export function refreshDiagnosticsSection(content: string): string {
  const beginIdx = content.indexOf(CLANGD_MANAGED_BEGIN);
  const endIdx = content.indexOf(CLANGD_MANAGED_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    return content;
  }

  const region = content.slice(beginIdx, endIdx);
  const fragmentIdx = region.indexOf('\n---');
  const fragments = fragmentIdx === -1 ? '' : region.slice(fragmentIdx).replace(/\n$/, '');
  const newRegion = `${diagnosticsSectionLines().join('\n')}${fragments}\n`;
  return content.slice(0, beginIdx) + newRegion + content.slice(endIdx);
}

function managedBlock(options: ClangdConfigOptions = {}): string {
  const lines = diagnosticsSectionLines();

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
      ...formatIdeOverrideFlags(options.ideOverridesHeader),
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
      ...formatIdeOverrideFlags(options.ideOverridesHeader),
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
    // command sections generated by post-processing instead of erasing them,
    // but still heal a Diagnostics section written by an older version.
    const hasCompileOptions =
      Object.prototype.hasOwnProperty.call(options, 'templateFlags') ||
      Object.prototype.hasOwnProperty.call(options, 'projectForcedIncludes');
    if (!hasCompileOptions) {
      const healed = refreshDiagnosticsSection(content);
      if (healed === content) {
        return false;
      }
      await fs.promises.writeFile(filePath, healed, 'utf-8');
      return true;
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
