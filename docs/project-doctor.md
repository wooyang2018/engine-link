# UE Project Doctor

Project Doctor is a read-only, evidence-oriented diagnostic runner for a local Unreal Editor. It focuses on the current Git change and affected assets instead of treating a full-project inventory as a product of its own.

## Modes

- `preflight` checks the host toolchain and engine layout (Visual Studio/SDK, clang-cl, UBT/Editor binaries), then the Editor process, VibeUE readiness and heartbeat, Unreal MCP capability, current map, PIE, dirty packages, open asset editors, latest real build record, and the run-scoped log.
- `changed` adds Asset Registry dependency/referencer checks, Blueprint compile and graph checks, and project rules. With no `--path`, Git status defines the initial scope.
- `scenario` segments VibeUE-native steps and lets EngineLink perform sustained input, runtime sampling, high-level assertions, captured evidence, and authoritative teardown between those segments.

Runs are asynchronous over MCP. Start with `enginelink_project_doctor_start`, poll `enginelink_get_doctor_run`, and use `enginelink_cancel_doctor_run` to request cancellation.

Reports and raw evidence are written beneath `Saved/EngineLink/Doctor/Runs/<run-id>/`. `enginelink.doctor-run.v1` is the only schema. Its terminal status is:

- `passed`: every requested check completed and there are no findings;
- `passed_with_findings`: every requested check completed and only P2 findings remain;
- `failed`: an executed check failed or a P0/P1 issue exists;
- `incomplete`: a prerequisite, check, or trustworthy evidence source is unavailable or conflicting;
- `cancelled`: the caller cancelled the run.

`summary` always records `total`, the P0/P1/P2 and confirmed/inferred/unconfirmed counts, `checksComplete`, `hasFindings`, and `hasBlockingIssues`. The CLI exits 0 for `passed` and `passed_with_findings`, and 1 for every other terminal status. There is deliberately no legacy status/schema translation because Doctor has not been released.

Build evidence contains one `authoritative` candidate and a separate `history` list. Only a real succeeded/failed build for the same project, current session/build-and-launch window, and source state can be authoritative. Blocked, running, skipped, stale, old-PID, old-session, and superseded records stay in history and do not affect status. Multiple Editors for the same project make the run incomplete before MCP or PIE work begins.

## Project configuration

Optional settings live in `.enginelink/project.json`. Paths must be relative to the project root, and the Unreal MCP URL must use a loopback host.

```json
{
  "schemaVersion": 1,
  "uproject": "MyGame.uproject",
  "unrealMcp": {
    "url": "http://127.0.0.1:8000/mcp",
    "connectTimeoutMs": 5000,
    "requestTimeoutMs": 60000
  },
  "doctor": {
    "rulesDirectory": ".enginelink/doctor/rules",
    "scenariosDirectory": ".enginelink/doctor/scenarios"
  }
}
```

## Rules

A rule file is either a JSON array or an object containing a `rules` array. Each rule has a stable `id`, a `domain`, a `P0`/`P1`/`P2` severity, a description, and kind-specific parameters.

```json
{
  "rules": [
    {
      "id": "input.old-context-cleared",
      "kind": "reference_absent",
      "domain": "input",
      "severity": "P1",
      "description": "The retired input context must have no remaining references.",
      "params": { "from": "/Game/Characters/BP_Player", "to": "/Game/Input/IMC_Old" }
    },
    {
      "id": "gas.end-ability-reachable",
      "kind": "blueprint_path_reaches",
      "domain": "gas",
      "severity": "P1",
      "description": "Ability activation must reach EndAbility.",
      "params": {
        "asset": "/Game/Abilities/GA_Example",
        "graph": "EventGraph",
        "from": "ActivateAbility",
        "to": "EndAbility"
      }
    }
  ]
}
```

Supported kinds are `asset_exists`, `asset_absent`, `reference_exists`, `reference_absent`, `config_contains`, `config_absent`, `property_equals`, `blueprint_node_present`, `blueprint_node_absent`, and `blueprint_path_reaches`. Config paths are confined to the project root. Arbitrary Python rules are intentionally unsupported.

## Scenarios

