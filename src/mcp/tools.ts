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
  tool('enginelink_get_environment', 'Return the host-side Unreal project, engine, toolchain, and build defaults.', {}),
  tool('enginelink_project_doctor_start', 'Start a persisted, read-only UE Project Doctor run. Returns immediately; poll enginelink_get_doctor_run for the terminal result.', {
    ...operationContext,
    mode: { type: 'string', enum: ['preflight', 'changed', 'scenario'], description: 'changed scans Git changes by default; scenario runs named project scenarios.' },
    paths: { type: 'array', items: { type: 'string' }, description: 'Optional project files or /Game asset paths to scan instead of Git changes.' },
    referenceQueries: { type: 'array', items: { type: 'string' }, description: 'Old or new /Game paths whose referencers and dependencies should be audited.' },
    scenarioNames: { type: 'array', items: { type: 'string' }, description: 'Scenario filenames (without .json) under the configured Doctor scenarios directory.' },
    baselineRunId: { type: 'string', description: 'Prior Doctor run to compare for resolved, persisting, introduced, and unverified issues.' },
  }),
  tool('enginelink_get_doctor_run', 'Read current progress or the final auditable report for a Project Doctor run.', {
    runId: { type: 'string', description: 'Doctor run identifier returned by enginelink_project_doctor_start.' },
  }, ['runId']),
  tool('enginelink_cancel_doctor_run', 'Cancel a Project Doctor run owned by this EngineLink process and request scenario teardown.', {
    runId: { type: 'string', description: 'Running Doctor run identifier.' },
  }, ['runId']),
  tool('enginelink_build', 'Run a cold UnrealBuildTool build. Refuses when this project is open in Unreal Editor; use Unreal MCP Live Coding for compatible in-editor changes.', buildOptions),
  tool('enginelink_clean', 'Clean UnrealBuildTool products. This is destructive and requires confirm=true.', {
    ...buildOptions,
    confirm: { type: 'boolean', description: 'Explicit confirmation that build products may be removed.' },
  }, ['confirm']),
  tool('enginelink_get_build_diagnostics', 'Return structured diagnostics from the most recent EngineLink cold build.', {}),
  tool('enginelink_generate_compile_commands', 'Generate and post-process project-root compile_commands.json for clangd.', buildOptions),
  tool('enginelink_get_editor_process', 'Return the Unreal Editor process associated with this project, if any.', {}),
  tool('enginelink_launch_editor', 'Launch Unreal Editor for this project, or return the existing project process.', operationContext),
  tool('enginelink_run_acceptance', 'Run the project-defined acceptance entrypoint and return the latest evidence path.', {
    ...operationContext,
    tier: { type: 'string', description: 'Project-defined acceptance tier, such as L1, L2, or L3.' },
    evidenceNotes: { type: 'string', description: 'Optional manual evidence notes for tiers that require them.' },
  }, ['tier']),
  tool('enginelink_get_run', 'Read one EngineLink host-side run record.', {
    runId: { type: 'string', description: 'Run identifier returned by another EngineLink tool.' },
  }, ['runId']),
] as const;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return {
    name,
    description,
    inputSchema: { type: 'object' as const, properties, ...(required.length ? { required } : {}) },
  };
}
