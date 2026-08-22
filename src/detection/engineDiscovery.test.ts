import { describe, expect, it } from 'vitest';
import {
  formatManualInstallationFailure,
  parseVersionFromEngineRoot,
} from './engineInstallationUtils';

describe('parseVersionFromEngineRoot', () => {
  it('parses UE_5.8 style folder names', () => {
    expect(parseVersionFromEngineRoot('D:\\Software\\UE_5.8')).toBe('5.8');
    expect(parseVersionFromEngineRoot('/opt/Unreal/UE_5.4')).toBe('5.4');
  });

  it('falls back to manual for non-standard paths', () => {
    expect(parseVersionFromEngineRoot('D:\\Custom\\UnrealEngine')).toBe('manual');
  });
});

describe('formatManualInstallationFailure', () => {
  it('includes the expected UBT path', () => {
    const message = formatManualInstallationFailure('D:\\Software\\UE_5.8');
    expect(message).toContain('enginelink.engineRoot is invalid');
    expect(message).toContain('UnrealBuildTool.exe');
    expect(message).toContain('UE_5.8');
  });
});
