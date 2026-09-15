# Unreal C++ 面试速记

EngineLink **不再**向用户项目写入 `.cursor/rules/*.mdc`、`AGENTS.md` 或 `CLAUDE.md`。下文是原先那四份 Cursor 规则里的约定，按面试常问的「为什么」整理。权威以当前引擎头文件与 [Epic C++ 编码标准](https://dev.epicgames.com/documentation/en-us/unreal-engine/epic-cplusplus-coding-standard-for-unreal-engine) 为准。

---

## 1. 命名与类型：前缀不是风格，是反射契约

| 前缀 | 基类 / 含义 | 例子 |
|------|-------------|------|
| `U` | `UObject` | `UActorComponent`、`UUserWidget` |
| `A` | `AActor` | `ACharacter`、`APlayerController` |
| `F` | 非 UObject 的 struct / 工具类 | `FVector`、`FString`、`FName` |
| `E` | 枚举 | `ECollisionChannel` |
| `I` | 接口（常配合 `UINTERFACE`） | `IInteractable` |
| `T` | 模板 | `TArray`、`TMap`、`TSubclassOf` |

面试要点：

- 调试器、`Cast<>`、蓝图引脚、UHT 生成代码都靠这些前缀区分「有 `UObject` 身份」和「普通 C++ 值」。
- `AActor` 也是 `UObject`，但用 `A` 标「能放进关卡、有 Transform」。不要把 Actor 写成 `UMyActor`。
- 布尔成员用 `b` 前缀（`bIsActive`）：UHT 与部分序列化约定按这个识别，不是个人口味。
- 固定宽度：`int32` / `uint8` / `float`，不用 `int` / `unsigned char`。跨平台 ABI 与反射序列化都假定这些类型。
- 容器与字符串走引擎：`TArray` / `TMap` / `FString` / `TSharedPtr`，不要混 `std::vector` / `std::string` 进 UPROPERTY。
- 头文件 `#pragma once`；对应 `.cpp` 先 include 自己的 `.h`，再 Engine，再项目。
- 传给 UE API 的字面量用 `TEXT("...")`：宽窄字符由 `TCHAR` 决定，裸 `"..."` 在部分配置下会编不过或乱码。

---

## 2. 反射宏：UHT 生成什么，你漏了会怎样

每个 `UCLASS` / `USTRUCT` 头文件通常还要 `#include "MyClass.generated.h"`，且它必须是 **最后一个 include**。类体第一句是 `GENERATED_BODY()`（旧代码可能是 `GENERATED_UCLASS_BODY()`）。漏掉任一环，常见报错是找不到 generated 头、或 `StaticClass` 未声明。

### `UCLASS()`

出现在 class 声明前。常见 specifier：`BlueprintType`、`Blueprintable`、`Abstract`、`NotBlueprintable`、`ClassGroup`、`meta=(DisplayName="...")`。

```cpp
UCLASS(BlueprintType, Blueprintable)
class MYPROJECT_API AMyActor : public AActor
{
    GENERATED_BODY()
public:
    AMyActor();
};
```

`BlueprintType`：可以当蓝图变量类型。`Blueprintable`：可以在编辑器里继承出 Blueprint。两者经常一起写，但不是一回事。

### `UPROPERTY()`

让成员进入反射、垃圾回收、序列化、细节面板。常见 specifier：`EditAnywhere` / `VisibleAnywhere`、`BlueprintReadOnly` / `BlueprintReadWrite`、`Category`、`meta=(ClampMin, ClampMax)`、`Replicated`、`ReplicatedUsing`。

```cpp
UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Combat")
float Health = 100.0f;
```

面试要点：

- 指向 `UObject` 的裸指针若要被 GC 跟踪，必须是 `UPROPERTY`（或引擎认可的智能指针）。否则对象可能被收掉，指针变野。
- `Replicated` 只同步值；需要回调用 `ReplicatedUsing=OnRep_Health`，并在 `GetLifetimeReplicatedProps` 里 `DOREPLIFETIME`。
- `EditAnywhere` 能改默认值与实例；`VisibleAnywhere` 只读展示。不要为了「方便改」把不该暴露的字段全打成 EditAnywhere。

### `UFUNCTION()`

```cpp
UFUNCTION(BlueprintCallable, Category = "Combat")
void TakeDamage(float DamageAmount);

UFUNCTION(BlueprintImplementableEvent)
void OnDeath();
```

| specifier | 含义 |
|-----------|------|
| `BlueprintCallable` | 蓝图可调，C++ 有实现 |
| `BlueprintPure` | 无副作用节点（约定，不是编译器保证） |
| `BlueprintImplementableEvent` | 只有蓝图实现，C++ 不写函数体 |
| `BlueprintNativeEvent` | C++ 有 `_Implementation`，蓝图可覆盖 |
| `Server` / `Client` / `NetMulticast` | RPC；常配 `Reliable` / `Unreliable` |

面试陷阱：`BlueprintNativeEvent` 的 C++ 实现名是 `Xxx_Implementation`，不是 `Xxx`。RPC 必须在有 NetDriver 的 Actor 上，且 Server RPC 只应在客户端调用、由服务器执行。

### `USTRUCT()` / `UENUM()`

```cpp
USTRUCT(BlueprintType)
struct FMyStruct
{
    GENERATED_BODY()

    UPROPERTY(EditAnywhere)
    float Value;
};

UENUM(BlueprintType)
enum class EMyEnum : uint8
{
    None,
    Option1,
    Option2
};
```

蓝图能用的枚举几乎总是 `enum class : uint8`。`USTRUCT` 里要给蓝图/面板看的字段仍然要 `UPROPERTY`。

---

## 3. 构建系统：模块防火墙

一个模块典型结构：`ModuleName.Build.cs`、`Public/`、`Private/`。Target 在 `*.Target.cs`。

```csharp
public class MyModule : ModuleRules
{
    public MyModule(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "Engine", "InputCore"
        });

        PrivateDependencyModuleNames.AddRange(new string[] {
            "Slate", "SlateCore"
        });
    }
}
```

```csharp
public class MyProjectTarget : TargetRules
{
    public MyProjectTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Game;
        DefaultBuildSettings = BuildSettingsVersion.V4;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        ExtraModuleNames.Add("MyProject");
    }
}
```

面试要点：

- **Public 依赖会传递**：别人 Public 依赖你时，也会带上你的 Public 依赖。能 Private 就 Private，编译时间和包含污染都会小。
- `Public/` 头文件被其它模块 include；实现细节放 `Private/`。
- `.uplugin` 描述插件；模块仍在 `Source/` 下，各有自己的 `.Build.cs`。
- `TargetType`：`Game` / `Editor` / `Client` / `Server` 是不同链接产物。Editor 目标才会链编辑器模块。
- EngineLink 冷构建按约定名 / 主模块 / 唯一发现项解析 `*Editor` 目标；第二个 Editor target 写 `build.editorTargetName`（见 [review-analysis.md](./review-analysis.md) §5）。

---

## 4. 常用运行时模式

### 动态多播委托（蓝图可绑）

```cpp
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnHealthChanged, float, NewHealth);

UPROPERTY(BlueprintAssignable)
FOnHealthChanged OnHealthChanged;

OnHealthChanged.Broadcast(CurrentHealth);
```

`DYNAMIC` + `UPROPERTY(BlueprintAssignable)` 才能出现在蓝图细节面板。纯 C++ 热路径常用非 Dynamic 的 `TMulticastDelegate`，不能直接暴露给蓝图。

### 定时器

```cpp
GetWorldTimerManager().SetTimer(TimerHandle, this, &AMyActor::DoSomething, 2.0f, false);
GetWorldTimerManager().ClearTimer(TimerHandle);
```

要世界（`GetWorld()`）。对象销毁前应 `ClearTimer`，否则回调打到已销毁 Actor。循环定时最后一个参数 `true`。

### 子系统

```cpp
UMySubsystem* Sub = GetGameInstance()->GetSubsystem<UMySubsystem>();
UMyLocalPlayerSubsystem* Sub = ULocalPlayer::GetSubsystem<UMyLocalPlayerSubsystem>(LocalPlayer);
```

生命周期跟着 Outer：`UGameInstanceSubsystem`、`UWorldSubsystem`、`ULocalPlayerSubsystem`、`UEngineSubsystem` 不要混用。面试常问「这个状态该放 GameInstance 还是 World」。

### Gameplay Tags / Enhanced Input / 日志 / Spawn

```cpp
FGameplayTag Tag = FGameplayTag::RequestGameplayTag(FName("Ability.Attack.Melee"));

UEnhancedInputComponent* EnhancedInput = CastChecked<UEnhancedInputComponent>(InputComponent);
EnhancedInput->BindAction(MoveAction, ETriggerEvent::Triggered, this, &AMyCharacter::Move);

DECLARE_LOG_CATEGORY_EXTERN(LogMyGame, Log, All); // 头文件
DEFINE_LOG_CATEGORY(LogMyGame);                   // cpp
UE_LOG(LogMyGame, Warning, TEXT("Player health: %f"), Health);

FActorSpawnParameters SpawnParams;
SpawnParams.Owner = this;
AMyActor* Actor = GetWorld()->SpawnActor<AMyActor>(ActorClass, SpawnLocation, SpawnRotation, SpawnParams);
```

`RequestGameplayTag` 在 Tag 未注册时默认会确保失败可见（可配 `ErrorIfNotFound`）。日志 category 要成对声明/定义，格式串必须 `TEXT()`，`%s` 对 `FString` 要用 `*MyString`。

---

## 5. 面试时可以顺着问自己的问题

1. 为什么 `UObject` 指针要 `UPROPERTY`？GC 怎么找到它？
2. `BlueprintImplementableEvent` 和 `BlueprintNativeEvent` 的 C++ 侧各写什么？
3. `PublicDependencyModuleNames` 传递依赖会怎样拖慢编译？
4. `Replicated` 和 `ReplicatedUsing` 谁在何时调用？
5. 动态多播委托为什么必须 `UPROPERTY` 才能给蓝图绑？
6. `A` 与 `U` 前缀搞反，UHT 会出什么问题？

这些题都能从上面四节直接答；不必再依赖项目里的 `.mdc`。
