---
Status: implemented
Date: 2026-10-24
---
# Prompt cache §6 五个缺陷一次收口：冷热判定进程级、清理落成会话状态、断点避开 reminder、删 cache_edits 与 global scope

## 决定了什么

- **冷热判定（问题 1/2）**：新增 `api/cache-warmth.ts`，在 Anthropic provider 出口（`anthropic.ts` `recordPromptCacheLayout`）记录每次请求的**发出**时刻，进程级保存。只有距上次触碰 ≥ 60 分钟（最长可能 TTL）才算「能证明冷」；进程内无记录 = 不知道 = 按热。旧实现用 `LoopState.lastResponseAt`，每条用户消息新建 state → 首轮必判冷。
- **清理决策冻结**：冷清理改为 `ContextManager.applyColdCacheClear()`，决策写进会话状态，`getCleanedMessages()` 每轮逐字节重放；`setMessages`/压缩时清空。放在 `getCleanedMessages` 之前，所以 BeforeModel、raw.jsonl、prefix_break 看到的就是实际发出的前缀。判据复用 `microcompact.ts` 拆出的 `planMicrocompact`。
- **断点避开 reminder（问题 3）**：`reminder-inject.ts` 注入的块带 `transient: true`；`markLastUserMessageCacheBreakpoint` 把断点打在**第一个** transient 块之前，消息开头就是 transient 时退到上一条消息。`transient` 在 provider 序列化时剥掉，不上线。
- **删除 cache_edits（问题 4）**：整个 `cached-microcompact.ts` 状态机及 app/compact/auto-compact/post-compact 的接线、`notifyCacheDeletion` 一并删除。`SendParams.cacheEdits` 只保留类型并标 deprecated。
- **删除 global scope（问题 5）**：`CacheControl` 去掉 `scope`，`buildSystemBlocks` / `markLastToolCacheBreakpoint` 去掉 global 选项。
- **可观测性**：新增 `PromptCacheLayout`（每次 Anthropic 请求：transient 块数、断点是否落在 transient 上）和 `ColdCacheClear`（gap_ms、cleared、saved_chars、threshold_ms）两个事件，`trace/digest.ts` 的 `aggregatePromptCacheStats` 聚合，其中「gap 低于阈值的冷清理次数」就是回归计数。

方向：更省（不再在热缓存上制造 miss），代价是更少清理本地 token（见下）。

## 放弃了什么（以及为什么不选）

- **阈值保持 5 分钟**：本机流量基本走第三方网关，网关设的 TTL 不可知。5 分钟只是猜测，猜错就多付一整段前缀写入；少清一次只是少省一点本地 token。代价不对称，取 1h，与 Claude Code `timeBasedMCConfig` 同理。刻意不做成可配置项：调小就等于允许在热缓存上改写历史。
- **保留 cache_edits，默认关**：字段不在公开 Messages API（SDK 无此字段），ppchat 静默接受，删没删无法验证；保留一个从不生效、也测不到效果的路径就是死代码。Anthropic 公开的 context editing（`clear_tool_uses`）是另一套 beta 语义，需要的话另开方案。
- **global scope 补上 beta 头**：公开 API 的 `cache_control` 只有 `type`/`ttl`，缓存按 workspace 隔离；而且本仓静态区含记忆索引等用户特定内容，就算字段合法也不会跨用户命中。
- **断点只跳过末尾的 transient 块**：critical reminder 插在用户指令之前，只跳末尾的话断点仍然包含下一轮不存在的字节。
- **把 BeforeModel 探针挪到改写之后**：清理已经前移到 `getCleanedMessages` 之前，探针天然就在改写之后，不需要再挪。

## 拿什么证明它生效了

- `bun test` 跑新增/改动的 13 个文件：233 pass / 0 fail。`cold-cache-clear.test.ts` 覆盖：从未发请求 → 热；隔 2 分钟、10 分钟 → 热；隔满 1h → 冷；清理后下一轮发送副本仍是同一份占位、原始历史不变、幂等、setMessages 后清空。conformance 测试断言请求体不含 `cache_edits`/`scope`/`transient`，且断点不落在 reminder 块上。
- `bun run affected-tests:run`：581 文件 7566 pass / 0 fail；`make build` 自检通过，无 `will always be undefined`；`typecheck:gate` 66/66 无新增；lint、format:check、lint:boundary、lint:command-system 全绿。
- **上线后的端到端验收（未做，需要真实流量）**：① `ColdCacheClear` 事件里 gap_ms < 3600000 的计数必须为 0（修前回放 60 次 / 41 个会话）；② `PromptCacheLayout.message_breakpoint_on_transient=true` 占比从回放的 13% 降到 0。不能拿 prefix_break 次数当问题 3 的指标：reminder 字节照样会变，断裂次数不会降。问题 3 的成本收益只能看可信渠道（uniapi）的 cache_creation，ppchat 的 usage 不可信。
