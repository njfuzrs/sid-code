---
Status: implemented
Date: 2026-11-19
Source: 缓存断裂归因失效与命中口径-缺陷复核与修复方案（2026-11-19）
---
# 缓存断裂归因改为比较相邻两轮「请求前」快照，并补齐消息前缀与失败路径抑制清理

## 决定了什么

`packages/core/src/api/cache-detection.ts` 的 `CacheBreakDetector` 从「一个基线字段」改成
「基线 + 待提升快照」两段式：

- `recordPromptState()` 只写 `pendingState`（本轮请求前前缀），不再覆盖 `previousState`；
- `checkResponse()` 拿 `prev = previousState`（上轮请求前）与 `curr = pendingState`（本轮请求前）比较，
  四条出口（抑制 / 首轮 / 未达阈值 / 正常比较）统一调 `promotePending()` 把 pending 提为基线并清空；
- `pendingState` 为 null 时直接返回，**既不比较也不改基线**（回落到响应后 snapshot 会把本轮 assistant
  与 tool results 算进 `messageCount`，下一轮必然触发 compact 兜底误报）；
- `reset()` 补清 `pendingState`。

配套两处：

- `packages/core/src/query/loop.ts` 请求前的 `recordPromptState` 补 `messages: sendParams.messages`
  （缺了它，`message_history` / `message_prefix` 两类永远不可达）；
- 新增 `cancelSuppression()` 并在流式 catch（请求失败的唯一入口）调用，只清 `suppressNext` 不动基线。
  `MultiSourceCacheDetector` 转发时只对**已存在**的 detector 生效，避免为一次失败凭空造基线并挤掉 LRU。

## 放弃了什么（以及为什么不选）

- **否决「在 `checkResponse` 里重新 snapshot 作为 curr」**：这正是缺陷本身 —— prev 与 curr 变成同一轮
  的两个快照，8 个本地类别恒不可达。也没选「保留旧字段名、只改写入时机」：语义已经变成"待提升"，
  沿用 `previousState` 会让下一个人看不出两段式的必要。
- **否决「`pendingState` 为 null 时回落到 `snapshot(params)`」**：`messageCount` 取的是响应后的值，
  比下一轮请求前快照大，命中 compact 兜底判据后会误报一次压缩。
- **否决「失败路径用 `reset()` 取消抑制」**：`MultiSourceCacheDetector.reset()` 是 `detectors.clear()`，
  清的是全部 agentId 的基线，下一轮走「首轮」分支直接丢一次检测机会；且失败请求的前缀很可能已被
  服务端缓存（缓存写入发生在 prompt 处理阶段），基线必须保留。
- **否决「惰性/增量指纹」**：实测 300 条 × 2KB 消息单次全量 snapshot 约 0.506ms，低于 1ms 门槛，
  为省这点开销引入增量维护状态不值得（增量状态本身会带来新的失效口径）。

## 拿什么证明它生效了

修复前后各跑一遍，改坏再恢复（变异自证）：

- 变异①：`recordPromptState` 改回覆盖 `previousState` → 新增序列用例 (a)(b) 报
  `expect(received).not.toBeNull() Received: null`，接线层 3 条报 `toBeGreaterThan(0) Received: 0`，
  共 12 条红；既有三个测试文件另外红 27 条。恢复后 16/16 绿、既有文件全绿。
- 变异②：删掉 `loop.ts` 的 `messages: sendParams.messages` → 接线层「两轮之间改写历史第 3 条 →
  message_history」报 `Expected: true, Received: false`；恢复后绿。
- 变异③：失败路径 `cancelSuppression("main")` 换成 `resetCacheDetection()` → D7 接线用例报
  `toBeGreaterThan(0) Received: 0`（一条中断记录都没产生）；恢复后绿。

命令与输出：

- `bun test ./packages/core/tests/api/` → 213 pass / 0 fail
- 连同 clear-resets-cache-state / cache-telemetry-rotation / no-real-path-writes / 两个 compaction
  相关文件 → 249 pass / 0 fail（16 files）
- 性能：300 条 × 2KB 假会话，预热后 40 次平均 0.506ms/次

## 没做的

- G2 无头回放用例未加：`expect` 只能从人工核过的轨迹抄，agent 不得自造，留给维护者。
- D7 接线用例只覆盖 `prompt-too-long` 失败分支；同一 catch 内的超时重试耗尽 / 未识别错误分支
  执行同一行 `cancelSuppression`，未逐一构造验证（推测已验证分支覆盖同一行）。
