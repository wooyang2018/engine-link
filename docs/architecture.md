# EngineLink responsibility boundary

EngineLink and Unreal MCP are peers, not a gateway chain.

| EngineLink | Unreal MCP / VibeUE |
|---|---|
| Project and toolchain discovery | UObject and asset inspection/editing |
| Cold UBT build and clean | Live Coding |
| Editor process query and launch | PIE and runtime input |
| Build diagnostics and compile database | Blueprints, animation, materials, UMG, Niagara, levels |
| Project acceptance command | Editor transactions, saves, screenshots, asset verification |
| Host-side run records | Editor-side workflow journals |

EngineLink must not import VibeUE code, enumerate VibeUE toolsets, proxy Unreal MCP requests, or assume that VibeUE is installed. An AI client may configure both servers and select the appropriate one per task. A shared `taskId` can correlate independent records without introducing a runtime dependency.
