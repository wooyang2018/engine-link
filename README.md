# EngineLink

🌐 [enginelink.dev](https://enginelink.dev)

**Host-side Unreal Engine development bridge** — discover, cold-build, launch, and diagnose UE projects from Cursor, CLI, or an AI agent.

EngineLink owns work **outside** Unreal Editor: `.uproject` / engine / VS toolchain discovery, UnrealBuildTool cold builds, Editor process launch, `compile_commands.json` for clangd, and Project Doctor. Editor-side assets, PIE, transactions, and Live Coding belong to Unreal’s native MCP. The two MCP servers are independent. EngineLink does not assume VibeUE and does not run gameplay tests.

Current version: **0.2.1**. Host discovery and Editor-process checks are **Windows-first**.

> Early preview. Contributions and feedback are welcome.

---

## What it does

Three entry points share [`EngineLinkService`](src/core/service.ts):

| Entry | How |
|---|---|
| Cursor extension | Activates on `**/*.uproject`. Status bar, commands, Tasks, IntelliSense sidecar. |
| MCP | `node dist/mcp-server.js --project <root>` (stdio, tools only). |
| CLI | `node dist/cli.js <command> --project <root>` (or `npx enginelink` after install). |

Cursor **build / clean / generate / launch** go through the same Service as MCP/CLI. Tasks: `compile-commands` shells `node dist/cli.js compile-commands`; `build` / `clean` spawn UBT directly so the Tasks panel can stream output.

---

## Setup

### 1. Prerequisites

- **Windows**
- **Unreal Engine 5.4+** via [Epic Games Launcher](https://www.unrealengine.com/) or a source/custom install. Tested on **UE 5.4–5.7**.
- **Visual Studio** (Community / Build Tools / etc.) with **Desktop development with C++** (MSVC + Windows SDK).
- **C++ Clang Compiler for Windows** if you want `compile_commands.json` (UBT `GenerateClangDatabase`). Builds still use MSVC without Clang.
- [Cursor](https://cursor.sh) `1.85.0` or later (VS Code engine `^1.85.0`).

### 2. Install EngineLink

Marketplace listing is not published yet.

**From source:**

```bash
git clone https://github.com/rmoubayed/engine-link.git
cd engine-link
npm install
npm run build
```

Press `F5` for the Extension Development Host, or package/install:

```bash
npm run package          # vsce → .vsix
npm run install:vsix     # Scripts/Install-EngineLink.ps1 (build, test, install into Cursor)
```

In Cursor: **Extensions → … → Install from VSIX…**

EngineLink is an **extension pack** that pulls **[C/C++ for Cursor](https://marketplace.visualstudio.com/items?itemName=anysphere.cpptools)** (`anysphere.cpptools`) for clangd.

### 3. Open a project

Open a folder that contains a `.uproject`. EngineLink activates, discovers the project and engine, optionally generates `compile_commands.json`, upserts a managed `.clangd` block and `.vscode/settings.json`, and registers the MCP server for Cursor / Codex / Claude Code.

If detection fails, set `enginelink.engineRoot` / `enginelink.projectFile` (extension) or `ENGINELINK_ENGINE_ROOT` (CLI/MCP).

---

## IntelliSense (`compile_commands.json` + clangd)

UBT often writes the database next to the **engine**. EngineLink **places** it at the **project root** (`placeCompileCommands`: UBT log path → engine root → `Intermediate/Build` search), then **post-processes** it for clangd (inline `@*.rsp`, Unity `Module.*.cpp` remap, header entries, engine-source navigation).

**Who generates it**

- Activation, if the file is missing or still broken after post-process, when `enginelink.autoGenerateCompileCommands` is true.
- Command **Generate compile_commands.json**, MCP `enginelink_generate_compile_commands`, CLI `compile-commands`, or a Task with `action: generateCompileCommands`.

All of those UBT runs go through `EngineLinkService`. The Cursor command and activation then update `.clangd` (`templateFlags`, forced includes, IDE overrides header in extension globalStorage) and try `clangd.restart`. **MCP/CLI do not** touch `.clangd` or restart clangd.

**Cold `build` does not refresh** the compile database. A normal Editor UBT build can invalidate per-file `.rsp` files; run **Generate compile_commands.json** if IntelliSense breaks after a regular build.

**`.clangd`:** on activation EngineLink upserts only the `# <<< enginelink-managed >>>` region (`builtin_definition` suppress, `--query-driver=**/clang-cl.exe`, later engine PathMatch from post-process). Disable with `enginelink.upsertClangdConfig: false`.

**`.vscode/settings.json`:** managed block sets `C_Cpp.default.compileCommands` to `${workspaceFolder}/compile_commands.json` and `clangd.arguments` `--query-driver`. EngineLink **does not** set `--compile-commands-dir` (one clangd per window would pin every multi-root folder to one database).

---

## Quick start

1. Open a folder with a `.uproject`.
2. Status bar: Build, Clean, configuration, target type, platform, project, engine, Launch.
3. **`Ctrl+Shift+B`** runs EngineLink Build (when `enginelink.projectDetected`).
4. For agents: `enginelink_get_environment` → close Editor if you need a cold build → `enginelink_build` → `enginelink_generate_compile_commands` if clangd needs a fresh DB → `enginelink_launch_editor` → `enginelink_project_doctor`. Asset/PIE/Live Coding → Unreal MCP.

---

## Commands

| Command | Binding | Notes |
|---|---|---|
| **Build** | `Ctrl+Shift+B` | Cold UBT. On Windows, **refuses** if `UnrealEditor.exe` already has this `.uproject` on its command line. |
| **Clean** | — | Modal confirm in the UI; MCP/CLI need `confirm=true` / `--confirm`. |
| **Launch Unreal Editor** | — | `UnrealEditor.exe <uproject>` only. If that project is already open, returns the existing process (does not spawn another). |
| **Generate compile_commands.json** | — | `GenerateClangDatabase` + place + post-process + `.clangd` + `clangd.restart`. |
| **Select Engine / Project / Configuration / Target Type** | — | Writes Cursor `enginelink.*` settings. |

Build and Launch also appear on the editor title **run** group; Clean / Generate / config picks on the title menu. All of those `when` clauses require `enginelink.projectDetected`.

UBT Editor target names come from `Source/**/*.Target.cs` (not `Plugins/`): conventional `{Project}Editor`, primary Runtime module, or the single discovered Editor target. Ambiguous Editor targets **throw**; there is no override file.

---

## Configuration

Cursor / VS Code `enginelink.*` (workspace or user). CLI/MCP **do not** read these; they resolve the engine via `ENGINELINK_ENGINE_ROOT`, then registry / `D:\Software\UE_<association>` / Epic Games paths.

| Setting | Default | Description |
|---|---|---|
| `enginelink.engineRoot` | `""` | Manual engine root for the extension. |
| `enginelink.projectFile` | `""` | Absolute `.uproject` if several exist. CLI/MCP require **exactly one** `.uproject` in the project root. |
| `enginelink.buildConfiguration` | `Development` | Debug / DebugGame / Development / Shipping / Test |
| `enginelink.buildTarget` | `Editor` | Editor / Game / Client / Server (type, not a specific target name) |
| `enginelink.platform` | `Win64` | Passed to UBT |
| `enginelink.autoGenerateCompileCommands` | `true` | Generate/repair compile DB on **activation** |
| `enginelink.upsertClangdConfig` | `true` | Maintain the managed `.clangd` region |
| `enginelink.vsBuildTools.path` | `""` | vswhere override |
| `enginelink.statusBar.showContextInfo` | `true` | Show platform + project name on the status bar |

There is **no** `.enginelink/project.json`. Leftover files in that folder are ignored.

---

## MCP and CLI

The extension never owns the MCP process. On activation it upserts **only** the `enginelink` server entry:

| Client | File |
|---|---|
| Cursor | `.cursor/mcp.json` |
| Codex | `.codex/config.toml` (`[mcp_servers.enginelink]`) |
| Claude Code | `.mcp.json` |

| MCP | CLI | Result |
|---|---|---|
| `enginelink_get_environment` | `environment` | `enginelink.environment.v1` |
| `enginelink_project_doctor` | `project-doctor` | `enginelink.doctor-view.v1` (sync, may take minutes) |
| `enginelink_build` | `build` | `enginelink.run.v1` |
| `enginelink_clean` | `clean --confirm` | `enginelink.run.v1` |
| `enginelink_generate_compile_commands` | `compile-commands` | `enginelink.run.v1` |
| `enginelink_launch_editor` | `launch` | `{ launched, existing, pid? / process? }` |

Shared flags (not on `project-doctor`): MCP `taskId` / `reason`; CLI `--task-id` / `--reason`. Build/clean also take `configuration` / `targetType` / `platform` (`--configuration` / `--target` / `--platform`). Compile-commands: `configuration` / `platform` only; target is always Editor. Defaults: Development / Editor / Win64.

Doctor: optional `paths` / repeated `--path`; CLI `--timeout-ms` (internal default 180s). Connects to Unreal MCP at `http://127.0.0.1:8000/mcp`.

MCP `isError` is true only on thrown errors or `enginelink.run.v1` with `success === false`. A Doctor `failed` / `incomplete` view is **not** `isError`. CLI exits 1 on failed runs and unsuccessful Doctor statuses.

**Disk:** successful or blocked **build** overwrites `Saved/EngineLink/latest-build.json` (Doctor’s authoritative cold-build pointer). Clean / compile-commands / launch are return-body only. Doctor writes `Saved/EngineLink/Doctor/` and `doctor.lock`.

```powershell
node dist/cli.js environment --project D:/Workspace/MyGame
node dist/cli.js build --project D:/Workspace/MyGame --reason "verify C++ change"
node dist/cli.js compile-commands --project D:/Workspace/MyGame
node dist/cli.js project-doctor --project D:/Workspace/MyGame --path Content/BP/BP_Test.uasset
```

Details: [docs/mcp-tools.md](docs/mcp-tools.md), [docs/project-doctor.md](docs/project-doctor.md). Agent routing notes: [docs/learning-agents.md](docs/learning-agents.md). Gameplay tests stay in the game project (see [docs/cqtest-study-notes.md](docs/cqtest-study-notes.md)).

---

## Tasks

`enginelink` task type for `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "enginelink",
      "action": "build",
      "configuration": "Development",
      "targetType": "Editor",
      "label": "EngineLink: Build Editor (Development)"
    }
  ]
}
```

`action`: `build` | `clean` | `generateCompileCommands`. Problem matchers: `$enginelink-msvc`, `$enginelink-ubt`.

---

## Unreal C++ conventions

EngineLink does **not** write `.cursor/rules/*.mdc`, `AGENTS.md`, or `CLAUDE.md`. Study notes: [docs/ue-cpp-study-notes.md](docs/ue-cpp-study-notes.md).

---

## Development

```bash
npm install
npm run build        # esbuild → dist/extension.js, dist/mcp-server.js, dist/cli.js
npm run watch
npm run lint
npm run format
npm run typecheck
npm run test         # vitest, src/**/*.test.ts
npm run package      # vsce (runs build first)
```

Open this repo in Cursor, `F5`, then open a UE project in the new window.

### Source layout

```
src/
├── extension.ts                 # Activation, commands, detection pipeline
├── cli.ts                       # CLI
├── mcp/server.ts                # MCP stdio
├── mcp/tools.ts                 # Six tool schemas
├── mcp/clientRegistration.ts    # Project-level MCP upsert
├── core/service.ts              # Shared operations
├── core/config.ts               # Find unique .uproject
├── core/discovery.ts            # CLI/MCP project + engine
├── core/runStore.ts             # latest-build.json
├── doctor/                      # Project Doctor
├── commands/                    # Cursor adapters + clangd sidecar
│   ├── coreCommands.ts
│   └── generateCommands.ts
├── build/ubt.ts + taskProvider.ts
├── cursor/                      # compile DB place/post-process, .clangd, settings
├── detection/                   # Extension project/engine/VS discovery
├── parsers/
├── platform/
├── config/settings.ts
└── ui/statusBar.ts, outputChannel.ts
```

---

## Contributing

1. Fork and branch
2. `npm run lint && npm run typecheck && npm run test`
3. Open a pull request

Helpful areas: more tests; Linux/macOS host discovery and Editor-process detection.

---

## License

[MIT](LICENSE) © 2026 EngineLink
