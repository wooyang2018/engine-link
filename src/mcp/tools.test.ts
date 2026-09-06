import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from './tools';

describe('EngineLink MCP boundary', () => {
  it('exposes only host-side differentiated tools', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names).toEqual([
      'enginelink_get_environment',
      'enginelink_doctor',
      'enginelink_build',
      'enginelink_clean',
      'enginelink_get_build_diagnostics',
      'enginelink_generate_compile_commands',
      'enginelink_get_editor_process',
      'enginelink_launch_editor',
      'enginelink_run_acceptance',
      'enginelink_get_run',
    ]);
    expect(names).not.toContain('enginelink_live_coding');
    expect(names).not.toContain('call_tool');
    expect(names).not.toContain('list_toolsets');
  });
});
