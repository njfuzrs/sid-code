---
Status: implemented
Date: 2026-11-18
Source: 只读子代理空转与过期清理重读循环-修复与验收方案（2026-11-16）
---
# spawn 路径的只读 bash 门禁补齐：`explore` 在 spawn 模式下能写文件

## 决定了什么

PR12 的门禁只在**进程内**两条路径生效，spawn 路径完全没接。本次在 spawn 路径把同一道门禁补上。

三处改动，都在 `packages/core/src/agent/sub-agent.ts`：

1. `executeSpawnedInternal()` 新增 `readOnlyAgent = false` 参数，由 `executeSpawned()`
   （内置类型）与 `executeSpawnedCustom()`（自定义 agent）各自传 `agentDefinition?.readOnly === true`。
   两处都要传：只改一处会让另一条入口继续静默失效。
2. `executeToolForChild()` 新增同名参数，在 `runToolUse` 之前对 `name === "bash"` 的实例套
   `wrapBashWithReadOnlyGuard` —— 与进程内路径**同一个包装器、同一个判定函数**，不写第二份命令名单。
3. `executeSpawnedInternal` 里调用 `executeToolForChild` 时把标志传下去。

## 为什么会漏

`buildIsolatedToolRegistry()`（唯一应用 `wrapBashWithReadOnlyGuard` 的地方）只在进程内
`executeInner` / `executeCustomInner` 调用。spawn 路径把 `task.tools ?? this.toolRegistry`
——父的**原始**注册表——直接交给 `executeToolForChild`；`task.tools` 全仓无赋值点，
所以永远落到父注册表。子进程只回传 `tool_use`，工具实际由父进程执行，执行时拿到的是
未包装实例。

可达性：`shouldUseSpawn()` 依赖 `HEADLESS_AVAILABLE = existsSync(cli/src/entrypoints/headless.ts)`。
源码态为 true，编译产物为 false —— 所以线上二进制不受影响，但开发/源码运行态下
`explore` 能用 bash 直接写文件。「只读」在那条路径上只剩提示词，而提示词是模型可以违背的建议。

## 放弃了什么（以及为什么不选）

- **放弃「在 `executeSpawned`/`executeSpawnedCustom` 里重建一份隔离注册表」。**
  `buildIsolatedToolRegistry` 的职责包括重建有状态工具、给每个子代理一份独立
  `FileReadTracker`、隔离 `todo_write`、重挂 `tool_search`——那是进程内路径的完整装配。
  spawn 路径子进程有自己的上下文，父侧只需一个「执行 tool_use」的入口，
  为一道判定把整条装配搬过来，会把这次修复变成一次子系统重构，风险与收益不成比例。
- **放弃「在 `ToolRegistry` 层面做只读过滤」。** 那是「让 bash 不可见」，会同时改掉
  `explore` 的能力面（它确实需要只读检索）。门禁要的是「可见但写不了」。
- **放弃「只在 `executeToolForChild` 里判断、不传参」。** 那个方法拿不到 agent 类型
  （`sidechainMeta.agentType` 在上一层），从 `this` 上也推不出来——子代理可能并发多条。
  参数显式传是最不容易漂移的形态。

## 拿什么证明它生效了

新增 4 例 G1（`packages/core/tests/agent/sub-agent-spawn.test.ts`）：

- `readOnlyAgent=true` + 写命令 → `is_error` 且**内层 `execute` 一次都不跑**
  （只断言 `is_error` 分不清是门禁拦的还是权限层拦的，所以用间谍工具数调用次数）；
- `readOnlyAgent=true` + 只读命令 → 放行且内层真的执行；
- `readOnlyAgent=false`（默认）→ 写命令照常执行，不误伤 `task` 类子代理；
- 源码哨兵：**按函数体切片**断言两处 spawn 入口都传了 `readOnly`
  （数全文出现次数会被进程内路径那一处同形表达式蒙蔽，改坏 spawn 时仍然绿）。

变异自证（两条，均确认变红后恢复）：

| 变异 | 结果 |
| --- | --- |
| 删掉 `executeToolForChild` 里的门禁段 | 「写命令被门禁拒」红，其余 3 例绿（符合预期） |
| 只删自定义 spawn 入口的 `readOnly` 传参 | 源码哨兵红，3 例行为断言绿（正是「只改一处」该有的形态） |

门禁：

- `bun test ./packages/core/tests/agent/` → 807 pass / 0 fail
- `bun run typecheck:gate` → 62/62，无新增
- `make build` → 通过，产物自检全绿
- `bun run smoke` → 43/43
- `bun run lint` / `format:check` / `lint:boundary` / `lint:legacy-tool` → 全绿

## 已知边界（不在本次范围）

PR7 的请求前预算硬停同样只覆盖进程内路径，spawn 模式不受约束 —— 但那是**方案里
明文写过的取舍**（编译产物不可达，收益不抵装配成本）。本次不同：PR12 的门禁是安全约束，
「只读代理能写文件」与「预算闸漏一条路径」不是同一量级的后果，所以只补这一处。
