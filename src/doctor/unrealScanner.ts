import type { DoctorSeverity, UnrealScanResult } from './types';
import { callNativeTool, type UnrealMcpGateway } from './unrealMcpClient';
import { DoctorEvidenceConflictError, resolveDoctorEvidence, unwrapNativeValue, type DoctorEvidence } from './evidence';

export interface UnrealEvidenceResult<T> { data: T; evidence: DoctorEvidence<T>; raw: unknown }

export interface NativeToolRef { toolset: string; tool: string }

export interface NativeToolCatalog {
  pie?: NativeToolRef;
  openAssets?: NativeToolRef;
  dirtyPackages?: NativeToolRef;
  currentMap?: NativeToolRef;
  assetEdges?: NativeToolRef;
  blueprintInfo?: NativeToolRef;
}

export async function queryEditorState(gateway: UnrealMcpGateway, catalog: NativeToolCatalog): Promise<UnrealEvidenceResult<Record<string, unknown>>> {
  if (!catalog.pie) throw new Error('Unreal MCP has no IsPIERunning tool; enable AllToolsets.');
  const pieOutput = await callNativeTool(gateway, catalog.pie.toolset, catalog.pie.tool);
  if (pieOutput.isError) throw new Error(pieOutput.text || 'IsPIERunning failed.');
  const pieEvidence = evidenceResult<unknown>(pieOutput, 'IsPIERunning');
  const state: Record<string, unknown> = { pieRunning: asBoolean(unwrapNativeValue(pieEvidence.data)), dirtyPackages: [], openAssets: [] };

  if (catalog.openAssets) {
    const openOutput = await callNativeTool(gateway, catalog.openAssets.toolset, catalog.openAssets.tool);
    if (openOutput.isError) state.openAssetsError = openOutput.text || 'GetOpenAssets failed.';
    else {
      const openEvidence = evidenceResult<unknown>(openOutput, 'GetOpenAssets');
      state.openAssets = asStringArray(unwrapNativeValue(openEvidence.data));
    }
  }
  if (catalog.dirtyPackages) {
    const dirtyOutput = await callNativeTool(gateway, catalog.dirtyPackages.toolset, catalog.dirtyPackages.tool);
    if (dirtyOutput.isError) state.dirtyPackagesError = dirtyOutput.text || 'GetDirtyPackages failed.';
    else {
      const dirtyEvidence = evidenceResult<unknown>(dirtyOutput, 'GetDirtyPackages');
      state.dirtyPackages = asStringArray(unwrapNativeValue(dirtyEvidence.data));
    }
  }
  if (catalog.currentMap) {
    const mapOutput = await callNativeTool(gateway, catalog.currentMap.toolset, catalog.currentMap.tool);
    if (mapOutput.isError) state.currentMapError = mapOutput.text || 'GetCurrentMap failed.';
    else {
      const mapEvidence = evidenceResult<unknown>(mapOutput, 'GetCurrentMap');
      const value = unwrapNativeValue(mapEvidence.data);
      const record = asRecord(value);
      state.currentMap = typeof value === 'string' ? value : String(record?.currentMap ?? record?.map ?? record?.path ?? value ?? '');
    }
  }

  return {
    data: state,
    evidence: { ...pieEvidence.evidence, value: state },
    raw: { pie: pieOutput, state },
  };
}

