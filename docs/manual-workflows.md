# EngineLink manual workflows

EngineLink automates host-side work. These are the equivalent manual operations so users can understand and reproduce each action without MCP.

## Diagnose the environment

1. Locate the project's `.uproject` and read `EngineAssociation`.
2. Confirm `UnrealBuildTool.exe` under the associated engine installation.
3. Open Visual Studio Installer and verify **Desktop development with C++**, MSVC, and a Windows SDK.
4. Install `clang-cl` when clangd/`compile_commands.json` navigation is required.

Equivalent CLI: `node dist/cli.js doctor --project <project-root>`.

## Cold-build the Editor target

1. Save work and close Unreal Editor. A cold build can conflict with loaded Editor DLLs.
2. Open PowerShell at the project root.
3. Run UnrealBuildTool with the Editor target, platform, configuration, project path, and `-WaitMutex`.
4. Treat UBT/MSVC/linker diagnostics as authoritative; IDE squiggles are not a build result.

Equivalent CLI: `node dist/cli.js build --project <project-root>`.

When Unreal Editor is open and the change is compatible with Live Coding, use Unreal MCP's Live Coding toolset or the Editor's **Compile** action instead. EngineLink MCP intentionally does not proxy that Editor-side operation.

## Generate compile commands

1. Run UBT for the Editor target with `-Mode=GenerateClangDatabase`, `-NoExecCodeGenActions`, and `-OutputDir=<project-root>`.
2. Confirm `compile_commands.json` exists in the project root.
3. Configure clangd to read that directory.

Equivalent CLI: `node dist/cli.js compile-commands --project <project-root>`.

## Launch the Editor

Open the `.uproject` in Explorer, or run `UnrealEditor.exe <absolute-project-path> [map]`. EngineLink returns an existing PID instead of launching the same project twice.

## Run acceptance

The project's `.enginelink/project.json` declares the acceptance command. Run that command directly from the project root when EngineLink is not installed. EngineLink is a convenience wrapper and never replaces project-specific acceptance rules.

## Run records

EngineLink writes host-side records to `Saved/EngineLink/Runs/<run-id>/`. Each record contains the command, reason, environment, duration, exit code, diagnostics, and evidence location. Use `node dist/cli.js explain --project <root> --id <run-id>` for a concise human-readable explanation.
