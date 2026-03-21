# EngineLink

🌐 [enginelink.dev](https://enginelink.dev)

**Cursor-first Unreal Engine build bridge** — build, launch, and live-code UE projects with AI-powered tooling.

EngineLink connects [Cursor](https://cursor.sh) (and VS Code) to Unreal Engine so you can compile, iterate, and debug C++ projects without leaving your editor. It auto-detects your `.uproject`, discovers engine installations from the Windows registry, and exposes every build action to Cursor's AI agent via a built-in [MCP](https://modelcontextprotocol.io/) server.

> 🧪 **Status:** Early preview (`0.1.0`). Windows-only for now.

> 👋 **TL;DR:** This is a fun experiment! I've been building software for 10 years but game dev is new to me. As I learn Unreal Engine, I found Rider and Visual Studio to be very old-fashioned compared to modern AI-first editors — so I decided to give Cursor full UE capabilities. I'm testing this extension as I go, learning and breaking things along the way. Contributions and feedback are very welcome :)

---

## 🙏 Contributing & Help Wanted

This project is early and there's a lot to improve. If any of this interests you, jump in!

### 📐 Cursor Rules & UE Best Practices (feedback needed most!)

EngineLink auto-generates `.cursor/rules/*.mdc` files that teach Cursor's AI how to write idiomatic Unreal C++. **This is where we need the most help** — if you're an experienced UE developer, your feedback on these rules would be incredibly valuable:

| Rule File | What it covers |
|---|---|
| `unreal-conventions.mdc` | Class prefixes (`U`, `A`, `F`, `E`, `I`, `T`), PascalCase, UE container types |
| `unreal-macros.mdc` | `UCLASS`, `UPROPERTY`, `UFUNCTION`, `USTRUCT`, `UENUM`, `GENERATED_BODY` |
| `unreal-build-system.mdc` | `.Build.cs`, `.Target.cs`, module structure, dependency management |
| `unreal-live-coding.mdc` | What Live Coding can and cannot patch at runtime |
| `unreal-patterns.mdc` | Delegates, timers, subsystems, Gameplay Tags, Enhanced Input, logging |

> 💡 These files are never overwritten once generated, so you can customize them freely. If you know UE well and think a rule is wrong or missing — please open an issue or PR!

### 🧩 Other areas where help is needed

- 🧪 **Testing** — Vitest is set up but no tests exist yet. This is the biggest code gap: unit tests for detection, build commands, output parsing, and integration tests against real UE projects

### How to contribute

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run `npm run lint && npm run typecheck` to verify
5. Open a pull request

---

## ✨ Features

### 🔨 Build Integration

- **Build / Rebuild / Clean** — invoke UnrealBuildTool directly from the editor with full output streaming
- **⚡ Live Coding** — trigger `Ctrl+Alt+F11` hot-reload in a running Unreal Editor session
- **🧠 Editor-aware builds** — detects when Unreal Editor is running and suggests Live Coding over a full build to avoid DLL lock errors
- **📄 `compile_commands.json` generation** — runs UBT's `-mode=GenerateClangDatabase` for accurate IntelliSense (**requires Clang x64** on your machine — see [compile_commands.json & Clang](#compile_commandsjson--clang))
- **🧩 `.clangd` for clangd** — auto-creates or updates a **managed** block in your project’s `.clangd` to suppress false **`builtin_definition`** diagnostics when MSVC intrinsics clash with Clang’s builtins (see [Clangd MSVC builtin suppression](#clangd-msvc-builtin-suppression))

### 🔍 Auto-Detection

- **Project detection** — scans the workspace for `.uproject` files and parses `EngineAssociation`
- **Engine discovery** — reads the Windows registry (Epic Games Launcher + source builds) plus common paths
- **Build tools detection** — locates Visual Studio Build Tools via `vswhere`

### 🤖 Cursor AI Integration

- **MCP server** — a sidecar process that exposes build, clean, rebuild, launch, live-coding, and diagnostics as MCP tools. Cursor's AI agent can compile your project, read build errors, and fix them autonomously
- **Cursor rules** — generates `.cursor/rules/*.mdc` files so the AI writes idiomatic Unreal C++ (see [Contributing](#-contributing--help-wanted) above)

### 🖥️ Editor UX

- **Status bar** — Rider-style toolbar with project name, engine version, build config, and colored action buttons
- **Problems panel** — MSVC and UBT errors/warnings are parsed and surfaced as native VS Code diagnostics
- **Progress notifications** — build progress via status bar spinner and notification toast
- **Task provider** — `enginelink` tasks available in the Tasks panel and `tasks.json`

---

## 📋 Prerequisites

| Requirement | Notes |
|---|---|
| 🪟 **Windows 10/11** | Registry-based engine discovery and PowerShell Live Coding are Windows-specific |
| 🎮 **Unreal Engine 5.4+** | Tested on 5.4–5.7; earlier versions may work but aren't officially supported |
| 🔧 **Visual Studio Build Tools** | Required for MSVC compilation; detected automatically via `vswhere` |
| 🐉 **LLVM Clang (x64)** | **Only needed** for `compile_commands.json` / `GenerateClangDatabase`. Normal UE builds use MSVC — see below |
| ✏️ **Cursor or VS Code** | Engine version `^1.85.0` |

### `compile_commands.json` & Clang

UnrealBuildTool’s **GenerateClangDatabase** mode (what EngineLink uses for `compile_commands.json`) is a **Clang-based** step. If Clang isn’t installed, activation may log something like:

```text
Clang x64 must be installed in order to build this target.
Result: Failed (OtherCompilationError)
```

That does **not** mean your project or MSVC setup is broken — only that the Clang database step can’t run until Clang is available.

**Install Clang x64 on Windows (pick one):**

1. **Visual Studio Installer** → modify your install → **Individual components** → enable **“C++ Clang Compiler for Windows”** (and optionally **“MSBuild support for LLVM toolset”**), then restart the terminal / IDE.
2. **LLVM** — install the [official Windows pre-built LLVM/Clang](https://releases.llvm.org/) (64-bit) and ensure `clang-cl.exe` / LLVM `bin` is on your `PATH` so UBT can find it.

After Clang is installed, run **EngineLink: Generate compile_commands.json** from the Command Palette (or reload the window so auto-generation runs again if `enginelink.autoGenerateCompileCommands` is `true`).

**Don’t need `compile_commands.json` yet?** Set `enginelink.autoGenerateCompileCommands` to `false` in settings to skip the step on activation and avoid the error in the output channel.

#### Where the file is written (important for clangd)

When generation **succeeds**, UnrealBuildTool writes the database next to the **engine root**, not inside your game project folder. EngineLink’s output will look like:

```text
ClangDatabase written to C:\Program Files\Epic Games\UE_5.7\compile_commands.json
Result: Succeeded
```

So the file lives beside `Engine/` (e.g. `UE_5.7\compile_commands.json`), while your `.uproject` and `Source/` are elsewhere (e.g. `Documents\Unreal Projects\MyGame`).

#### Why **clangd** still says “Failed to find compilation database”

Extensions such as **[clangd](https://marketplace.visualstudio.com/items?itemName=llvm-vs-code-extensions.vscode-clangd)** search for `compile_commands.json` by walking **up** from the open file (e.g. `Source/MyGame/MyClass.cpp`) through parent directories. They typically stop at your **workspace / project root** and **never** reach `C:\Program Files\Epic Games\UE_5.7`, so clangd falls back to guessing compile flags and you’ll see missing includes / weak IntelliSense even though EngineLink generated the JSON successfully.

#### Fix: point clangd at the engine folder

In your **game project** repository (the folder you open in Cursor), add workspace settings so clangd loads the database from the engine directory. Create or edit **`.vscode/settings.json`**:

```json
{
  "clangd.arguments": [
    "--compile-commands-dir=C:/Program Files/Epic Games/UE_5.7"
  ]
}
```

- Use the **same directory** shown in EngineLink’s log line *“ClangDatabase written to …”* (the folder **containing** `compile_commands.json`, not the file itself).
- Prefer **forward slashes** (`C:/Program Files/...`) in JSON to avoid escaping backslashes.
- Reload the window (**Developer: Reload Window**) or restart clangd after saving.

This is **workspace-specific** and safe to commit so everyone on the team with the same engine path benefits; if engine paths differ per machine, use local (user) settings or a documented team convention.

#### Clangd MSVC builtin suppression

When **clangd** parses your UE C++ with a `compile_commands.json` produced for **MSVC-style** includes, you may see errors like **definition of builtin function** on system/intrinsic headers (e.g. prefetch-related intrinsics). That comes from **Microsoft’s headers defining names that Clang also treats as builtins** — it’s an **IDE / parser quirk**, not a broken `#include` in your game code, and it does **not** mean the real Unreal/MSVC build is wrong.

**EngineLink** can **auto-upsert** a small YAML block into your project’s **`.clangd`** (at the `.uproject` root) so clangd suppresses only that diagnostic class:

```yaml
# <<< enginelink-managed >>>
# MSVC intrinsics vs Clang builtins when parsing with clangd (IDE-only; real UE builds still use MSVC).
Diagnostics:
  Suppress: builtin_definition
# <<< end-enginelink-managed >>>
```

- The block is delimited by **`# <<< enginelink-managed >>>`** / **`# <<< end-enginelink-managed >>>`**. EngineLink **replaces only that region** on future updates so the rest of your `.clangd` stays yours.
- If you already reference `builtin_definition` elsewhere in `.clangd`, EngineLink **won’t** append a duplicate.
- After the file changes, run **Clangd: Restart language server** or **Developer: Reload Window**.

To turn this off: set **`enginelink.upsertClangdConfig`** to `false`.

---

## 🚀 Installation

### From Source

```bash
git clone https://github.com/rmoubayed/engine-link.git
cd engine-link
npm install
npm run build
```

Then press `F5` in Cursor/VS Code to launch the Extension Development Host, or package it:

```bash
npm run package
```

This produces an `enginelink-0.1.0.vsix` you can install with:

```bash
code --install-extension enginelink-0.1.0.vsix
```

### From Marketplace

*Not yet published. Coming soon.*

---

## ⚡ Quick Start

1. Open a folder containing a `.uproject` file in Cursor
2. EngineLink activates automatically and runs its detection pipeline:
   - 📁 Finds your `.uproject` and parses its `EngineAssociation`
   - 🔍 Discovers matching UE installations from the registry
   - 🔧 Locates VS Build Tools
3. The status bar populates with your project name, engine version, and build actions
4. Press `Ctrl+Shift+B` to build or use the Command Palette (`Ctrl+Shift+P` → "EngineLink: Build")

If auto-detection fails, you can override paths in settings (see [Configuration](#%EF%B8%8F-configuration)).

If you see **Clang x64 must be installed** in the EngineLink output after opening a project, that’s only for **`compile_commands.json`** generation — install Clang (see [compile_commands.json & Clang](#compile_commandsjson--clang)) or turn off `enginelink.autoGenerateCompileCommands`.

If you use **clangd** and generation **succeeds** but clangd still logs **Failed to find compilation database**, UBT wrote the file under your **engine** folder — set `clangd.arguments` / `--compile-commands-dir` in `.vscode/settings.json` (see the **clangd** subsections under [`compile_commands.json` & Clang](#compile_commandsjson--clang)).

EngineLink also maintains a **`.clangd`** snippet for **`builtin_definition`** suppression when **`enginelink.upsertClangdConfig`** is enabled (see [Clangd MSVC builtin suppression](#clangd-msvc-builtin-suppression)).

---

## 🎮 Commands

All commands are available via the Command Palette under the **EngineLink** category.

| Command | Keybinding | Description |
|---|---|---|
| **▶ Build** | `Ctrl+Shift+B` | Build the project via UnrealBuildTool |
| **↻ Rebuild** | — | Clean all artifacts then build |
| **✕ Clean** | — | Remove build artifacts |
| **🚀 Launch Unreal Editor** | — | Open UnrealEditor.exe with the current project |
| **⚡ Live Coding Compile** | `Ctrl+Alt+F11` | Send a hot-reload keystroke to the running Unreal Editor |
| **📄 Generate compile_commands.json** | — | Run UBT in `GenerateClangDatabase` mode |
| **Select Engine Installation** | — | Pick from discovered engine installs |
| **Select UE Project** | — | Pick from detected `.uproject` files |
| **Select Build Configuration** | — | Choose Debug / DebugGame / Development / Shipping / Test |
| **Select Build Target Type** | — | Choose Editor / Game / Client / Server |

Build, Launch, and Live Coding also appear as icon buttons in the editor title bar when a project is detected.

---

## ⚙️ Configuration

All settings are scoped under `enginelink.*` and can be set in your workspace or user `settings.json`.

| Setting | Type | Default | Description |
|---|---|---|---|
| `enginelink.engineRoot` | `string` | `""` | Manual override for the UE root directory. Leave empty for auto-detection. |
| `enginelink.projectFile` | `string` | `""` | Path to a specific `.uproject` file. Leave empty for auto-detection. |
| `enginelink.buildConfiguration` | `enum` | `Development` | Build configuration: `Debug`, `DebugGame`, `Development`, `Shipping`, `Test` |
| `enginelink.buildTarget` | `enum` | `Editor` | Build target type: `Editor`, `Game`, `Client`, `Server` |
| `enginelink.platform` | `string` | `Win64` | Target platform |
| `enginelink.autoGenerateCompileCommands` | `boolean` | `true` | Auto-generate `compile_commands.json` on project detection (requires **Clang x64**; set `false` if you haven’t installed Clang) |
| `enginelink.upsertClangdConfig` | `boolean` | `true` | Create/update project `.clangd` with a managed `builtin_definition` suppression for clangd + MSVC headers |
| `enginelink.liveCoding.method` | `enum` | `keystroke` | Live Coding trigger method (`keystroke` or `disabled`) |
| `enginelink.vsBuildTools.path` | `string` | `""` | Manual override for VS Build Tools install path |

---

## 🤖 MCP Server

EngineLink ships a built-in MCP server that lets Cursor's AI agent interact with your Unreal project. On activation, the server is spawned as a child process and registered in `.cursor/mcp.json`.

| Tool | Description |
|---|---|
| `enginelink_build` | Build the project (supports configuration and target overrides) |
| `enginelink_rebuild` | Clean and rebuild |
| `enginelink_clean` | Clean build artifacts |
| `enginelink_get_build_errors` | Retrieve errors with file paths, line numbers, and messages |
| `enginelink_get_project_info` | Get project name, engine version, modules, and build settings |
| `enginelink_launch_editor` | Launch Unreal Editor |
| `enginelink_live_coding` | Trigger a Live Coding hot-reload |
| `enginelink_generate_compile_commands` | Regenerate `compile_commands.json` |

> 💬 Tell Cursor things like *"build my project and fix any errors"* and it will invoke UBT, read the diagnostics, and propose fixes — all within the chat.

---

## 📝 Task Provider

EngineLink registers an `enginelink` task type. You can reference it in `.vscode/tasks.json`:

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
    },
    {
      "type": "enginelink",
      "action": "clean",
      "label": "EngineLink: Clean"
    }
  ]
}
```

Two problem matchers are also provided — `$enginelink-msvc` and `$enginelink-ubt` — for parsing MSVC and UnrealBuildTool output.

---

## 📂 Project Structure

```
src/
├── extension.ts                  # Entry point — activation, command registration
├── constants.ts                  # IDs, command names, config keys
├── types.ts                      # Shared TypeScript interfaces
├── build/
│   ├── ubt.ts                    # UBT command-line construction
│   └── taskProvider.ts           # VS Code task provider
├── commands/
│   ├── buildCommands.ts          # Build, rebuild, clean execution
│   ├── launchCommands.ts         # Launch Unreal Editor
│   ├── liveCodingCommand.ts      # Live Coding keystroke simulation
│   └── generateCommands.ts       # compile_commands.json generation
├── config/
│   └── settings.ts               # Typed settings accessor
├── cursor/
│   ├── mcpServer.ts              # MCP server lifecycle and IPC
│   ├── rulesGenerator.ts         # .cursor/rules/*.mdc generation
│   └── clangdConfig.ts          # .clangd managed block (clangd suppressions)
├── detection/
│   ├── projectDetector.ts        # .uproject scanning and selection
│   ├── engineDiscovery.ts        # Engine discovery (registry + filesystem)
│   └── buildToolsDetector.ts     # VS Build Tools detection via vswhere
├── mcp/
│   ├── server.ts                 # Standalone MCP server process
│   ├── tools.ts                  # MCP tool definitions
│   └── protocol.ts               # IPC message types
├── parsers/
│   ├── buildOutputParser.ts      # MSVC / UBT / linker output parsing
│   └── uprojectParser.ts         # .uproject JSON parsing
├── platform/
│   ├── process.ts                # spawnAsync, isUnrealEditorRunning
│   ├── paths.ts                  # File/directory helpers, UBT/Editor path resolution
│   └── registry.ts               # Windows registry read utilities
└── ui/
    ├── statusBar.ts              # Status bar items
    ├── outputChannel.ts          # Output channel factory
    └── quickPicks.ts             # Quick-pick menus for config selection
```

---

## 🛠️ Development

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

Built with [esbuild](https://esbuild.github.io/) — produces `dist/extension.js` and `dist/mcp-server.js`.

To run locally: open this repo in Cursor, press `F5`, then open a UE project folder in the new window.

---

## 📄 License

[MIT](LICENSE) &copy; 2026 EngineLink
