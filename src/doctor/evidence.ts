import type { McpToolOutput } from './unrealMcpClient';
import { parseJsonValue } from '../parsers/safeJson';

export type DoctorEvidenceSource = 'structuredContent' | 'textJson';

export interface DoctorEvidence<T> {
  value: T;
  evidenceSource: DoctorEvidenceSource;
  candidates: DoctorEvidenceSource[];
  parseWarnings: string[];
  conflict?: string;
}

export class DoctorEvidenceError extends Error {
  constructor(message: string, readonly raw?: unknown) { super(message); this.name = 'DoctorEvidenceError'; }
}

export class DoctorEvidenceConflictError extends DoctorEvidenceError {
  constructor(message: string, raw?: unknown) { super(message, raw); this.name = 'DoctorEvidenceConflictError'; }
}

export function resolveDoctorEvidence<T>(output: McpToolOutput, source: string): DoctorEvidence<T> {
  const candidates: Array<{ source: DoctorEvidenceSource; value: unknown }> = [];
  const warnings: string[] = [];
  if (output.structured !== undefined) {
    candidates.push({ source: 'structuredContent', value: unwrap(output.structured, `${source}:structuredContent`) });
  }

  const textCandidates = [
    ...output.content.filter((item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text').map((item) => item.text),
    output.text,
  ].filter((value, index, values) => value.trim() && values.indexOf(value) === index);
  for (const text of textCandidates) {
    const trimmed = text.replace(/^\uFEFF/, '').trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    try {
      candidates.push({ source: 'textJson', value: unwrap(parseJsonValue(trimmed, `${source}:text`), `${source}:text envelope`) });
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  const chosen = candidates.find((candidate) => candidate.source === 'structuredContent') ?? candidates[0];
  if (!chosen) throw new DoctorEvidenceError(`No usable Doctor evidence was found for ${source}. ${warnings.join(' ')}`.trim(), output);
  const chosenNormalized = canonical(chosen.value);
  const conflicts = candidates.filter((candidate) => canonical(candidate.value) !== chosenNormalized);
  return {
    value: chosen.value as T,
    evidenceSource: chosen.source,
    candidates: [...new Set(candidates.map((candidate) => candidate.source))],
    parseWarnings: warnings,
    ...(conflicts.length ? { conflict: `Evidence conflict: ${chosen.source} differs from ${[...new Set(conflicts.map((item) => item.source))].join(', ')}.` } : {}),
  };
}

export function unwrapNativeValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if ('returnValue' in value) return unwrapNativeValue(value.returnValue);
  return value;
}

function unwrap(value: unknown, source: string): unknown {
  if (!isRecord(value)) return value;
  if (typeof value.output === 'string') {
    const text = value.output.replace(/^\uFEFF/, '').trim();
    if (text.startsWith('{') || text.startsWith('[')) return unwrap(parseJsonValue(text, source), source);
  }
  return unwrapNativeValue(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
