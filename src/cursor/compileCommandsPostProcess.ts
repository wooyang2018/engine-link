import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileExists } from '../platform/paths';

export interface CompileCommandEntry {
  file: string;
  command?: string;
  arguments?: string[];
  directory?: string;
  output?: string;
}

export interface PostProcessStats {
  total: number;
  flattened: number;
  remapped: number;
  headerAliases: number;
  orphanHeaders: number;
  engineHeaderEntries: number;
  broken: number;
}

export interface PostProcessResult {
  entries: CompileCommandEntry[];
  stats: PostProcessStats;
  templateFlags: string[];
}

const DEFAULT_CLANG_CL = 'clang-cl.exe';

const INCLUDE_CPP_RE = /#include\s+"([^"]+\.cpp)"/g;
const INCLUDE_HEADER_RE = /#include\s+["<]([^">\n]+)[">]/g;
const MODULE_CPP_RE = /^Module\..*\.cpp$/i;
const GLUED_MSVC_FLAG_RE = /^\/(FI|Yu|Fp|Fo|I)(.*)$/i;
const GLUED_DEFINE_RE = /^\/D([A-Za-z_].*)$/;
const SOURCE_FILE_RE = /\.(cpp|h|inl)$/i;

/** MSVC tokens that must not be split by GLUED_MSVC_FLAG_RE or GLUED_DEFINE_RE. */
const MSVC_NO_SPLIT_PREFIXES = ['/imsvc', '/external:i', '/diagnostics', '/d2'] as const;

const INCLUDE_FLAG_MAP: Record<string, '/FI' | '/I'> = {
  '/fi': '/FI',
  '/i': '/I',
  '-i': '/I',
  '/external:i': '/I',
  '/imsvc': '/I',
};

const MSVC_CONSUME_NEXT_FLAGS = new Set(['/yu', '/fp', '/fo']);

/** Prefix match for MSVC-only flags clangd cannot interpret (e.g. /experimental:log:...). */
const MSVC_SKIP_PREFIXES = ['/experimental:log'] as const;

const MSVC_ONLY_CLANGD_SKIP = new Set(['/sourcedependencies']);

/**
 * Tokenize a Windows/MSVC command line respecting quoted segments.
 */
export function tokenizeCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Extract response-file paths referenced via `@file.rsp` tokens.
 */
export function extractResponseFilePaths(command: string): string[] {
  const paths: string[] = [];
  for (const token of tokenizeCommandLine(command)) {
    const unquoted = stripQuotes(token);
    if (unquoted.startsWith('@')) {
      paths.push(stripQuotes(unquoted.slice(1)));
    }
  }
  return paths;
}

function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function toForwardSlashes(filePath: string): string {
  return path.normalize(filePath).replace(/\\/g, '/');
}

function normalizeFileKey(filePath: string): string {
  return toForwardSlashes(filePath).toLowerCase();
}

function resolvePath(relativeOrAbsolute: string, baseDir: string): string {
  const cleaned = stripQuotes(relativeOrAbsolute);
  if (path.isAbsolute(cleaned)) {
    return path.normalize(cleaned);
  }
  return path.normalize(path.join(baseDir, cleaned));
}

