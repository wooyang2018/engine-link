const operationContext = {
  taskId: { type: 'string', description: 'Optional cross-system task identifier.' },
  reason: { type: 'string', description: 'Why this operation is being performed; stored in the run record.' },
};

const buildOptions = {
  ...operationContext,
  configuration: { type: 'string', enum: ['Debug', 'DebugGame', 'Development', 'Shipping', 'Test'] },
  targetType: { type: 'string', enum: ['Editor', 'Game', 'Client', 'Server'] },
  platform: { type: 'string', enum: ['Win64', 'Linux', 'Mac'] },
};

export const TOOL_DEFINITIONS = [
  tool('enginelink_get_environment', 'Return the host-side Unreal project, engine, toolchain, build defaults, and current Editor process.', {}),
  tool('enginelink_project_doctor', 'Run a read-only UE Project Doctor diagnostic to completion. Returns status, coverage, issues, and reportPath. May take minutes while talking to Unreal MCP.', {
    paths: { type: 'array', items: { type: 'string' }, description: 'Optional project files or /Game asset paths to scan instead of Git changes.' },
  }),
  tool('enginelink_build', 'Run a cold UnrealBuildTool build. Refuses when this project is open in Unreal Editor; use Unreal MCP Live Coding for compatible in-editor changes.', buildOptions),
  tool('enginelink_clean', 'Clean UnrealBuildTool products. This is destructive and requires confirm=true.', {
    ...buildOptions,
    confirm: { type: 'boolean', description: 'Explicit confirmation that build products may be removed.' },
  }, ['confirm']),
  tool('enginelink_generate_compile_commands', 'Generate and post-process project-root compile_commands.json for clangd.', {
    ...operationContext,
    configuration: { type: 'string', enum: ['Debug', 'DebugGame', 'Development', 'Shipping', 'Test'] },
    platform: { type: 'string', enum: ['Win64', 'Linux', 'Mac'] },
  }),
  tool('enginelink_launch_editor', 'Launch Unreal Editor for this project, or return the existing project process.', operationContext),
] as const;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return {
    name,
    description,
    inputSchema: { type: 'object' as const, properties, ...(required.length ? { required } : {}) },
  };
}
