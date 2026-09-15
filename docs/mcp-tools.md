# EngineLink MCP / CLI 工具

EngineLink 对外只有 **6 个 MCP 工具**，与 **6 条 CLI 命令**一一对应。实现都走 `EngineLinkService`。本文是这 6 个入口的原理、设计、输入与输出；Project Doctor 的诊断语义另见 [project-doctor.md](./project-doctor.md)。

入口：

- MCP：`node dist/mcp-server.js --project <root>`（stdio，仅 `tools`）
- CLI：`node dist/cli.js <command> --project <root>`

EngineLink **不代理** Unreal 的 `call_tool` / Live Coding / PIE。玩法测试不在这里。

| MCP | CLI | 返回 schema |
|-----|-----|-------------|
| `enginelink_get_environment` | `environment` | `enginelink.environment.v1` |
| `enginelink_project_doctor` | `project-doctor` | `enginelink.doctor-view.v1` |
| `enginelink_build` | `build` | `enginelink.run.v1` |
| `enginelink_clean` | `clean --confirm` | `enginelink.run.v1` |
| `enginelink_generate_compile_commands` | `compile-commands` | `enginelink.run.v1` |
| `enginelink_launch_editor` | `launch` | 启动结果对象 |

公共可选（**不含** `project_doctor`）：MCP `taskId` / `reason`；CLI `--task-id` / `--reason`。`build` / `clean` 另有 `configuration` / `targetType` / `platform`（CLI `--configuration` / `--target` / `--platform`）。`compile-commands` 只有 `configuration` / `platform`，目标固定为 Editor。缺省为 Development / Editor / Win64。

MCP `isError: true` **只**在：抛错，或返回体是 `enginelink.run.v1` 且 `success === false`。Doctor 的 `failed` / `incomplete` **不是** `isError`。CLI 对 `run.v1` 失败和 Doctor 非 `passed`/`passed_with_findings` 设退出码 1。

推荐顺序：`get_environment` 看引擎与 Editor → 需要冷编时关 Editor 再 `build` → 需要 clangd 时 `generate_compile_commands` → `launch_editor` 再 `project_doctor`。玩法与资产编辑走 Unreal MCP。

## 共享返回：`enginelink.run.v1`

`build` / `clean` / `generate_compile_commands` 成功或失败都返回这个形状；`launch_editor` 的 MCP/CLI 返回的是启动结果对象，不是这份 view。

| 字段 | 含义 |
|------|------|
| `schema` | 恒为 `enginelink.run.v1` |
| `id` / `kind` | 运行 id；`kind` 为 `build` / `clean` / `compile-commands` / `launch` |
| `taskId` / `reason` | 调用方传入 |
| `startedAt` / `finishedAt` / `durationMs` | ISO 时间与耗时 |
| `success` / `exitCode` | 进程结果。blocked 操作为 `false` / `1` |
| `command` | `{ executable, args }`；args 已对 token/secret 类脱敏 |
| `diagnostics` | `{ file, line, column, severity, code, message }[]`，来自 MSVC/UBT 行解析 |
| `details` | 拒绝原因、后处理统计等 |
| `project` / `engine` | uproject 与引擎根 |

落盘：仅 `kind: build` 覆盖 `Saved/EngineLink/latest-build.json`（Doctor 权威冷构建指针）。其它 kind 只出现在工具返回体。

---

## 1. `enginelink_get_environment` / `environment`

**原理：** 读已解析的项目、引擎、VS 工具链、构建默认，再查本机是否已有打开该 `.uproject` 的 Unreal Editor。

**设计：** 只读、无副作用。Editor 进程并进环境，避免单独的 `get_editor_process`。不启动 Editor、不连 Unreal MCP。

**输入：** 无。

**输出** `enginelink.environment.v1`：

| 字段 | 含义 |
|------|------|
| `engineLink` | 本进程版本、PID、bundle 路径 |
| `project` | 名称、uproject 绝对路径、EngineAssociation、模块/target 摘要 |
| `engine` | 版本、根目录、UBT/Editor 二进制、来源 |
| `editor` | `{ running, process, processes }`；`processes` 按启动时间降序，`process` 为最新一条 |
| `buildTools` | vswhere 结果；未检测到为 `null` |
| `defaults` | 本次将用于 build/compile-commands 的 configuration / targetType / platform，以及解析后的 `editorTarget` |
| `responsibilities` | 两句话划清 EngineLink vs Unreal MCP |

**边界：** 构造 Service 时若找不到项目/引擎即抛错。Editor 枚举仅 Windows；其它平台 `running: false`、`processes: []`。

---

## 2. `enginelink_project_doctor` / `project-doctor`

一次同步、只读诊断：宿主工具链 → Editor + 原生 MCP 能否扫描 → EngineLink `RunStore` 冷构建证据 → Git 或指定路径上的引用 / Blueprint 结构。没有 start/get/cancel，Agent 不维护任务。同项目用内部 `doctor.lock` 互斥。不 `StartPIE`、不跑 CQTest。

**输入：** 只有 `paths?: string[]`（CLI 可重复 `--path`）。省略 = Git porcelain。原生资产扫描只把这些路径转成 `/Game/...` 传给引用工具。MCP schema 没有 `timeoutMs` / `taskId` / `reason`；内部默认 180s，CLI `--timeout-ms` 可覆盖。超时 → `incomplete`，不是 MCP `isError`。

