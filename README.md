# EngineLink

🌐 [enginelink.dev](https://enginelink.dev)

**Host-side Unreal Engine development bridge** — discover, build, launch, diagnose, and verify UE projects from an IDE, CLI, or AI agent.

EngineLink owns the work that happens outside Unreal Editor: project/toolchain discovery, cold UBT builds, Editor process launch, compile databases, diagnostics, and project acceptance commands. Editor-side assets, PIE, transactions, and Live Coding belong to Unreal's native MCP and extensions such as VibeUE. The two MCP servers are independent and either can be used without the other.

> 🧪 **Status:** Early preview. Windows-only for now.

> 👋 **TL;DR:** I've been building software for 10 years but game dev is new to me. As I learn Unreal Engine, I found Rider and Visual Studio to be old-fashioned compared to modern AI-first editors — so I decided to give Cursor full UE capabilities. I'm testing this extension as I go, learning and breaking things along the way. Contributions and feedback are very welcome :)

---

## Setup Guide

Getting EngineLink running is a three-step process: install the system prerequisites, install EngineLink, then install the C/C++ extension for IntelliSense.

### Step 1 — System Prerequisites

You need **Windows**, **Unreal Engine**, and **Visual Studio** with the right components.

#### Unreal Engine 5.4+

Install via the [Epic Games Launcher](https://www.unrealengine.com/). EngineLink has been tested on **UE 5.4 – 5.7**.

#### Visual Studio with C++ and Clang

Open **Visual Studio Installer**, click **Modify** on your install (Community / Build Tools / etc.), and make sure these components are enabled:

**Workload:**
- **Desktop development with C++** (this gives you MSVC, Windows SDK, and the core build tools UE needs)

**Individual Components** (search in the installer):
- **C++ Clang Compiler for Windows** — needed by UBT to generate `compile_commands.json` for IntelliSense
- **MSBuild support for LLVM (clang-cl) toolset** *(optional but recommended)*

> If you skip Clang, EngineLink will still build your project fine (UE uses MSVC), but `compile_commands.json` generation will fail and you won't get full IntelliSense. You can always add Clang later.

#### Cursor

Install [Cursor](https://cursor.sh) (version `1.85.0` or later).

---

### Step 2 — Install EngineLink

**From Marketplace** — *coming soon.*

**From VSIX** — download or build the `.vsix`, then in Cursor: **Extensions → ... → Install from VSIX...**

**From Source:**

```bash
git clone https://github.com/rmoubayed/engine-link.git
cd engine-link
npm install
npm run build
```

Press `F5` to launch the Extension Development Host, or package it with `npm run package`.

---

### Step 3 — C/C++ for Cursor (IntelliSense — installed automatically)

EngineLink handles **building** your project, but you need a language server for **IntelliSense** (code completion, go-to-definition, diagnostics on the fly).

EngineLink is an **extension pack** that automatically installs **[C/C++ for Cursor](https://marketplace.visualstudio.com/items?itemName=anysphere.cpptools)** — Cursor's official C/C++ extension. It adds LSP, debugging, and code browsing support using **clangd** under the hood. You don't need to install it separately.

#### Where `compile_commands.json` lives

UnrealBuildTool often writes the database next to the **engine** (e.g. `UE_5.7\compile_commands.json`). **EngineLink always copies it to your `.uproject` folder** as `compile_commands.json` at the **project root** after a successful run, so **clangd** can find it when you open files under `Source/` (it walks up to the workspace root).

If IntelliSense still cannot find the compilation database (e.g. generation failed or you use a non-standard layout), you can point clangd at the engine folder manually in **`.vscode/settings.json`**:

```json
{
  "clangd.arguments": [
    "--compile-commands-dir=C:/Program Files/Epic Games/UE_5.7"
  ]
}
```

Use the **directory** that contains `compile_commands.json`, forward slashes, then reload the window.

#### MSVC intrinsic false positives (builtin_definition)

When clangd parses UE code with MSVC-style headers, you may see **"definition of builtin function"** errors on system headers. This is a known clangd/MSVC quirk, not an error in your code — the real UE build is unaffected.

**EngineLink handles this automatically.** On activation it upserts a managed block in your project's `.clangd` file:

```yaml
# <<< enginelink-managed >>>
Diagnostics:
  Suppress: builtin_definition
CompileFlags:
  Add:
    - --query-driver=**/clang-cl.exe
# <<< end-enginelink-managed >>>
```

This only suppresses that one diagnostic class. EngineLink replaces only its own managed region and won't touch the rest of your `.clangd`. To disable: set `enginelink.upsertClangdConfig` to `false`.

#### Stale `compile_commands.json` and merged (unity) builds

UBT's normal Editor build often compiles many `.cpp` files through auto-generated `Module.*.cpp` **merged compilation** units. The `compile_commands.json` UBT emits separately can still reference per-file `@*.obj.rsp` response files that no longer exist after a regular build — clangd then fails to resolve engine headers (e.g. `'Animation/AnimInstance.h' file not found`).

**EngineLink handles this automatically:**

1. UBT generation uses `-NoExecCodeGenActions` and `-OutputDir=<project root>` for faster, correctly placed output.
2. After generation (and after successful builds when `enginelink.autoGenerateCompileCommands` is enabled), EngineLink **post-processes** `compile_commands.json`:
   - Inlines `@*.rsp` into clangd-friendly `arguments` arrays
   - Remaps broken per-file entries via `Module.*.cpp` when merged builds are in use
   - Adds matching `.h` entries so opening headers gets a compilation unit
3. On activation, if the database looks stale (many missing `.rsp` files), EngineLink post-processes it and regenerates when entries are still broken.

EngineLink also upserts `.vscode/settings.json` in the UE project folder so `clangd` and C/C++ use `${workspaceFolder}/compile_commands.json` in multi-root workspaces.

If IntelliSense is still wrong after a normal UBT build, run **Generate compile_commands.json** once, then reload the window. Engine source navigation (F12 into `UAnimInstance`, etc.) works once include paths resolve — you do not need to add the engine source tree to git or the workspace.

---

## Quick Start

Once everything is installed:

1. Open a folder containing a `.uproject` file in Cursor
2. EngineLink activates automatically and:
   - Finds your `.uproject` and parses `EngineAssociation`
   - Discovers the matching UE installation from the registry
   - Locates VS Build Tools
   - Generates Cursor rules (`.cursor/rules/*.mdc`)
   - Generates `compile_commands.json` (if Clang is installed)
   - Creates/updates `.clangd` for MSVC suppression
3. The status bar shows your project name, engine version, and build actions
4. Press **`Ctrl+Shift+B`** to build

If auto-detection fails, override paths in [Configuration](#configuration).

---

## Features

### Build Integration

- **Build / Clean** — invoke UnrealBuildTool directly with full output streaming
- **Editor-aware cold builds** — refuses a full build while the same project is open and points agents to Unreal MCP for compatible Live Coding work
- **`compile_commands.json`** — auto-generates via UBT's `GenerateClangDatabase` mode, post-processes `@*.rsp` for clangd, and refreshes after builds when enabled
- **`.clangd` management** — suppresses MSVC/Clang `builtin_definition` false positives and sets `--query-driver` for clang-cl

### Auto-Detection

- **Project** — scans workspace for `.uproject` files, parses `EngineAssociation`
- **Engine** — reads Windows registry (launcher + source builds) and common paths
- **Build tools** — locates Visual Studio via `vswhere`

### AI Integration

- **Independent MCP server** — runs without VS Code and exposes only host-side EngineLink operations
- **CLI** — exposes the same core operations to humans and CI
- **Multi-client snippets** — generates separate EngineLink and Unreal MCP entries for Codex, Cursor, and Claude Code
- **Cursor rules** — generates `.cursor/rules/*.mdc` files so the AI writes idiomatic Unreal C++

### Editor UX

- **Status bar** — project name, engine version, build config, and action buttons
- **Problems panel** — MSVC and UBT errors surfaced as native diagnostics
- **Progress notifications** — build progress via spinner and toast
- **Task provider** — `enginelink` tasks for the Tasks panel and `tasks.json`

---

## Commands

| Command | Keybinding | Description |
|---|---|---|
| **Build** | `Ctrl+Shift+B` | Build the project via UnrealBuildTool |
| **Clean** | — | Remove build artifacts |
| **Launch Unreal Editor** | — | Open UnrealEditor.exe with the current project |
| **Generate compile_commands.json** | — | Run UBT `GenerateClangDatabase` |
| **Select Engine Installation** | — | Pick from discovered engine installs |
| **Select UE Project** | — | Pick from detected `.uproject` files |
| **Select Build Configuration** | — | Debug / DebugGame / Development / Shipping / Test |
| **Select Build Target Type** | — | Editor / Game / Client / Server |

Build and Launch also appear as icon buttons in the editor title bar.

---

## Configuration

All settings live under `enginelink.*` in your workspace or user `settings.json`.

| Setting | Type | Default | Description |
|---|---|---|---|
| `enginelink.engineRoot` | `string` | `""` | Manual override for the UE root directory |
| `enginelink.projectFile` | `string` | `""` | Path to a specific `.uproject` file |
| `enginelink.buildConfiguration` | `enum` | `Development` | `Debug`, `DebugGame`, `Development`, `Shipping`, `Test` |
| `enginelink.buildTarget` | `enum` | `Editor` | `Editor`, `Game`, `Client`, `Server` |
| `enginelink.platform` | `string` | `Win64` | Target platform |
| `enginelink.autoGenerateCompileCommands` | `boolean` | `true` | Auto-generate `compile_commands.json` on detection (needs Clang) |
| `enginelink.upsertClangdConfig` | `boolean` | `true` | Auto-update `.clangd` with `builtin_definition` suppression |
| `enginelink.vsBuildTools.path` | `string` | `""` | Manual override for VS Build Tools path |
| `enginelink.statusBar.showContextInfo` | `boolean` | `true` | Show platform and project name in the status bar |

---

## MCP Server (AI Agent Tools)

EngineLink ships a standalone stdio MCP server. The MCP client launches it directly; the VS Code extension neither pre-spawns it nor proxies Unreal MCP. Point it at a project with `node dist/mcp-server.js --project <project-root>`.

| Tool | Description |
|---|---|
| `enginelink_get_environment` | Project, engine, toolchain, and build defaults |
| `enginelink_doctor` | Read-only host prerequisite and dependency checks |
| `enginelink_build` | Cold build; refuses while this project is open in Editor |
| `enginelink_clean` | Clean build artifacts with explicit confirmation |
| `enginelink_get_build_diagnostics` | Structured diagnostics from the latest cold build |
| `enginelink_generate_compile_commands` | Generate and post-process `compile_commands.json` |
| `enginelink_get_editor_process` | Find the Editor process for this project |
| `enginelink_launch_editor` | Launch Editor or return the existing PID |
| `enginelink_run_acceptance` | Run the project-configured acceptance entrypoint |
| `enginelink_get_run` | Read a host-side run record |

Live Coding is deliberately not an EngineLink MCP tool. Agents should call Unreal MCP's Live Coding toolset directly.

### CLI and client configuration

```powershell
node dist/cli.js doctor --project D:/Workspace/MyGame
node dist/cli.js build --project D:/Workspace/MyGame --reason "verify C++ change"
node dist/cli.js accept --project D:/Workspace/MyGame --tier L2
node dist/cli.js configure --project D:/Workspace/MyGame --clients all --mode both
```

Generated snippets are written under `.enginelink/generated/`. They keep `enginelink` (stdio) and `unreal` (HTTP) as two peer servers; copy or merge the desired snippet into the client's normal configuration.

---

## Cursor Rules

On project detection, EngineLink generates `.cursor/rules/*.mdc` files (never overwrites existing ones) so the AI follows UE conventions:

| Rule File | Covers |
|---|---|
| `unreal-conventions.mdc` | Class prefixes (`U`, `A`, `F`, `E`, `I`, `T`), PascalCase, UE types |
| `unreal-macros.mdc` | `UCLASS`, `UPROPERTY`, `UFUNCTION`, `USTRUCT`, `UENUM` |
| `unreal-build-system.mdc` | `.Build.cs`, `.Target.cs`, modules, plugins |
| `unreal-patterns.mdc` | Delegates, timers, subsystems, Gameplay Tags, Enhanced Input, logging |

> **This is where we need the most help.** If you're an experienced UE developer, your feedback on these rules would be incredibly valuable — please open an issue or PR!

---

## Task Provider

EngineLink registers an `enginelink` task type for `.vscode/tasks.json`:

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

Problem matchers `$enginelink-msvc` and `$enginelink-ubt` are included for parsing build output.

---

## Contributing

This project is early and there's a lot to improve. Jump in!

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run `npm run lint && npm run typecheck`
5. Open a pull request

**Areas where help is needed:**
- **Testing** — Vitest is set up but no tests exist yet
- **Cursor rules** — UE experts: are the rules correct? What's missing?
- **macOS / Linux** — host-side engine and toolchain discovery are Windows-first right now

---

## Project Structure

```
src/
├── extension.ts                  # Entry point — activation, command registration
├── cli.ts                        # Standalone human/CI interface
├── constants.ts                  # IDs, command names, config keys
├── types.ts                      # Shared TypeScript interfaces
├── build/
│   ├── ubt.ts                    # UBT command-line construction
│   └── taskProvider.ts           # VS Code task provider
├── core/
│   ├── config.ts                 # .enginelink/project.json discovery
│   ├── discovery.ts              # VS Code-independent project/engine resolution
│   ├── service.ts                # Shared host-side operations
│   ├── runStore.ts               # Saved/EngineLink/Runs records
│   └── clientConfig.ts           # Codex/Cursor/Claude snippets
├── commands/
│   ├── coreCommands.ts           # VS Code adapter over shared core
│   ├── launchCommands.ts         # Legacy Editor launch helper
│   └── generateCommands.ts       # compile_commands.json generation
├── config/
│   └── settings.ts               # Typed settings accessor
├── cursor/
│   ├── mcpServer.ts              # Cursor registration for standalone MCP
│   ├── rulesGenerator.ts         # .cursor/rules/*.mdc generation
│   └── clangdConfig.ts           # .clangd managed block upsert
├── detection/
│   ├── projectDetector.ts        # .uproject scanning and selection
│   ├── engineDiscovery.ts        # Engine discovery (registry + filesystem)
│   └── buildToolsDetector.ts     # VS Build Tools detection via vswhere
├── mcp/
│   ├── server.ts                 # Standalone MCP server process
│   └── tools.ts                  # Host-only MCP contracts
├── parsers/
│   ├── buildOutputParser.ts      # MSVC / UBT / linker output parsing
│   └── uprojectParser.ts         # .uproject JSON parsing
├── platform/
│   ├── process.ts                # spawnAsync, isUnrealEditorRunning
│   ├── paths.ts                  # File/directory helpers
│   └── registry.ts               # Windows registry read utilities
└── ui/
    ├── statusBar.ts              # Status bar items
    ├── outputChannel.ts          # Output channel factory
    └── quickPicks.ts             # Quick-pick menus
```

---

## Development

```bash
npm install
npm run build        # one-shot build
npm run watch        # rebuild on change
npm run lint         # ESLint
npm run format       # Prettier
npm run typecheck    # TypeScript type checking
npm run test         # Vitest
npm run package      # produces .vsix via vsce
```

Built with [esbuild](https://esbuild.github.io/) — produces `dist/extension.js`, `dist/mcp-server.js`, and `dist/cli.js`.

To run locally: open this repo in Cursor, press `F5`, then open a UE project folder in the new window.

---

## License

[MIT](LICENSE) &copy; 2026 EngineLink
