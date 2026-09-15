# CQTest 学习笔记

> **CQTest**（Code Quality Tests）是 Unreal Engine 在 `FAutomationTestBase` 之上扩展的 **C++ 自动化测试框架**，提供类似 xUnit 的 fixture（`BEFORE_EACH` / `AFTER_EACH`）、跨 Tick 的 latent 命令，以及地图加载、PIE 多人、Enhanced Input 等可组合组件。  
> 本文档位于 **EngineLink** 仓库，供绑定 UE 项目时的学习与排障参考；示例代码多来自 Lyra 系项目（如 `extraction-ops`）。  
> 引擎权威说明：`<EngineRoot>/Engine/Source/Developer/CQTest/README.md`（本机 UE 5.8 常为 `D:\Software\UE_5.8\Engine\Source\Developer\CQTest\README.md`）。

---

## 1. 为什么用 CQTest

UE 里常见的 C++ 测试方式还有：

| 方式 | 特点 | 典型场景 |
| --- | --- | --- |
| `IMPLEMENT_SIMPLE_AUTOMATION_TEST` | 单函数 `RunTest`，无 fixture | 纯逻辑、无世界 |
| Automation **Spec**（BDD 风格） | `Describe` / `It`，需注意 lambda 捕获生命周期 | 行为描述型单测 |
| **CQTest** | `TEST_CLASS` + fixture；**每个 test method 之间自动重置成员**；`TestCommandBuilder` 跨 Tick | 地图/GAS/复制/输入 |

Lyra 样例 **ShooterTests** 选用 CQTest 的原因：每个用例自带 setup/teardown，状态不会在用例间泄漏，适合 Editor 下加载蓝图关卡的功能测试（见 `extraction-ops` 中 `Plugins/GameFeatures/ShooterTests/README.md`）。

**面试常考点**：`Do` / `Then` 在**同一 Tick**内执行；`StartWhen` / `Until` 每 Tick 重试 predicate，直到为真或超时失败——适合等待 Experience 加载、血量变化、复制到位等异步条件。

---

## 2. UE 5.8 中的模块与插件

自 **5.5** 起，**CQTest 核心是 Engine Module**（`Engine/Source/Developer/CQTest`），不必再为“能用框架”单独开 CQTest 测试插件；`Engine/Plugins/Tests/CQTest` 主要用于引擎自测。

项目侧通常仍需：

1. **测试模块** `PrivateDependencyModuleNames` 增加 `"CQTest"`（及按需 `"CQTestEnhancedInput"`）。
2. **Game Feature / 项目 `.uplugin`** 里 `Enabled: true` 声明依赖。
3. 测试源文件包在 `#if WITH_AUTOMATION_TESTS` 内，避免 Shipping 无关代码膨胀。

Enhanced Input 相关组件（`InputTestActions` 等）在 **CQTestEnhancedInput** 插件中；仅写地图/GAS smoke 可不依赖该插件。

---

## 3. 最小示例

```cpp
#include "CQTest.h"

#if WITH_AUTOMATION_TESTS

TEST(MinimalSmoke, "MyGame.Examples.Minimal")
{
    ASSERT_THAT(IsTrue(true));
}

TEST_CLASS(FixtureExample, "MyGame.Examples.Fixture")
{
    int32 Counter = 0;

    BEFORE_EACH()
    {
        Counter++;
    }

    TEST_METHOD(EachRunStartsFromResetState)
    {
        // 每个 TEST_METHOD 前 Counter 会回到类初始值，再执行 BEFORE_EACH
        ASSERT_THAT(AreEqual(1, Counter));
    }
};

#endif // WITH_AUTOMATION_TESTS
```

**Automation 路径**：字符串如 `"MyGame.Map.L_Test"` 决定 Session Frontend → Automation 树中的层级；也可用 `GenerateTestDirectory` 按源文件路径自动生成目录名（见引擎 README）。

**标志位**：加载蓝图/开 PIE 的测试应加 `EditorContext`，产品过滤常用 `ProductFilter`：

```cpp
TEST_CLASS_WITH_FLAGS(
    MyMapTest,
    "Project.Functional Tests.MyGame",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::ProductFilter)
```

---

## 4. 断言与失败传播

CQTest 默认不用异常（部分平台无异常），用 `[[nodiscard]] bool` + **`ASSERT_THAT`** 宏在失败时提前结束当前步骤。

自定义类型需 `operator==` / `!=`，错误信息友好输出需 `ToString()`（引擎 README Assertions 一节）。

在 `BEFORE_EACH` 里 `ASSERT_THAT` 失败会导致对应 `TEST_METHOD` 直接失败——适合“前置条件不满足就不跑主流程”。

---

## 5. TestCommandBuilder：同步步 vs 等待步

在 `TEST_METHOD` 内链式编排（与 `AddCommand` 等价的高层 API）：