function hasMsvcNoSplitPrefix(lower: string): boolean {
  return MSVC_NO_SPLIT_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Split MSVC flags glued to their values, e.g. `/FI"path"` -> `/FI`, `path`.
 */
export function splitGluedMsvcToken(token: string): string[] {
  const unquoted = stripQuotes(token);
  const lower = unquoted.toLowerCase();
  if (hasMsvcNoSplitPrefix(lower)) {
    return [token];
  }

  const defineMatch = unquoted.match(GLUED_DEFINE_RE);
  if (defineMatch) {
    const value = stripQuotes(defineMatch[1] ?? '');
    return value.length > 0 ? ['/D', value] : ['/D'];
  }

  const match = unquoted.match(GLUED_MSVC_FLAG_RE);
  if (!match) {
    return [token];
  }

  const flag = `/${match[1]}`;
  const value = stripQuotes(match[2] ?? '');
  if (value.length === 0) {
    return [flag];
  }
  return [flag, value];
}

/**
 * Expand a MSVC/clang-cl response file into argument tokens (recursive for nested @rsp).
 */
export function expandResponseFile(
  rspPath: string,
  workingDir: string,
  visited: Set<string> = new Set(),
): string[] {
  const resolved = resolvePath(rspPath, workingDir);
  const key = normalizeFileKey(resolved);
  if (visited.has(key)) {
    return [];
  }
  visited.add(key);

  let content: string;
  try {
    content = fs.readFileSync(resolved, 'utf-8');
  } catch {
    return [];
  }

  const args: string[] = [];
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('@')) {
      const nested = stripQuotes(line.slice(1));
      args.push(...expandResponseFile(nested, path.dirname(resolved), visited));
      continue;
    }

    if (line.startsWith('"') && line.endsWith('"')) {
      args.push(line.slice(1, -1));
      continue;
    }

    const parts = tokenizeCommandLine(line);
    for (const part of parts) {
      const unquoted = stripQuotes(part);
      if (unquoted.startsWith('@')) {
        args.push(...expandResponseFile(unquoted.slice(1), path.dirname(resolved), visited));
      } else {
        args.push(...splitGluedMsvcToken(unquoted));
      }
    }
  }

  return args;
}

/**
 * Flatten `command` by inlining all `@*.rsp` references into an arguments array.
 */
export function flattenCommand(
  command: string,
  directory: string,
): { arguments: string[]; broken: boolean } {
  const tokens = tokenizeCommandLine(command);
  const args: string[] = [];
  let broken = false;

  for (const token of tokens) {
    const unquoted = stripQuotes(token);
    if (unquoted.startsWith('@')) {
      const rspPath = unquoted.slice(1);
      const resolved = resolvePath(rspPath, directory);
      if (!fs.existsSync(resolved)) {
        broken = true;
        args.push(unquoted);
        continue;
      }
      args.push(...expandResponseFile(rspPath, directory));
      continue;
    }
    args.push(...splitGluedMsvcToken(unquoted));
  }

  return { arguments: args, broken };
}

function shouldStripMsvcOnlyFlag(lower: string): boolean {
  if (MSVC_ONLY_CLANGD_SKIP.has(lower)) {
    return true;
  }
  return MSVC_SKIP_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Drop MSVC-only flags clang-cl/clangd cannot interpret (they can break /FI parsing).
 */
function stripMsvcOnlyClangdArgs(args: string[]): string[] {
  const stripped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const lower = flag.toLowerCase();
    if (shouldStripMsvcOnlyFlag(lower)) {
      const next = args[i + 1];
      if (next && !next.startsWith('/') && !next.startsWith('-')) {
        i++;
      }
      continue;
    }
    stripped.push(flag);
  }
  return stripped;
}

/**
 * Move forced includes to the front so clang-cl does not lose them among later flags.
 */
function prioritizeForcedIncludes(args: string[]): string[] {
  if (args.length === 0) {
    return args;
  }

  const compiler = args[0];
  const forced: string[] = [];
  const rest: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const lower = flag.toLowerCase();
    if (lower === '/fi' || flag === '-include') {
      const includePath = args[i + 1];
      if (includePath && !includePath.startsWith('/') && !includePath.startsWith('-')) {
        forced.push(flag, includePath);
        i++;
        continue;
      }
    }
    rest.push(flag);
  }
  return [compiler, ...forced, ...rest];
}

function tryNormalizeIncludeFlag(
  lower: string,
  expanded: string[],
  index: number,
  directory: string,
  normalized: string[],
): number {
  const outputFlag = INCLUDE_FLAG_MAP[lower];
  if (!outputFlag) {
    return index;
  }

  const includePath = expanded[index + 1];
  if (includePath && !includePath.startsWith('/') && !includePath.startsWith('-')) {
    normalized.push(outputFlag, resolvePath(includePath, directory));
    return index + 1;
  }

  return index;
}

/**
 * Normalize UE/MSVC compile arguments for clangd.
 */
