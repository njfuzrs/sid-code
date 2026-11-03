---
Status: implemented
Date: 2026-11-03
---
# sub_agent 的类型字段统一走 resolveSubAgentTypeParam，认 subagent_type 别名

## 决定了什么

新增 `packages/core/src/agent/sub-agent-input.ts` 的 `resolveSubAgentTypeParam(input)`，作为 sub_agent 入参「子代理类型」的唯一取值入口。字段优先级为 `type` > `subagent_type` > `agentType`，只认非空字符串。下面四处原本各自读字段，现在都改为调用它：

- `agent/tool.ts` `isConcurrencySafe`：原先只读 `type`。模型传 `subagent_type: explore` 时返回 false，同一轮发出的多个只读子代理被分进串行批次。
- `agent/tool.ts` `execute`：原先只读 `type`，读不到就兜底成 `general-purpose`，explore 的只读工具边界随之失效。现在先归一化再兜底，归一化后删掉 `subagent_type`，下游（轨迹、hook、后台任务）只看到 `type`。
- `permission/rules.ts` `extractMatchValue`、`permission/checker.ts` plan 模式子代理判定：原先 `subagent_type` 优先，与执行层的 `type` 优先相反。两字段取值不同时，权限判的类型和实际运行的类型不是同一个。现在两层取值一致，都是 `type` 优先。
- `cli/src/ui/ui-utils.ts` 的两处 header 文案：原先读不到类型，卡片样式和正常时不一样。
- `tool/input-alias.ts` 的 `ALIASES` 登记 `subagent_type → type`：执行器在 `execute` 之前先过 `validateToolInput`（zod safeParse），未声明的 `subagent_type` 会被静默剥离。只在 `execute` 里认别名不够，见下方「拿什么证明」的第一次端到端。

触发证据：会话 `20261103-114056-3b4f9ca7` 在 03:50:52 同一轮发出 3 个 `{"subagent_type":"explore"}`，实际运行窗口是 03:51→03:54→03:56→04:01，首尾相接。8 条完成记录全部是 `类型: general-purpose`。`20261028-172259-f17ec422` 是同一形态：4 个 explore 在 09:24 同时发出，实际串行跑了 16 分钟。同期其余约 23 个会话用的都是 `type`，并发正常。与 PR #524（runToolUse 收口）无关，那次改动没有触及分区判定。

方向：主要服务「更快」（只读子代理恢复并行），同时修了「更安全」（explore 不再被悄悄升级成写类代理，权限与执行判同一个类型）。没有牺牲其他方向。

## 放弃了什么（以及为什么不选）

- **schema 改名为 `subagent_type`**：已有轨迹、提示词、测试、hook 脚本用的都是 `type`，改名会让另一半调用失配。别名两头都认，代价是一个函数。
- **schema 设 `additionalProperties: false`，让未知字段直接报错**：会把 deepseek 这类模型的调用变成「一次失败 + 一次重试」，多花一轮。另外 `_agentId` 等内部注入字段也要逐个豁免。别名吸收这次的已知变体就够了，而且零额外轮次。
- **只修 `isConcurrencySafe`**：并发恢复了，但 execute 仍兜底成 general-purpose，只读边界照样失效。权限层和执行层也仍然各取各的字段。四处同源，必须一起改。
- **只在 `execute`/`isConcurrencySafe` 里认别名，不进 zod 前的归一层**：首版就是这么做的，单测直接调 `execute` 全绿，端到端却仍是 general-purpose。原因是分区读原始入参（有 `subagent_type`，判成可并发），`execute` 读 zod 校验后的入参（已被剥离，兜底 general-purpose），结果写类子代理被并行执行，比修之前更糟。必须在 `validateToolInput` 的别名层改名，让两处看到同一份入参。
- **权限层保持 `subagent_type` 优先**：执行层跑的是 `type`，权限必须判实际会运行的那个类型，否则可以用 `subagent_type: explore` + `type: general-purpose` 让写类子代理通过 plan 模式。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/agent/subagent-type-alias.test.ts`：12 pass。其中「同一轮 3 个 subagent_type=explore 合成一个并行批次」原样复现了事故入参。
- `bun test ./packages/cli/tests/ui/ui-utils.test.ts`：22 pass，新增 subagent_type 显示类型的断言。
- 变异自证（逐处改回旧写法后重跑）：并发判定改回只读 `type`，2 条 fail；execute 改回只读 `type`，2 条 fail；权限层改回 `subagent_type` 优先，1 条 fail；ui-utils 改回只读 `type`，1 条 fail。恢复后全部转绿。
- 真实入口单测：`validateToolInput` 后 `subagent_type` 变成 `type`，且校验后的入参仍判为并发安全。去掉 `ALIASES` 里这一对，2 条 fail。
- 端到端（worktree `make build` 产物，`-p` 让模型同一轮发 3 个 `subagent_type: explore`）：
  - 首版（只改 execute）：会话 `20261103-121951-c100530a`，3 个子代理 04:19:58 同时启动（并发恢复），但 `agent_type` 6/6 是 general-purpose。这就是上面否决的那条路径。
  - 补上 input-alias 之后：会话 `20261103-122246-af793864`，3 个子代理 04:23:18.018/.020/.022 同时启动、04:23:21–23 结束，运行窗口重叠；`[子代理完成] 类型: explore` 6/6；`ToolInputAliasApplied{from:subagent_type,to:type}` 3 条。