**输出** `enginelink.doctor-view.v1`：`schema`、`status`、`conclusion`、`coverage`、`issues`、`reportPath`。

| 字段 | 含义 |
|------|------|
| `status` | `passed` / `passed_with_findings` / `failed` / `incomplete` |
| `coverage` | `host` / `editor` / `build` / `assets` / `blueprints` / `logs`，每项 `{ status, detail? }` |
| `issues` | 已执行检查的缺陷：`ruleId`、`severity`、`path`、`evidence`、`recommendation` |
| `reportPath` | 磁盘上的 `report.md` |

`coverage.*.status`：`completed` / `unavailable` / `incomplete` / `failed`。没跑到的检查只改 coverage，不写 `editor.offline` 一类 issue。

**怎么读：** `incomplete` 先看 coverage；`failed` 再看 P0/P1 issues。空 issues 不是通过。

**边界：** 无 Editor / MCP 无 `call_tool` / 多 Editor / 已在 PIE → coverage `unavailable`。权威构建只信 EngineLink `RunStore`。连 Editor 扫描时 MCP 调用可能到分钟级。

---

## 3. `enginelink_build` / `build`

**原理：** 拼 UBT 命令行，在项目根 `spawn`。stdout/stderr 按 MSVC/UBT 行解析进 `diagnostics`。

**设计：** **冷构建**。同一项目已有 `UnrealEditor.exe`（Win32 命令行含 uproject 绝对路径）则拒绝，写 `success: false`、`details.blocked`，并提示用 Unreal MCP Live Coding。非 Windows 不做该检测。

**输入：** `configuration` / `targetType` / `platform`、`taskId`、`reason`。UBT 目标名由 `pickTargetForType` 解析：约定名 / 主模块 / 唯一发现项。多义时抛错。

**输出** `enginelink.run.v1`：

| 字段 | 含义 |
|------|------|
| `id` / `kind` | `kind` 为 `build` |
| `success` / `exitCode` / `durationMs` | 进程结果 |
| `command` | 可复现命令（敏感参数已脱敏） |
| `diagnostics` | 结构化错误/警告 |
| `details` | 拒绝时 `{ blocked: true, message, editorPid }` |
| `project` / `engine` | 路径 |

落盘：覆盖 `Saved/EngineLink/latest-build.json`。失败时 MCP `isError: true`。

**边界：** 不刷新 `compile_commands.json`。不替代 Live Coding。

---

## 4. `enginelink_clean` / `clean`

**原理：** UBT `-clean`，同样走 `run.v1`。

**设计：** 破坏性操作。MCP **必须** `confirm: true`；CLI **必须** `--confirm`。否则不删产物，写 blocked run（`success: false`）。**不**检测 Editor 是否打开。

**输入：** 同 build + `confirm`。

**输出：** 同 `enginelink.run.v1`，`kind: clean`。

---

## 5. `enginelink_generate_compile_commands` / `compile-commands`

**原理：** UBT `-mode=GenerateClangDatabase -NoExecCodeGenActions -OutputDir=<projectRoot>`。成功后按 UBT 日志路径 → 引擎根 → Intermediate/Build 把 `compile_commands.json` **安置到项目根**，再后处理（内联 `@*.rsp`、Unity remap、补头文件）。

**设计：** 给 clangd 用，不是给游戏运行时用。固定 Editor 目标。MCP/CLI **不**改 `.clangd`、**不** `clangd.restart`（Cursor 扩展激活与菜单 Generate 在同一条 Service 之后补 IDE sidecar）。

**输入：** `configuration` / `platform` / `taskId` / `reason`。**没有** `targetType`。

**输出：** `enginelink.run.v1`，`kind: compile-commands`。成功时 `details` 含 `compileCommandsPath`、`placedFrom`（`UBT output` / `engine root` / `Intermediate/Build search`）、`postProcess` 统计，以及扩展用来更新 `.clangd` 的 `templateFlags` / `projectForcedIncludes`。UBT 成功但安置失败 → `success: false`（MCP `isError`），不把旧的项目根文件当成这次生成结果。

**边界：** 扩展激活路径仍会在后处理之后更新 `.clangd` 并尝试 `clangd.restart`。Tasks 面板的 generate 任务调用 `node dist/cli.js compile-commands`，与 MCP/CLI 同一条链。

---

## 6. `enginelink_launch_editor` / `launch`

**原理：** 若已有同项目 Editor 进程，直接返回，不再 spawn。否则 `UnrealEditor.exe <uproject>`，detached。

**设计：** 只负责进程出现，不等 MCP 就绪、不等地图加载。Doctor 需要 Editor+MCP 时，应先 launch（或用户打开），再单独调 `project_doctor`。

**输入：** `taskId` / `reason`。

**输出：**

| 情况 | 形状 |
|------|------|
| 已存在 | `{ launched: false, existing: true, process }` |
| 新启动 | `{ launched: true, existing: false, pid, runId }` |

**边界：** 不健康检查。多开时只要已有任一匹配进程就不会再开。非 Windows 上「已存在」检测为空，可能重复启动。

---

