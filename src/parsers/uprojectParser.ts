import * as fs from 'fs';
import type { UProjectData, UEProjectModule } from '../types';
import { parseJsonValue } from './safeJson';

/**
 * Parse a .uproject file and return structured data.
 */
export async function parseUProject(filePath: string): Promise<UProjectData> {
  const content = await fs.promises.readFile(filePath);
  const json = parseJsonValue<Record<string, unknown>>(content, filePath);

  const modules: UEProjectModule[] = (Array.isArray(json.Modules) ? json.Modules : []).map((m: Record<string, string>) => ({
    name: m.Name ?? '',
    type: m.Type ?? 'Runtime',
    loadingPhase: m.LoadingPhase ?? 'Default',
  }));

  const plugins: Array<{ name: string; enabled: boolean }> = (Array.isArray(json.Plugins) ? json.Plugins : []).map(
    (p: Record<string, unknown>) => ({
      name: (p.Name as string) ?? '',
      enabled: (p.Enabled as boolean) ?? true,
    }),
  );

  return {
    fileVersion: typeof json.FileVersion === 'number' ? json.FileVersion : 3,
    engineAssociation: typeof json.EngineAssociation === 'string' ? json.EngineAssociation : '',
    category: typeof json.Category === 'string' ? json.Category : '',
    description: typeof json.Description === 'string' ? json.Description : '',
    modules,
    plugins,
  };
}
