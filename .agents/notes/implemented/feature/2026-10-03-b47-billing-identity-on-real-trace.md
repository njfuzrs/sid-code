---
Status: implemented
Date: 2026-10-03
---
# 计费恒等式落到真实轨迹：BilledRequest 落盘 + digest 逐会话复算

## 决定了什么

- `llm/billing-sink.ts` 的 `recordBilledRequest` 在**去重之后**调 `trace/stream-observer.ts` 新增的
  `emitBilledRequest`，往 `events.jsonl` 写一条 `BilledRequest`（`fetch_id` / `index` / `model` /
  `provider` / `agent_id` / `caller` / `accounted` / `charged` / usage 四项）。
  以前计费事件只通知内存观察者，`HttpConnected == 计费事件数` 只能在单测里断言。
- `trace/digest.ts` 的 `computeProcessPathology` 新增 `billableConnections` / `billedRequests` /
  `billingIdentityBroken`，不等就产出 high 级 L0 异常 `billing_identity_broken`（`/trace` 与
  `trace-digest.ts` 共用这份实现）；`collector.ts` 的 `pathological` 列表同步加 `billing_identity`。
- 左边口径：只数 2xx 且非 `text/html` 的 `HttpConnected`。非 2xx（Responses 路径判 `!ok` 后直接返回）
  和网关伪装 200 的 HTML 错误页都不计费，算进去会让每次网关报错都触发假异常。
- 老轨迹（一条 `BilledRequest` 都没有）右边记 `undefined`，不判。

## 放弃了什么（以及为什么不选）

- **在 provider 三个收口点各 emit 一次**：会绕过去重，同一 fetch 两个出口都 emit 时右边被撑大，
  正好把"漏记"掩盖成"平衡"。放在 sink 去重后，三条协议路径自动全覆盖，且只有一处实现。
- **把 `AfterModelRaw + side 账` 当右边**：两者粒度不同（主循环跨 attempt 累加），对不齐；
  而 `BilledRequest` 与 `HttpConnected` 同为单次 fetch 粒度。
- **老轨迹右边记 0**：全部历史会话会报红，告警通道直接作废。

已知盲区不变：绕过 provider 自发 fetch 会让两边一起少，仍由 `scripts/pricing-reconcile.ts` 对账单兜底。

## 拿什么证明它生效了

- 新测试 `packages/core/tests/trace/billing-identity-real-trace.test.ts` 6 pass；
  加上原有 billing / digest-pathology / stream-observer 测试共 5 个文件 74 pass / 0 fail。
- 变异自证：注释掉 sink 里的 emit → 落盘用例红；把判定改成恒 false → 两个"不等"用例红。
- 真实会话（`make build` 后用本地二进制跑，2026-10-02/03）：

  | 会话 | 可计费建连 | BilledRequest | 说明 |
  | --- | --- | --- | --- |
  | `20261002-221525-5750030d` | 2 | 2 | 仅主循环 |
  | `20261002-221555-a25a18a2` | 5 | 5 | 仅主循环 |
  | `20261002-221846-8e22dbee` | 2 | 2 | 仅主循环 |
  | `20261003-120102-0c981309` | 4 | 4 | 主循环 2 + 子代理 `agent:builtin` 2（`charged=true`） |

  最后一个会话 `extraConnections=2`：旧口径里这 2 次"建连未记账"，现在轨迹能直接证明它们已经入账。
- 真实轨迹变异：把该会话 events 复制到临时 `SID_CONFIG_DIR`，删掉一条子代理 `BilledRequest`，
  `trace-digest --json` 报 `billing_identity_broken`：「可计费建连 4 次，计费事件 3 条（少 1 条）」。
- 未覆盖：本次真实会话没有触发 fork（session-memory / memory-extract）这类辅助调用，
  这一类的线上对平还要等下一个长交互会话复算。