Scenario files combine VibeUE WorkflowService actions with EngineLink Doctor actions. Project Doctor refuses to take over an existing PIE session or switch away from a dirty map. It snapshots the map, PIE client setting, and background-throttling state, releases active input, stops only the PIE session it started, and restores settings after success, failure, cancellation, or timeout.

```json
{
  "schema": "enginelink.doctor-scenario.v1",
  "name": "single-client-smoke",
  "map": "/Game/Maps/TestMap",
  "clients": 1,
  "timeoutSeconds": 90,
  "preflight": { "compile_blueprints": ["/Game/Characters/BP_Player"] },
  "steps": [
    { "action": "start_pie" },
    { "action": "wait_for_pie", "timeout_seconds": 30 },
    { "action": "wait_for_local_players", "count": 1, "timeoutMs": 20000 },
    { "action": "input_action_bound", "context": "/Game/Input/IMC_Default.IMC_Default", "path": "/Game/Input/IA_Move.IA_Move", "key": "W" },
    { "action": "snapshot_player", "name": "before" },
    { "action": "inject_action", "path": "/Game/Input/IA_Move.IA_Move", "value": { "type": "Axis2D", "x": 0, "y": 1 }, "repeat": 20, "intervalMs": 16 },
    { "action": "wait", "seconds": 0.25 },
    { "action": "snapshot_player", "name": "after" },
    { "action": "actor_location_changed", "from": "before", "to": "after", "minDistance": 10 },
    { "action": "capture_game", "name": "after-jump" }
  ],
  "teardown": { "stop_pie": true }
}
```

`inject_action` retains the one-shot `path + x/y/z` form. `value` accepts Boolean, Axis1D, Axis2D, or Axis3D values. `repeat` and `durationMs` are mutually exclusive; `intervalMs`, `duration_ms`, and `interval_ms` are accepted. Duration is capped at 300 seconds and injection count at 10,000. Repeated/duration input releases to zero by default; one-shot input retains its prior non-release behavior. Cancellation, timeout, or PIE failure triggers an emergency release attempt.

EngineLink actions are `wait_for_local_players`, `snapshot_player`, `actor_location_changed`, `actor_rotation_changed`, `control_rotation_changed`, `control_rotation_in_range`, `player_camera_pitch_limits`, `input_action_bound`, `gameplay_tag_present`, and `gameplay_tag_absent`. Failure evidence includes the map, LocalPlayer/Pawn data, input parameters and actual count, before/after snapshots, failed assertion, captures, and teardown result. See `examples/doctor/scenarios/input-camera-smoke.json` for a copyable scenario.

## JSON and MCP evidence

All external JSON inputs use one parser that handles UTF-8/UTF-16 BOMs, CRLF/LF, whitespace, empty input, and balanced JSON embedded in logs. Parse errors report source, detected encoding, position, length, SHA-256, and a redacted summary. Doctor preserves raw MCP responses as run artifacts.

MCP result priority is `structuredContent`, complete JSON text/envelope, persisted VibeUE artifact, then `ENGINELINK_DOCTOR_RESULT`. A valid high-priority result is retained when a lower-priority marker is malformed (with a warning); valid sources that disagree make the phase and final run `incomplete`.

## CLI

```powershell
node dist/cli.js project-doctor --project D:/Workspace/MyGame --mode changed
node dist/cli.js project-doctor --project D:/Workspace/MyGame --mode changed --path /Game/Characters/BP_Player --reference /Game/Input/IMC_Old
node dist/cli.js project-doctor --project D:/Workspace/MyGame --mode scenario --scenario single-client-smoke
node dist/cli.js doctor-run --project D:/Workspace/MyGame --id 20260912T120000Z-doctor-abcd1234
node dist/cli.js doctor-cancel --project D:/Workspace/MyGame --id 20260912T120000Z-doctor-abcd1234
```

Pass `--baseline <run-id>` to repeat a verification run. If scope arguments are omitted, EngineLink reuses the baseline scope. Explicitly changing that scope is rejected. Rules are loaded from the baseline run snapshot, so removed or edited rule files cannot turn an unexecuted check into a resolved issue.
