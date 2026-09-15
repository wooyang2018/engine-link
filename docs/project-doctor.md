# UE Project Doctor

Project Doctor 是 EngineLink 的只读项目诊断。一次运行固定做宿主工具链检查，再视 Editor / 原生 Unreal MCP 是否可用做结构扫描。它**不是**玩法测试运行器。

## Agent 怎么读结果

MCP/CLI 返回 `enginelink.doctor-view.v1`：`status`、`conclusion`、`coverage`、`issues`、`reportPath`。

1. 看 `status`：`passed` / `passed_with_findings` / `failed` / `incomplete`。
2. `incomplete`：先读 `coverage`（哪一项没跑到），不要把空 `issues` 当成项目通过。
3. `failed`：再读 P0/P1 `issues`。
4. `passed_with_findings`：只有已执行检查留下的 P2。

Doctor 终态 `failed` **不会**把 MCP `isError` 设为 true。`isError` 只用于抛错或宿主 `enginelink.run.v1` 且 `success === false`。

## 一次运行做什么

顺序固定：

1. **host** — Visual Studio / Windows SDK、UBT、Editor 二进制。缺口写成 `host.*` issue。
2. **editor** — 本机 Unreal Editor 进程 + 原生 MCP `call_tool`（`IsPIERunning` 等）。连不上、多开、工具集不足 → `coverage.editor=unavailable`，**不**写 `editor.offline` 一类 issue。
3. **build** — 只信 EngineLink `RunStore` 的权威冷构建。忽略 `Saved/VibeUE/last-build.json`。
4. **assets / blueprints** — 默认 Git 变更路径，或 `--path` / `paths`。原生引用工具只收到这些路径转成的 `/Game/...`。缺引用、Blueprint 编译失败、原生工具给出的图结构问题写成 issue。用户已在 PIE 中时**不**做深度扫描，也**不** `StartPIE` / `StopPIE`。

CLI：

```powershell
node dist/cli.js project-doctor --project D:/Workspace/MyGame
node dist/cli.js project-doctor --project D:/Workspace/MyGame --path Content/BP/BP_Test.uasset
```

MCP：一次调用 `enginelink_project_doctor`（可选 `paths`），等到终态再返回 view。连 Editor 做资产扫描时可能到分钟级。内部默认 180s 超时 → `incomplete`；人类用 CLI `--timeout-ms` 覆盖。六个工具的输入输出见 [mcp-tools.md](./mcp-tools.md)。

## coverage vs issue

| 情况 | 表达 |
|------|------|
| Editor 未开、MCP 不可用、多 Editor、PIE 占用、无权威构建 | 只写 `coverage.*`（`unavailable` / `incomplete`） |
| 宿主工具链缺失、权威构建失败、脏包、已扫描到的坏引用/编译/图问题 | 写 `issues` |

启发式图问题（如未连接的 Cast Failed）仍是 **P2 issue**，没有 `confidence` 字段。

## 玩法测试不在这里

EngineLink **不**提供、也**不**代跑验收命令或 CQTest。业务项目自己编写并执行：

- [Automation Test Framework / CQTest](https://dev.epicgames.com/documentation/unreal-engine/automation-test-framework-in-unreal-engine)
- [Automation Driver](https://dev.epicgames.com/documentation/unreal-engine/automation-driver-in-unreal-engine)

可用 Session Frontend、`UnrealEditor-Cmd -ExecCmds=Automation RunTest`，或项目自己的脚本。Agent 改测试 = 改项目 C++，不要找 EngineLink 验收工具。

## Unreal MCP

Doctor 在 EngineLink 进程内用 loopback HTTP Streamable 调用编辑器的 **`call_tool` / `list_toolsets` / `describe_toolset`**。需要项目启用 Unreal MCP 与 AllToolsets。EngineLink MCP **不**把这些元工具暴露给调用方。

Doctor 不依赖 VibeUE：不注入 `execute_python_code`、不读 `Saved/VibeUE/Signals`、不 `import vibeue`。

证据优先 MCP `structuredContent`，其次文本 JSON。不再使用 `ENGINELINK_DOCTOR_RESULT=` 打印标记。

## 报告位置

```
Saved/EngineLink/Doctor/Runs/<run-id>/
  summary.json    # 与 view 同字段，外加 requestedPaths、startedAt/finishedAt、error?
  report.md
  scan.json       # 仅当资产扫描实际跑过
Saved/EngineLink/Doctor/Runs/latest.json
Saved/EngineLink/doctor.lock
```