export async function scanUnrealProject(
  gateway: UnrealMcpGateway,
  catalog: NativeToolCatalog,
  paths: string[],
): Promise<UnrealEvidenceResult<UnrealScanResult>> {
  const targets = unique(paths.map(toGamePath).filter(Boolean));
  const result: UnrealScanResult = { editor: {}, inventory: [], references: [], blueprints: [], missingTools: [] };
  if (!catalog.assetEdges) {
    result.missingTools.push('asset referencer/dependency tool');
    return { data: result, evidence: emptyEvidence(result), raw: result };
  }

  const output = await callNativeTool(gateway, catalog.assetEdges.toolset, catalog.assetEdges.tool, {
    paths: targets,
  }, { timeoutMs: 120_000 });
  if (output.isError) throw new Error(output.text || 'Asset dependency scan failed.');
  const evidence = evidenceResult<unknown>(output, 'asset edges');
  const payload = asRecord(unwrapNativeValue(evidence.data)) ?? asRecord(evidence.data) ?? {};
  result.inventory = asInventory(payload.inventory);
  result.references = asReferences(payload.references);
  result.blueprints = asBlueprints(payload.blueprints);

  if (catalog.blueprintInfo && result.blueprints.length === 0) {
    const infoOutput = await callNativeTool(gateway, catalog.blueprintInfo.toolset, catalog.blueprintInfo.tool, { paths: targets }, { timeoutMs: 120_000 });
    if (!infoOutput.isError) {
      const info = evidenceResult<unknown>(infoOutput, 'blueprint info');
      const infoPayload = asRecord(unwrapNativeValue(info.data)) ?? {};
      result.blueprints = asBlueprints(infoPayload.blueprints ?? infoPayload);
    }
  }

  return { data: result, evidence: { ...evidence.evidence, value: result }, raw: output };
}

export async function loadNativeToolCatalog(gateway: UnrealMcpGateway): Promise<NativeToolCatalog> {
  const tools = await gateway.listTools();
  if (!tools.includes('call_tool')) throw new Error('Unreal MCP does not expose call_tool. Enable the Unreal MCP plugin and AllToolsets.');
  const catalog: NativeToolCatalog = {};
  if (!tools.includes('list_toolsets') || !tools.includes('describe_toolset')) {
    catalog.pie = { toolset: 'EditorToolset.EditorAppToolset', tool: 'IsPIERunning' };
    catalog.openAssets = { toolset: 'EditorToolset.EditorAppToolset', tool: 'GetOpenAssets' };
    catalog.dirtyPackages = { toolset: 'EditorToolset.EditorAppToolset', tool: 'GetDirtyPackages' };
    catalog.currentMap = { toolset: 'EditorToolset.EditorAppToolset', tool: 'GetCurrentMap' };
    catalog.assetEdges = { toolset: 'AssetTools', tool: 'GetReferencersAndDependencies' };
    catalog.blueprintInfo = { toolset: 'BlueprintTools', tool: 'GetGraphIssues' };
    return catalog;
  }

  const listed = evidenceResult<unknown>(await gateway.call('list_toolsets', {}), 'list_toolsets');
  for (const toolset of extractToolsetNames(listed.data)) {
    const described = await gateway.call('describe_toolset', { toolset_name: toolset, toolsetName: toolset, name: toolset });
    if (described.isError) continue;
    const names = extractToolNames(evidenceResult<unknown>(described, `describe ${toolset}`).data);
    for (const tool of names) {
      if (!catalog.pie && /^IsPIERunning$/i.test(tool)) catalog.pie = { toolset, tool };
      if (!catalog.openAssets && /^GetOpenAssets$/i.test(tool)) catalog.openAssets = { toolset, tool };
      if (!catalog.dirtyPackages && /Get(Dirty|Unsaved)Packages/i.test(tool)) catalog.dirtyPackages = { toolset, tool };
      if (!catalog.currentMap && /GetCurrent(Map|Level)|GetEditorWorld/i.test(tool)) catalog.currentMap = { toolset, tool };
      if (!catalog.assetEdges && /Get(Package)?(Referencers|Dependencies)|GetReferencersAndDependencies/i.test(tool)) {
        catalog.assetEdges = { toolset, tool };
      }
      if (!catalog.blueprintInfo && /Get(Blueprint)?(CompileStatus|Info|GraphIssues)|CompileBlueprint/i.test(tool)) {
        catalog.blueprintInfo = { toolset, tool };
      }
    }
  }
  return catalog;
}