| 命令 | 底层 | 行为 |
| --- | --- | --- |
| `Do` / `Then` | `FExecute` | 执行一次 |
| `StartWhen` / `Until` | `FWaitUntil` | 每 Tick 求值，真则继续；可传 `TOptional<FTimespan>` 超时 |
| `DoAsync` / `ThenAsync` / `UntilAsync` | `TAsyncExecute` | 异步结果就绪后再断言或等待 |
| `WaitDelay` | `FWaitDelay` | 固定等待（易 flaky，优先 predicate） |
| `OnTearDown` / `CleanUpWith` | `FExecute` | 测试结束后清理（**LIFO**） |

注意：**不要在 latent 回调里再嵌套注册 latent**；应拆成多步 `Then` / `Until`。

项目 CVars / `DefaultEngine.ini` 可配置默认超时，例如：

- `TestFramework.CQTest.CommandTimeout`
- `TestFramework.CQTest.CommandTimeout.MapTest`

无头 Automation 常在命令行显式加长超时，例如 `-TestFramework.CQTest.CommandTimeout=120`（`extraction-ops` 的 `Scripts/Invoke-UEAutomation.ps1` 即如此）。

---

## 6. 常用组件（组合优于继承）

| 组件 / Helper | 作用 |
| --- | --- |
| `FMapTestSpawner` | 打开指定关卡或临时地图，提供 `GetWorld()`；`AddWaitUntilLoadedCommand(TestRunner)` 等待加载/PIE 就绪 |
| `FActorTestSpawner` | 轻量 `UWorld`，适合不拉整关的 Actor 单测 |
| `TObjectBuilder<T>` | 在指定 World 里按 UClass 生成 Actor，可 `SetParam` 设蓝图属性 |
| `CQTestAssetHelper` | 按资产名查包路径、`GetBlueprintClass`、DataAsset 过滤查找 |
| `FAssetFilterBuilder` | 构造 AssetRegistry 过滤器 |
| `PIENetworkComponent` | Editor 下 Server + 多 Client PIE，测复制（需 `EditorContext`） |
| `InputTestActions`（EnhancedInput 插件） | 向 Pawn 注入 Input Action |

`CQTestBlueprintHelper` 在 5.5+ **已废弃**，新代码应使用 `CQTestAssetHelper` / `TObjectBuilder`。

---

## 7. 参考实现（extraction-ops / Lyra）

以下路径相对于 `D:\Workspace\extraction-ops`（或其它 Lyra 克隆）。

### 7.1 ShooterTests：GAS + 地图垫

`Plugins/GameFeatures/ShooterTests/Source/ShooterTestsRuntime/Private/ShooterTestsMapTests.cpp`：

1. `BEFORE_EACH`：`FindAssetPackagePathByName` → `FMapTestSpawner` → `AddWaitUntilLoadedCommand`。
2. `StartWhen` 等到 `FindFirstPlayerPawn` 非空。
3. `Do` 里绑定 `ALyraCharacter`、ASC、`ULyraHealthSet`。
4. `TEST_METHOD` 里 `Until` 等待免疫标签消失、垫子在地图上触发伤害/治疗。

文件头注释明确写了 **Do/Then vs StartWhen/Until** 的 Tick 语义，适合对照阅读。

### 7.2 ExtractionOps：Experience + 对局状态 smoke

`Plugins/GameFeatures/ExtractionOps/Source/ExtractionOpsTests/Private/ExtractionOpsMapSmokeTests.cpp`：

- 关卡：`L_ExtractionTest`。
- `BEFORE_EACH` 抑制 Error/Warning 日志噪音（仅测试跑期间）。
- `Until` 等待 `ULyraExperienceManagerComponent` 加载且 Experience 名含 `Extraction`。
- 再 `Until` `UExtractionMatchStateComponent` 进入 `InRaid`。
- `OnTearDown` 里 `GUnrealEd->EndPlayMap()` 并释放 Spawner。

**运行参数**：headless 需与 GameMode 一致选择 Experience。`Invoke-UEAutomation.ps1` 默认 `-Experience=B_ExtractionExperience`，与源码注释一致——否则 WorldSettings 默认 Experience 可能导致 predicate 永远不满足。

```powershell
# 在 extraction-ops 项目根；关闭 Editor 后执行
.\Scripts\Invoke-UEAutomation.ps1 -Filter ExtractionOps
```

---

## 8. ShooterTests 中的测试基类模式

动画与多人复制测试没有在每个 cpp 里重复搭 Pawn/Controller，而是：

- `ShooterTestsActorBaseTest` / `ShooterTestsActorNetworkTest` 继承 `TTest<Derived, AsserterType>`。
- 宏如 `ACTOR_ANIMATION_TEST`、`ACTOR_ANIMATION_NETWORK_TEST` 生成 `TTestRunner` + 派生类实例。
- 网络侧用 `PIENetworkComponent` 在 Server/Client 上分别 `Do` 步骤。

学习路径建议：先读 `ShooterTestsMapTests.cpp`（单世界 GAS），再读 `ShooterTestsActorNetworkTests.cpp`（双端 PIE）。