export function normalizeClangdArguments(args: string[], directory: string): string[] {
  const expanded: string[] = [];
  for (const token of args) {
    expanded.push(...splitGluedMsvcToken(token));
  }

  const normalized: string[] = [];
  for (let i = 0; i < expanded.length; i++) {
    const flag = expanded[i];
    const lower = flag.toLowerCase();

    if (MSVC_CONSUME_NEXT_FLAGS.has(lower)) {
      const next = expanded[i + 1];
      if (next && !next.startsWith('/') && !next.startsWith('-')) {
        i++;
      }
      continue;
    }

    const includeNextIndex = tryNormalizeIncludeFlag(lower, expanded, i, directory, normalized);
    if (includeNextIndex !== i) {
      i = includeNextIndex;
      continue;
    }

    if (flag.startsWith('@')) {
      continue;
    }

    normalized.push(flag);
  }

  return prioritizeForcedIncludes(stripMsvcOnlyClangdArgs(normalized));
}

/**
 * Return true when any referenced response file is missing on disk.
 */
export function hasMissingResponseFiles(command: string, directory: string): boolean {
  for (const rspPath of extractResponseFilePaths(command)) {
    const resolved = resolvePath(rspPath, directory);
    if (!fs.existsSync(resolved)) {
      return true;
    }
  }
  return false;
}

/**
 * Map each merged-compilation source .cpp to its parent Module.*.cpp path.
 */
export async function buildUnitySourceToModuleMap(projectRoot: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const intermediate = path.join(projectRoot, 'Intermediate');
  if (!(await fileExists(intermediate))) {
    return map;
  }

  const moduleFiles = await findFilesRecursive(intermediate, (name) => MODULE_CPP_RE.test(name), 12);
  for (const moduleFile of moduleFiles) {
    let content: string;
    try {
      content = await fs.promises.readFile(moduleFile, 'utf-8');
    } catch {
      continue;
    }

    for (const match of content.matchAll(INCLUDE_CPP_RE)) {
      const included = match[1];
      map.set(normalizeFileKey(included), moduleFile);
    }
  }

  return map;
}

async function findFilesRecursive(
  dir: string,
  predicate: (name: string) => boolean,
  maxDepth: number,
): Promise<string[]> {
  if (maxDepth <= 0) return [];

  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && predicate(entry.name)) {
      results.push(fullPath);
    } else if (entry.isDirectory()) {
      results.push(...(await findFilesRecursive(fullPath, predicate, maxDepth - 1)));
    }
  }

  return results;
}

function entryKey(entry: CompileCommandEntry): string {
  return normalizeFileKey(entry.file);
}

function replaceTranslationUnitArgument(
  args: string[],
  oldFile: string,
  newFile: string,
): string[] {
  const oldKey = normalizeFileKey(oldFile);
  const nextFile = toForwardSlashes(newFile);
  return args.map((arg) => (normalizeFileKey(stripQuotes(arg)) === oldKey ? nextFile : arg));
}

function cloneEntryForFile(source: CompileCommandEntry, file: string): CompileCommandEntry {
  const cloned: CompileCommandEntry = { file: toForwardSlashes(file) };
  if (source.directory) cloned.directory = source.directory;
  if (source.arguments) {
    cloned.arguments = remapArgumentsForTranslationUnit(source.arguments, source.file, file);
  }
  return cloned;
}

function remapArgumentsForTranslationUnit(
  args: string[],
  sourceFile: string,
  targetFile: string,
): string[] {
  const target = toForwardSlashes(targetFile);
  if (normalizeFileKey(sourceFile) === normalizeFileKey(targetFile)) {
    return [...args];
  }

  if (args.some((arg) => normalizeFileKey(stripQuotes(arg)) === normalizeFileKey(sourceFile))) {
    return replaceTranslationUnitArgument(args, sourceFile, target);
  }

  const companionCpp = /\.h$/i.test(targetFile) ? cppPathForHeader(targetFile) : undefined;
  if (
    companionCpp &&
    args.some((arg) => normalizeFileKey(stripQuotes(arg)) === normalizeFileKey(companionCpp))
  ) {
    return replaceTranslationUnitArgument(args, companionCpp, target);
  }

  if (/\.h$/i.test(targetFile)) {
    const next = [...args];
    const cppIdx = next.findIndex((arg) => /\.cpp$/i.test(stripQuotes(arg)));
    if (cppIdx >= 0) {
      next[cppIdx] = target;
      return next;
    }
    return [...next, target];
  }

  return [...args];
}

type UeCompanionKind = 'header' | 'cpp';

/**
 * Resolve the paired .h/.cpp for UE module layouts (Public/Private subdirs or siblings).
 */
function resolveUeModuleCompanion(filePath: string, kind: UeCompanionKind): string | undefined {
  const fromExt = kind === 'header' ? '.cpp' : '.h';
  const toExt = kind === 'header' ? '.h' : '.cpp';
  if (!filePath.toLowerCase().endsWith(fromExt)) {
    return undefined;
  }

  const normalized = toForwardSlashes(filePath);
  const sourceSegment = kind === 'header' ? '/Private/' : '/Public/';
  const targetFolder = kind === 'header' ? 'Public' : 'Private';
  const segmentIdx = normalized.lastIndexOf(sourceSegment);
  if (segmentIdx !== -1) {
    const moduleRoot = normalized.slice(0, segmentIdx);
    const relativeAfterSource = normalized.slice(segmentIdx + sourceSegment.length);
    const relativeTarget = relativeAfterSource.replace(
      new RegExp(`${fromExt.replace('.', '\\.')}$`, 'i'),
      toExt,
    );
    const companionPath = path.join(moduleRoot, targetFolder, relativeTarget);
    if (fs.existsSync(companionPath)) {
      return toForwardSlashes(companionPath);
    }

    const baseName = path.basename(filePath, path.extname(filePath));
    const flatCompanion = path.join(moduleRoot, targetFolder, `${baseName}${toExt}`);
    if (fs.existsSync(flatCompanion)) {
      return toForwardSlashes(flatCompanion);
    }
  }

  const sibling = filePath.replace(new RegExp(`${fromExt}$`, 'i'), toExt);
  if (fs.existsSync(sibling)) {
    return toForwardSlashes(sibling);
  }

  return undefined;
}

function headerPathForSource(sourcePath: string): string | undefined {
  return resolveUeModuleCompanion(sourcePath, 'header');
}

function cppPathForHeader(headerPath: string): string | undefined {
  return resolveUeModuleCompanion(headerPath, 'cpp');
}

function engineSourceRoot(engineRoot: string): string {
  return path.join(engineRoot, 'Engine', 'Source');
}

function isEngineSourceFile(filePath: string, engineRoot: string): boolean {
  const rootKey = normalizeFileKey(engineSourceRoot(engineRoot));
  return normalizeFileKey(filePath).startsWith(`${rootKey}/`);
}

function isProjectSourceFile(filePath: string, projectRoot: string): boolean {
  const normalized = normalizeFileKey(filePath);
  const projectKey = normalizeFileKey(projectRoot);
  if (normalized.startsWith(`${projectKey}/source/`)) {
    return true;
  }
  const pluginsSegment = `${projectKey}/plugins/`;
  if (!normalized.startsWith(pluginsSegment)) {
    return false;
  }
  const remainder = normalized.slice(pluginsSegment.length);
  return /\/source\//.test(remainder);
}

async function collectPluginSourceRoots(
  dir: string,
  maxDepth: number,
  results: string[] = [],
): Promise<string[]> {
  if (maxDepth <= 0) {
    return results;
  }

  const sourceDir = path.join(dir, 'Source');
  if (await fileExists(sourceDir)) {
    results.push(sourceDir);
    return results;
  }

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    await collectPluginSourceRoots(path.join(dir, entry.name), maxDepth - 1, results);
  }

  return results;
}

async function listProjectSourceRoots(projectRoot: string): Promise<string[]> {
  const roots: string[] = [];
  const primarySource = path.join(projectRoot, 'Source');
  if (await fileExists(primarySource)) {
    roots.push(primarySource);
  }

  const pluginsRoot = path.join(projectRoot, 'Plugins');
  if (await fileExists(pluginsRoot)) {
    await collectPluginSourceRoots(pluginsRoot, 8, roots);
  }

  return [...new Set(roots.map((root) => path.normalize(root)))];
}