function evidenceResult<T>(raw: Awaited<ReturnType<UnrealMcpGateway['call']>>, source: string): UnrealEvidenceResult<T> {
  const evidence = resolveDoctorEvidence<T>(raw, source);
  if (evidence.conflict) throw new DoctorEvidenceConflictError(`${source}: ${evidence.conflict}`, raw);
  return { data: evidence.value, evidence, raw };
}

function emptyEvidence<T>(value: T): DoctorEvidence<T> {
  return { value, evidenceSource: 'structuredContent', candidates: ['structuredContent'], parseWarnings: [] };
}

function extractToolsetNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : String(asRecord(item)?.name ?? asRecord(item)?.toolset ?? '')).filter(Boolean);
  const record = asRecord(value);
  if (!record) return [];
  const nested = record.toolsets ?? record.toolsetNames ?? record.names ?? record.returnValue;
  return extractToolsetNames(nested);
}

function extractToolNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === 'string' ? item : String(asRecord(item)?.name ?? asRecord(item)?.tool ?? asRecord(item)?.tool_name ?? '')).filter(Boolean);
  }
  const record = asRecord(value);
  if (!record) return [];
  return extractToolNames(record.tools ?? record.toolNames ?? record.returnValue);
}

export function toGamePath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const marker = '/Content/';
  const lower = normalized.toLowerCase();
  const index = lower.indexOf(marker.toLowerCase());
  if (index >= 0) {
    let relative = normalized.slice(index + marker.length);
    if (/\.(uasset|umap)$/i.test(relative)) relative = relative.replace(/\.(uasset|umap)$/i, '');
    return `/Game/${relative}`;
  }
  if (normalized.startsWith('Content/')) {
    let relative = normalized.slice('Content/'.length);
    if (/\.(uasset|umap)$/i.test(relative)) relative = relative.replace(/\.(uasset|umap)$/i, '');
    return `/Game/${relative}`;
  }
  if (normalized.startsWith('/Game/')) return normalized.split('.')[0];
  return '';
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (isRecord(value) && typeof value.pieRunning === 'boolean') return value.pieRunning;
  return Boolean(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return item;
    const record = asRecord(item);
    return String(record?.refPath ?? record?.path ?? record?.assetPath ?? item);
  });
}

function asInventory(value: unknown): UnrealScanResult['inventory'] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item) ?? {};
    return { path: String(record.path ?? ''), class: String(record.class ?? '') };
  }).filter((item) => item.path);
}

function asReferences(value: unknown): UnrealScanResult['references'] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item) ?? {};
    const direction: 'dependency' | 'referencer' = record.direction === 'referencer' ? 'referencer' : 'dependency';
    return {
      from: String(record.from ?? ''),
      to: String(record.to ?? ''),
      direction,
      resolved: record.resolved !== false,
    };
  }).filter((item) => item.from && item.to);
}

function asBlueprints(value: unknown): UnrealScanResult['blueprints'] {
  const items = Array.isArray(value) ? value : Array.isArray(asRecord(value)?.blueprints) ? asRecord(value)!.blueprints as unknown[] : [];
  return items.map((item) => {
    const record = asRecord(item) ?? {};
    const issues = Array.isArray(record.issues) ? record.issues : [];
    return {
      path: String(record.path ?? ''),
      compileStatus: String(record.compileStatus ?? record.compile_status ?? 'Unknown'),
      issues: issues.map((issue) => {
        const row = asRecord(issue) ?? {};
        const severity: DoctorSeverity = row.severity === 'P0' || row.severity === 'P1' || row.severity === 'P2' ? row.severity : 'P2';
        return {
          ruleId: String(row.ruleId ?? 'blueprint.graph'),
          severity,
          graph: typeof row.graph === 'string' ? row.graph : undefined,
          node: typeof row.node === 'string' ? row.node : undefined,
          evidence: String(row.evidence ?? ''),
        };
      }),
    };
  }).filter((item) => item.path);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }
