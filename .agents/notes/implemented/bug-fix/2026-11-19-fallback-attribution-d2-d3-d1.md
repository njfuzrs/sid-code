---
Status: implemented
Date: 2026-11-19
Source: 降级判断链路的归因缺口与冷却维度错位-缺陷复核与修复方案（2026-11-19）
---
# 降级链路第一批：fallback 事件带回真实根因、7 类事件补 querySource、consecutive529 改名

## 决定了什么

只改「落盘了什么」与命名，**不改任何重试/降级裁决**。第一批含 D2 + D3 + D1（可读性部分）。

**D2 —— `fallback` 事件的 `error` 不再恒为「主模型失败」**（`packages/core/src/llm/fallback.ts` tryFallback 内）：

- 新增 `fallbackReason`，三级取值：`ctx.lastGiveUp` → `family/reason status=[...] attempts=N`；
  否则 `ctx.lastRetryError` 原文；最后才退回旧文案。
- `onFallback` 钩子文案与遥测 `error` **共用同一个变量**——此前是两份独立的同款硬编码，
  只修遥测会让 UI 文案继续无信息。
- 同一条事件补 `querySource` / `viaDecision` / `attempts` 三个字段。`attempts` 取
  `ctx.totalRetriesThisCall + 1`（该字段是**重试次数**，从 0 起；而事件契约里 `attempts`
  是**总尝试次数**，与 `recovery_give_up` 同口径）。
- `RetryTelemetryEvent` 新增 `viaDecision?: boolean`：区分「用户手选切换」与「链路自救」。

**D3 —— 6 类遥测事件补 `querySource`**（字段早已存在，只是调用点没传）：

`cooldown_probe` / `cooldown_probe_denied` / `shared_cooldown_wait`（入口侧 + 重试侧）/
`retry` / `non_streaming_degrade`。取值一律是 `perCall.querySource`（已解析值）或
`ctx.perCall.querySource`（tryFallback 侧），**不是 `params.querySource`**。

**D1 —— `consecutive529` → `consecutiveOverloaded`，`MAX_529_CONSECUTIVE` → `MAX_OVERLOADED_CONSECUTIVE`**：

`error-normalize.ts` 把 503 与 529 同映射为 `overloaded`（有意合并），旧名让读者以为只统计 529。
改名同时在使用点补注释说明：503/529 共用阈值是有意的、真实状态码在 `statuses` 里没丢、
要按状态码看分布应在 digest 侧聚合、⛔ 不要为此拆 `ErrorReason`。

## 放弃了什么（以及为什么不选）

- **否决「给 `fallback` 事件单加 `fallbackReason` 字段、保留 `error: "主模型失败"`」**：
  消费侧（轨迹库、digest、`--verbose`）已经在读 `error`，新增字段等于所有消费方都要改一遍
  才看得见证据。直接改 `error` 的内容，零消费侧改动就生效。
- **否决「只在 `emitTelemetry` 内统一注入 `querySource`」**：`emitTelemetry` 拿不到 `perCall`，
  且它会破坏「未传则不写」的事件形状约定（`agentId` 走的就是这个约定）。
- **否决「用 `params.querySource`」**：`SendParams` 上没有这个语义，且会漏掉
  「调用方未显式传、回落 `config.querySource`」的默认路径——这条已被用例单独钉住。
- **否决「拆 `ErrorReason` 让 503 独立」**：波及 13 个文件 20 余处，且文案路径没有状态码，
  拆完仍要在别的维度合并。改用「命名准确 + 注释说明 + `statuses` 已在证据里」达成同一目标。
- **否决「把 D6（退避时长按状态码分档）并进本批」**：D6 是**行为变更**（改实际等待时长），
  与本批「只改落盘」性质不同，混在一起会让回滚粒度失真。D4/D5 动并发语义，同样单独立项。
- **否决「给 `retry_budget_exhausted` / `unrecognized_error` / `auth_refresh` / `max_tokens_adjust` 一并补 `querySource`」**：
  前三个属「可补但不在本批范围」，`max_tokens_adjust` 与来源无关（补上会稀释「按来源归因才有意义」的口径）。
  评估结论已记录在缺陷文档的待办项里。

## 拿什么证明它生效了

- 新增 `packages/core/tests/llm/retry-attribution.test.ts`（8 用例）：`fallback` 的
  `error` 含 `family/reason` 且不等于旧字面量、`onFallback` 与 `error` 逐字相同、
  `querySource` 在「显式传」与「回落 config」两条路径下都对、`viaDecision` 布尔、
  `attempts` 与 `recovery_give_up` 同口径；`retry` 事件 `querySource === "agent:fork"`；
  入口侧 `shared_cooldown_wait` / `cooldown_probe` / `cooldown_probe_denied` 带来源。
- **变异自证**（6 条，逐条改坏 → 确认变红 → 还原）：删 `retry.querySource`、
  `onFallback` 退回硬编码、`attempts` 去掉 `+1`、`querySource` 换成 `params`、
  删入口 `shared_cooldown_wait.querySource`、删 `cooldown_probe.querySource` —— 全部变红。
  其中 `cooldown_probe` 第一轮**没被拦住**（当时无用例覆盖探针放行路径），补用例后才红，
  这条过程记录保留在缺陷文档里。
- `recovery-invariants.test.ts` 新增 3 用例：503 与 529 同判 `overloaded`、
  overloaded 三连触发 `give_up("budget")`、503 三连与 500 三连在 `statuses` 上分得开。
  变异自证：阈值 3→99、503 映射改成 `server_error`，对应用例分别变红。
- 命令与结果：`bun test ./packages/core/tests/llm/` → **2304 pass / 0 fail**；
  目标 6 文件 → 111 pass / 0 fail；`bun run smoke` → 43/43 通过；
  `bun run lint` 0 warning / 0 error、`format:check` 全通过、`typecheck:gate` 无新增（62/62）、
  `lint:boundary` / `lint:command-system` / `lint:legacy-tool` 通过、`make build` 自检通过。
- 未闭环：重试侧 `shared_cooldown_wait`（`fallback.ts:1617`）与 `non_streaming_degrade`
  （`fallback.ts:2107`）的 `querySource` 只有代码审查与类型检查，**无专门用例**。