function extractIncludePaths(args: string[], directory: string): string[] {
  const includePaths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '/I' || flag === '-I') {
      const includePath = args[i + 1];
      if (includePath) {
        includePaths.push(resolvePath(includePath, directory));
      }
    }
  }
  return includePaths;
}

function resolveIncludeToFile(
  includeName: string,
  fromFile: string,
  includePaths: string[],
): string | undefined {
  const fromDir = path.dirname(fromFile);
  const relativeCandidate = path.join(fromDir, includeName);
  if (fs.existsSync(relativeCandidate)) {
    return path.normalize(relativeCandidate);
  }

  for (const includePath of includePaths) {
    const direct = path.join(includePath, includeName);
    if (fs.existsSync(direct)) {
      return path.normalize(direct);
    }
  }

  const baseName = path.basename(includeName);
  if (baseName !== includeName) {
    return undefined;
  }

  for (const includePath of includePaths) {
    const candidate = path.join(includePath, baseName);
    if (fs.existsSync(candidate)) {
      return path.normalize(candidate);
    }
  }

  return undefined;
}

function findEntryForSourceFile(
  sourceFile: string,
  byFile: Map<string, CompileCommandEntry>,
): CompileCommandEntry | undefined {
  const direct = byFile.get(normalizeFileKey(sourceFile));
  if (direct) {
    return direct;
  }

  if (/\.h$/i.test(sourceFile)) {
    const cppCandidate = cppPathForHeader(sourceFile);
    if (cppCandidate) {
      return byFile.get(normalizeFileKey(cppCandidate));
    }
  }

  return undefined;
}

function collectIncludes(content: string): string[] {
  const includes: string[] = [];
  for (const match of content.matchAll(INCLUDE_HEADER_RE)) {
    includes.push(match[1]);
  }
  return includes;
}

