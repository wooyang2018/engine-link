import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from './tools';

describe('EngineLink MCP boundary', () => {
  it('exposes only host-side differentiated tools', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names).toEqual([
      'enginelink_get_environment',
      'enginelink_project_doctor',
      'enginelink_build',
      'enginelink_clean',
      'enginelink_generate_compile_commands',
      'enginelink_launch_editor',
    ]);
    expect(names).not.toContain('enginelink_run_acceptance');
    expect(names).not.toContain('enginelink_get_run');
    expect(names).not.toContain('enginelink_live_coding');
    expect(names).not.toContain('call_tool');
    expect(names).not.toContain('list_toolsets');
  });

  it('does not accept targetType on compile-commands', () => {
    const compile = TOOL_DEFINITIONS.find((tool) => tool.name === 'enginelink_generate_compile_commands');
    expect(compile?.inputSchema.properties).toMatchObject({
      configuration: expect.anything(),
      platform: expect.anything(),
    });
    expect(compile?.inputSchema.properties).not.toHaveProperty('targetType');
  });

  it('project_doctor only accepts paths', () => {
    const doctor = TOOL_DEFINITIONS.find((tool) => tool.name === 'enginelink_project_doctor');
    expect(Object.keys(doctor?.inputSchema.properties ?? {})).toEqual(['paths']);
    expect(doctor?.inputSchema.properties).not.toHaveProperty('timeoutMs');
    expect(doctor?.inputSchema.properties).not.toHaveProperty('taskId');
    expect(doctor?.inputSchema.properties).not.toHaveProperty('reason');
    expect(doctor?.inputSchema.properties).not.toHaveProperty('referenceQueries');
    expect(doctor?.inputSchema.properties).not.toHaveProperty('baselineRunId');
  });
});