---

## 9. 在 Editor 里手动跑

1. 打开目标 `.uproject`（Development Editor）。
2. **Tools → Session Frontend → Automation**。
3. 树中查找 `TestFramework.CQTest` 或项目路径（如 `ExtractionOps.*`、`Project.Functional Tests.ShooterTests.*`）。
4. 勾选用例 → **Start Tests**。

点击 CQTest 条目常会跳转到对应 `.cpp` 中的 `TEST_METHOD`。

无头等价命令（需先关闭 Editor）：

```text
UnrealEditor-Cmd.exe "<Project>.uproject" -ExecCmds="Automation RunTests <Filter>; Quit" -unattended -NullRHI ...
```

详见 [manual-workflows.md](./manual-workflows.md) 中「玩法测试」一节。

---

## 10. 与 EngineLink、验收脚本的关系

| 能力 | 谁负责 |
| --- | --- |
| 冷构建、compile commands、Editor 进程 | EngineLink MCP / CLI（见 [architecture.md](./architecture.md)） |
| CQTest / Automation 用例编写与执行 | **业务项目**（Session Frontend、`UnrealEditor-Cmd`、项目 `Scripts/*.ps1`） |
| 项目自定义验收门闩 | `.enginelink/project.json` 的 `acceptance` 字段 → `enginelink_run_acceptance`（若配置） |

EngineLink **不**代理 Unreal Editor 内 Automation 运行，也不替代 CQTest。典型分工：EngineLink 保证 Editor 目标编译成功；项目在关 Editor 后跑 `Automation RunTests`。

以 extraction-ops 为例的分层：

| 层级 | 入口 | 证明什么 |
| --- | --- | --- |
| L1 规则单测 | `ExtractionOps.StateRules.*` | 纯 C++ 状态机/规则，无地图 |
| L2 地图 CQTest | `ExtractionOpsMapSmokeTests` | 关卡可加载、Experience、Raid、Zone |
| 端到端 | 项目 E2E 脚本 | 多进程玩法，非 CQTest 替代 |

CQTest 是 **Editor 上下文下的功能回归网**（常与 `-NullRHI` headless 配合），不能单独证明 Shipping Server 性能或后端一致性。

---

## 11. 踩坑清单

1. **Editor 未关**：headless Automation 与 Live Coding 结果不可靠；许多项目脚本会直接拒绝 Editor 已打开。
2. **缺 `EditorContext`**：加载蓝图关卡/PIE 的测试在错误 filter 下不显示或运行失败。
3. **固定 `WaitDelay`**：机器负载变化导致 flaky；改用 `Until` + 明确游戏条件。
4. **Experience / GameMode 参数**：Lyra 地图测试依赖命令行 `-Experience=` 与 smoke 内 predicate 一致。
5. **Teardown**：地图测试应 `EndPlayMap` 或 Spawner 析构，避免残留 PlayWorld 影响下一用例。
6. **日志断言**：抑制 Log 只用于已知噪音；不要掩盖真实失败原因。
7. **嵌套 latent**：在 `Until` 回调里再 `TestCommandBuilder` 链式追加——不支持，拆步骤。
8. **5.5+ 依赖**：仅用 Enhanced Input 测试助手时记得 `CQTestEnhancedInput` 模块与插件。

---

## 12. 延伸阅读

| 资料 | 位置 |
| --- | --- |
| 引擎 CQTest README | `<EngineRoot>/Engine/Source/Developer/CQTest/README.md` |
| UE 写 C++ 测试（Simple） | [Epic 文档：Write C++ Tests](https://dev.epicgames.com/documentation/en-us/unreal-engine/write-cplusplus-tests-in-unreal-engine) |
| Automation Spec | [Automation Spec](https://dev.epicgames.com/documentation/en-us/unreal-engine/automation-spec-in-unreal-engine) |
| `EAutomationTestFlags` | [API 文档](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Core/Misc/EAutomationTestFlags/Type) |
| ShooterTests 项目说明 | `extraction-ops/Plugins/GameFeatures/ShooterTests/README.md` |
| extraction-ops 测试主题 | `extraction-ops/docs/10-testing-observability/` |
| EngineLink 手动工作流 | [manual-workflows.md](./manual-workflows.md) |

---

## 13. 自测理解（不看代码能答即可）

1. `BEFORE_EACH` 与 `BEFORE_ALL` 分别在什么粒度执行？成员变量为何每个 `TEST_METHOD` 都会“像新开一样”？  
2. 写一条等待 “GameState 上出现某组件且布尔条件为真” 的 `TestCommandBuilder` 链，并说明超时参数加在哪一步。  
3. `ExtractionOpsMapSmokeTests` 与 `ShooterTestsMapTests` 在等待条件上各解决了什么游戏层问题？  
4. 若只跑 `ExtractionOps.StateRules.*` 而通过，能否宣称“撤离玩法 E2E 已验收”？为什么？