function moduleKeyFromSourceFile(filePath: string): string | undefined {
  const normalized = toForwardSlashes(filePath);
  const match = normalized.match(/\/Source\/([^/]+)\//i);
  return match ? match[1].toLowerCase() : undefined;
}

function rememberModuleTemplate(
  templates: Map<string, CompileCommandEntry>,
  entry: CompileCommandEntry,
): void {
  if (!/\.cpp$/i.test(entry.file) || !entry.arguments || entry.arguments.length === 0) {
    return;
  }

  const moduleKey = moduleKeyFromSourceFile(entry.file);
  if (!moduleKey) {
    return;
  }

  const existing = templates.get(moduleKey);
  if (!existing || entryQualityScore(entry) > entryQualityScore(existing)) {
    templates.set(moduleKey, entry);
  }
}

/**
 * Add compile_commands entries for header-only project/plugin headers (no companion .cpp).
 */
export async function addOrphanHeaderEntries(
  projectRoot: string,
  entries: CompileCommandEntry[],
): Promise<{ entries: CompileCommandEntry[]; orphanHeaders: number }> {
  const moduleTemplates = new Map<string, CompileCommandEntry>();
  for (const entry of entries) {
    rememberModuleTemplate(moduleTemplates, entry);
  }

  const existingKeys = new Set(entries.map(entryKey));
  const additions: CompileCommandEntry[] = [];
  let orphanHeaders = 0;

  const sourceRoots = await listProjectSourceRoots(projectRoot);
  for (const sourceRoot of sourceRoots) {
    const headers = await findFilesRecursive(sourceRoot, (name) => /\.h$/i.test(name), 24);
    for (const headerPath of headers) {
      const headerFile = toForwardSlashes(headerPath);
      const headerKey = normalizeFileKey(headerFile);
      if (existingKeys.has(headerKey)) {
        continue;
      }

      const moduleKey = moduleKeyFromSourceFile(headerFile);
      const template = moduleKey ? moduleTemplates.get(moduleKey) : undefined;
      if (!template?.arguments || template.arguments.length === 0) {
        continue;
      }

      additions.push(cloneEntryForFile(template, headerFile));
      existingKeys.add(headerKey);
      orphanHeaders++;
    }
  }

  return { entries: [...entries, ...additions], orphanHeaders };
}

/**
 * Add compile_commands entries for engine headers referenced from project source.
 */
export async function addEngineHeaderEntries(
  projectRoot: string,
  engineRoot: string,
  entries: CompileCommandEntry[],
): Promise<{ entries: CompileCommandEntry[]; engineHeaderEntries: number }> {
  const sourceRoots = await listProjectSourceRoots(projectRoot);
  if (sourceRoots.length === 0) {
    return { entries, engineHeaderEntries: 0 };
  }

  const byFile = new Map<string, CompileCommandEntry>();
  for (const entry of entries) {
    byFile.set(entryKey(entry), entry);
  }

  const existingKeys = new Set(entries.map(entryKey));
  const additions: CompileCommandEntry[] = [];
  let engineHeaderEntries = 0;

  const addEngineHeader = (headerPath: string, sourceEntry: CompileCommandEntry) => {
    const key = normalizeFileKey(headerPath);
    if (existingKeys.has(key)) {
      return;
    }
    if (!sourceEntry.arguments || sourceEntry.arguments.length === 0) {
      return;
    }

    additions.push(cloneEntryForFile(sourceEntry, headerPath));
    existingKeys.add(key);
    engineHeaderEntries++;
  };

  const projectSourceFiles: string[] = [];
  for (const sourceRoot of sourceRoots) {
    projectSourceFiles.push(
      ...(await findFilesRecursive(sourceRoot, (name) => SOURCE_FILE_RE.test(name), 24)),
    );
  }
  for (const sourceFile of projectSourceFiles) {
    const sourceEntry = findEntryForSourceFile(sourceFile, byFile);
    if (!sourceEntry?.arguments || sourceEntry.arguments.length === 0) {
      continue;
    }

    const directory = sourceEntry.directory ?? projectRoot;
    const includePaths = extractIncludePaths(sourceEntry.arguments, directory);
    let content: string;
    try {
      content = await fs.promises.readFile(sourceFile, 'utf-8');
    } catch {
      continue;
    }

    for (const includeName of collectIncludes(content)) {
      const resolved = resolveIncludeToFile(includeName, sourceFile, includePaths);
      if (!resolved || !isEngineSourceFile(resolved, engineRoot)) {
        continue;
      }

      addEngineHeader(resolved, sourceEntry);

      let engineContent: string;
      try {
        engineContent = await fs.promises.readFile(resolved, 'utf-8');
      } catch {
        continue;
      }

      for (const nestedInclude of collectIncludes(engineContent)) {
        const nestedResolved = resolveIncludeToFile(nestedInclude, resolved, includePaths);
        if (!nestedResolved || !isEngineSourceFile(nestedResolved, engineRoot)) {
          continue;
        }
        addEngineHeader(nestedResolved, sourceEntry);
      }
    }
  }

  return { entries: [...entries, ...additions], engineHeaderEntries };
}

/**
 * Pick representative normalized compile flags for engine-source clangd fallback.
 */
export function pickTemplateFlags(entries: CompileCommandEntry[], projectRoot: string): string[] {
  const candidates = entries.filter((entry) => {
    if (!entry.arguments || entry.arguments.length === 0) {
      return false;
    }
    return isProjectSourceFile(entry.file, projectRoot) && /\.cpp$/i.test(entry.file);
  });

  candidates.sort((a, b) => (b.arguments?.length ?? 0) - (a.arguments?.length ?? 0));
  const preferred =
    candidates.find((entry) => /\/Source\/[^/]+\//i.test(entry.file) && !entry.file.includes('/Plugins/')) ??
    candidates[0];

  return preferred?.arguments ? [...preferred.arguments] : [];
}

function objRspPathForEntry(entry: CompileCommandEntry, baseDir: string): string | undefined {
  if (!entry.output) {
    return undefined;
  }
  const rsp = `${resolvePath(entry.output, baseDir)}.rsp`;
  return fs.existsSync(rsp) ? path.normalize(rsp) : undefined;
}

function flattenFromObjRsp(
  entry: CompileCommandEntry,
  directory: string,
): { arguments: string[]; broken: boolean } | undefined {
  const rsp = objRspPathForEntry(entry, directory);
  if (!rsp) {
    return undefined;
  }
  return flattenCommand(`"${DEFAULT_CLANG_CL}" @"${rsp}"`, directory);
}

function finalizeEntry(entry: CompileCommandEntry, projectRoot: string): CompileCommandEntry {
  const directory = entry.directory ?? projectRoot;
  if (!entry.arguments || entry.arguments.length === 0) {
    return entry;
  }

  const next = { ...entry };
  next.arguments = normalizeClangdArguments(entry.arguments, directory);
  delete next.command;
  return next;
}

/**
 * Post-process compile_commands.json entries for clangd: flatten @rsp, remap merged builds, add .h aliases.
 */
export async function postProcessCompileCommands(
  projectRoot: string,
  entries: CompileCommandEntry[],
  engineRoot?: string,
): Promise<PostProcessResult> {
  const stats: PostProcessStats = {
    total: entries.length,
    flattened: 0,
    remapped: 0,
    headerAliases: 0,
    orphanHeaders: 0,
    engineHeaderEntries: 0,
    broken: 0,
  };

  const unityMap = await buildUnitySourceToModuleMap(projectRoot);
  const byFile = new Map<string, CompileCommandEntry>();
  for (const entry of entries) {
    byFile.set(entryKey(entry), entry);
  }

  const processed: CompileCommandEntry[] = [];

  for (const entry of entries) {
    const directory = entry.directory ?? projectRoot;
    const command = entry.command ?? '';
    let next: CompileCommandEntry = { ...entry };
    let broken = false;

    const rspFlat = flattenFromObjRsp(entry, directory);
    if (rspFlat && rspFlat.arguments.length > 0 && !rspFlat.broken) {
      next = {
        ...next,
        arguments: normalizeClangdArguments(rspFlat.arguments, directory),
      };
      delete next.command;
      stats.flattened++;
      processed.push(next);
      continue;
    }

    if (entry.arguments && entry.arguments.length > 0) {
      next = finalizeEntry(entry, projectRoot);
      processed.push(next);
      continue;
    }

    if (!command) {
      stats.broken++;
      processed.push(next);
      continue;
    }

    let flat = flattenCommand(command, directory);
    let effectiveDirectory = directory;
    if (flat.broken || flat.arguments.length === 0) {
      const moduleCpp = unityMap.get(entryKey(entry));
      if (moduleCpp) {
        const moduleKey = normalizeFileKey(moduleCpp);
        const moduleEntry = byFile.get(moduleKey);
        const moduleDir = moduleEntry?.directory ?? path.dirname(moduleCpp);
        const moduleRsp = `${moduleCpp}.obj.rsp`;
        const remappedCommand =
          moduleEntry?.command ?? `"${DEFAULT_CLANG_CL}" @"${moduleRsp}"`;
        flat = flattenCommand(remappedCommand, moduleDir);
        if (!flat.broken && flat.arguments.length > 0) {
          stats.remapped++;
          effectiveDirectory = moduleDir;
        }
      }
    }

    if (flat.arguments.length > 0) {
      next = {
        ...next,
        arguments: normalizeClangdArguments(flat.arguments, effectiveDirectory),
      };
      delete next.command;
      if (!flat.broken) {
        stats.flattened++;
      }
    }

    broken = flat.broken || (command.includes('@') && hasMissingResponseFiles(command, directory));
    if (broken) {
      stats.broken++;
    }

    processed.push(next);
  }

  // UBT only emits .cpp units; project .h entries are always derived here (never taken from input).
  const cppOnly = processed.filter(
    (entry) => !(/\.h$/i.test(entry.file) && isProjectSourceFile(entry.file, projectRoot)),
  );

  const withHeaders: CompileCommandEntry[] = [...cppOnly];
  const existingKeys = new Set(cppOnly.map(entryKey));

  for (const entry of cppOnly) {
    if (!/\.cpp$/i.test(entry.file)) continue;
    const header = headerPathForSource(entry.file);
    if (!header) continue;
    const headerKey = normalizeFileKey(header);
    if (existingKeys.has(headerKey)) continue;
    if (!entry.arguments || entry.arguments.length === 0) continue;

    withHeaders.push(cloneEntryForFile(entry, header));
    existingKeys.add(headerKey);
    stats.headerAliases++;
  }

  const orphanHeaders = await addOrphanHeaderEntries(projectRoot, withHeaders);
  let finalEntries = orphanHeaders.entries;
  stats.orphanHeaders = orphanHeaders.orphanHeaders;

  if (engineRoot) {
    const engineHeaders = await addEngineHeaderEntries(projectRoot, engineRoot, finalEntries);
    finalEntries = engineHeaders.entries;
    stats.engineHeaderEntries = engineHeaders.engineHeaderEntries;
  }

  const deduped = dedupeEntriesByFile(finalEntries);
  stats.total = deduped.length;
  const templateFlags = pickTemplateFlags(deduped, projectRoot);

  return { entries: deduped, stats, templateFlags };
}

function entryQualityScore(entry: CompileCommandEntry): number {
  return entry.arguments?.length ?? (entry.command ? 1 : 0);
}

/**
 * Keep a single best entry per translation unit (longest flattened argument list wins).
 */
function dedupeEntriesByFile(entries: CompileCommandEntry[]): CompileCommandEntry[] {
  const bestByFile = new Map<string, CompileCommandEntry>();
  for (const entry of entries) {
    const key = entryKey(entry);
    const existing = bestByFile.get(key);
    if (!existing || entryQualityScore(entry) > entryQualityScore(existing)) {
      bestByFile.set(key, entry);
    }
  }
  return [...bestByFile.values()];
}

/**
 * Heuristic: compile_commands is stale when many entries reference missing .rsp files.
 */
export async function isCompileCommandsStale(
  projectRoot: string,
  options: { sampleSize?: number; brokenThreshold?: number } = {},
): Promise<boolean> {
  const compileDbPath = path.join(projectRoot, 'compile_commands.json');
  if (!(await fileExists(compileDbPath))) {
    return false;
  }

  let entries: CompileCommandEntry[];
  try {
    const raw = await fs.promises.readFile(compileDbPath, 'utf-8');
    entries = JSON.parse(raw) as CompileCommandEntry[];
  } catch {
    return true;
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    return true;
  }

  const sampleSize = options.sampleSize ?? Math.min(40, entries.length);
  const brokenThreshold = options.brokenThreshold ?? 0.3;
  const step = Math.max(1, Math.floor(entries.length / sampleSize));
  let checked = 0;
  let broken = 0;

  for (let i = 0; i < entries.length && checked < sampleSize; i += step) {
    const entry = entries[i];
    if (entry.arguments && entry.arguments.length > 0) {
      checked++;
      continue;
    }
    const command = entry.command ?? '';
    if (!command.includes('@')) {
      checked++;
      continue;
    }
    checked++;
    if (hasMissingResponseFiles(command, entry.directory ?? projectRoot)) {
      broken++;
    }
  }

  return checked > 0 && broken / checked >= brokenThreshold;
}

export async function loadCompileCommands(projectRoot: string): Promise<CompileCommandEntry[]> {
  const compileDbPath = path.join(projectRoot, 'compile_commands.json');
  const raw = await fs.promises.readFile(compileDbPath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('compile_commands.json is not an array');
  }
  return parsed as CompileCommandEntry[];
}

export async function writeCompileCommandsAtomic(
  projectRoot: string,
  entries: CompileCommandEntry[],
): Promise<void> {
  const targetPath = path.join(projectRoot, 'compile_commands.json');
  const tempPath = path.join(
    projectRoot,
    `compile_commands.json.enginelink.${randomBytes(8).toString('hex')}.tmp`,
  );
  const body = `${JSON.stringify(entries, null, '\t')}\n`;
  try {
    await fs.promises.writeFile(tempPath, body, 'utf-8');
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Load, post-process, and write compile_commands.json at the project root.
 */
export async function postProcessCompileCommandsFile(
  projectRoot: string,
  engineRoot?: string,
): Promise<PostProcessResult> {
  const entries = await loadCompileCommands(projectRoot);
  const result = await postProcessCompileCommands(projectRoot, entries, engineRoot);
  await writeCompileCommandsAtomic(projectRoot, result.entries);
  return result;
}
