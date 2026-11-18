---
Status: implemented
Date: 2026-11-18
Source: context 面板取数不准与信息缺失-修复与验收方案（2026-11-17）
---
# BeforeModel 轨迹事件补上请求前上下文估算四件套，让「估算 vs 真实 input」可逐次对账

## 决定了什么

`BeforeModel` 的请求载荷增加 4 个**只读、O(1)** 字段，并同时落到三处（events.jsonl 的
`BeforeModel.data`、raw.jsonl 的 `request_sent` 预写行、raw.jsonl 完整 pair 行的 `request`）：

| 字段 | 取值 | 口径 |
| --- | --- | --- |
| `ctx_estimated_tokens` | 发送前那一刻的 `ContextManager.estimateTokens(toolCount)` | 全量历史 + 锚点抬升，**未扣**本地释放 |
| `ctx_freed_tokens` | `getLocalFreedTokens()`（= `tokenFreedTracker.getTotalFreed()`） | 本地压缩/遮罩/清理累计释放量，**未乘**校准系数 |
| `ctx_anchor_tokens` | `getLastActualInputTokens()` | 上一次真实 usage 锚点；0 = 无锚点 |
| `ctx_calibrated` | `isCalibrated()` | 本会话是否已收到过真实 usage |

具体改动：

- `query/loop.ts`：主循环把 `ctxMgr.estimateTokens(toolCount)` 提成局部常量
  `sendEstimatedInputTokens`，`sendBudget` 与 `BeforeModel` 共用（原先内联在 sendBudget 参数里，
  两处各算一次）；收尾总结轮（P1-1）同款提成 `summaryEstimatedInputTokens`（toolCount 固定 0）。
- `context/manager.ts`：新增只读 `getLocalFreedTokens()`。此前释放量只有 Manager 内部可见，
  轨迹侧拿不到，误差无法拆成「锚点抬升」与「本地释放」两个分量。
- `hook/types.ts`：`BeforeModelInput.llm_request` 增加 4 个可选字段（每个都写清与既有
  `estimated_input_tokens_calibrated` 的口径差异）。
- `trace/{collector,writer,builder}.ts`：三处落盘点**条件写入**（调用方不带时字段不出现）。

## 放弃了什么（以及为什么不选）

1. **放弃只加在 events.jsonl 一侧**。方案 §4.1 要求核实 raw.jsonl 是否同 payload —— 核实结果是
   两条独立写入路径（`collector.handleBeforeModel` 分别构造 `request_sent` 行与 `requestSide`）。
   只在 events 一侧加，对账脚本必须按 index 跨文件 join，join 失败时是**静默少样本**；
   而真实 usage 就在 raw 同一行，天然适合直接算误差。所以三处都带、同源同值。
2. **放弃在采集器里重算估算**。raw_preview 已有 `estimateMessagesTokens`（纯启发式，与真实差
   1.23–1.29 倍）。再算一份就是造第三套口径，且与决策用的估算不同源——本仓已经踩过
   「同一口径重实现一遍就是重踩一遍」。
3. **放弃给子代理新增 BeforeModel 发出点**。方案 §4.1 第 3 条要求「子代理的 BeforeModel 也要带」，
   但核实后的事实是：**子代理根本不发 BeforeModel**（`fireBeforeModelEvent` 全仓只有
   `query/loop.ts` 两处调用；`trace/digest.ts` 与 `trace/pairing-deadline.ts` 的注释也写明
   「子代理不发 BeforeModel / 不走配对」）。要满足这条得先在 `agentic-loop.ts` 新增 hook 发出点，
   那会改变 hook 触发面与轨迹事件量，属于行为变更，超出 PR0「只加观测、不改行为」的边界，
   也会让 sub-agent 的 hook 契约变脸。留作后续独立 PR 的议题，已知：sidechain 暂时无法对账。
4. **放弃把 freed 乘校准系数**。PR0 的字段语义定义为「决策里实际减掉的那个量」，当前决策就是
   未校准原始值（`getContextUsageForDisplay` / `getCompactionLevel` 减的就是它）。乘系数是 PR2 的
   事，届时字段名与语义不变、取值口径跟着变。
5. **放弃在 PR0 里写分析脚本**。方案 §8.3 的 E0 基线是独立一步（用「main + PR0」构建跑），
   脚本与场景构造属于 E0 的交付物；PR0 只负责把字段铺到轨迹上，并在此处登记 M3/M4 的源字段。

**M3 / M4 源字段登记**（方案 §8.3 要求写进 PR0 正文，已回源码核实存在）：

- **M3 越界事故（超窗 400/413）**：`errors.jsonl` 的 `{event:"Error", data:{phase, index, error, stack}}`
  （`collector.recordError`，engine 的 catch 会调用）+ `events.jsonl` 的 `TurnError`
  事件（`collector.recordTurnError`，data 含 `error`/`stack`/`turn`）。越界类文案的识别谓词
  在 `llm/error-lexicon.ts`（`context_length_exceeded` 等词表），E0 分析脚本直接复用该词表，
  不另写一套正则。
- **M4 压缩次数**：压缩产物的 `_meta.compact_source`（`manager.ts` 两处写入，取值域见
  `context/auto-compact.ts` 的 `COMPACT_SOURCES`），另有 `_meta.compact_boundary` 携带边界元信息。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/trace/before-model-context-estimate.test.ts` → **3 pass / 0 fail**，
  30 个断言，覆盖：4 字段进 events data 且类型正确、能与同 index 的 AfterModel 配对；
  raw.jsonl 两条记录同源同值；调用方不带时三处都不出现（老载荷形状不变）。
- **变异自证**：把 `collector.ts` 里 `ctx_estimated_tokens` 的写入改成常量 `0`，上面那条断言变红，
  失败信息为 `Expected: 123456 / Received: 0`（精确指向被改坏处），恢复后重跑回到 3 pass。
- 端到端：`make build` 后用 `./sid-code -p` 跑 3 轮会话，`events.jsonl` 里每条 `BeforeModel`
  都带 4 个字段、且与同 index 的 `AfterModel` 配对（详见 PR 正文的实测输出）。
- 门禁：`affected-tests:run` / `make build` / `lint` / `format:check` / `typecheck:gate` /
  `docs:gen-reference --check` 的结果见 PR 正文。
