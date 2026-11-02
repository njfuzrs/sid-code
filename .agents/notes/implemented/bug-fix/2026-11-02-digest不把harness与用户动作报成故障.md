---
Status: implemented
Date: 2026-11-02
---
# digest 不把权限拒绝、中断收尾、慢响应、退出截断报成故障

## 决定了什么

改动都在 `packages/core/src/trace/digest.ts`，只改事后判读，不改采集。

- **权限拒绝单列**：traj 里 `is_error` 的 observation，如果 events.jsonl 有同 `tool_use_id` 的 `PermissionDenied` 事件，不再计入 `tool_result_is_error`，改计新 kind `tool_permission_denied`（L0，low，detail 按拒绝原因分组）。工具序列里标 `⊘` 不标 `✗`。因为 `tool_result_is_error` 在 collector 的 `REAL_ERROR_KINDS` 里，`real_errors` 随之不再含权限拒绝。`events.jsonl` 的读取挪到工具序列之前，下面的诊断段共用同一份。
- **中断收尾时在途的模型调用**：会话有 SessionEnd、退出状态是 abort / user_interrupt / terminal_closed，且主链尾部有一段连续未配对的 BeforeModel 时，这一段不再报 `unpaired_before_model` + `hypothesis_model_call_lost`（两条 high），改报一条 `model_call_inflight_at_exit`（L0，low）。detail 区分请求有没有发出（看 HttpConnected），并带出中断前最后一次工具调用和它的耗时。例外：这一段里已经触发过 TimeoutFired / TimeoutRetry / StreamStall 的，退出前就卡住了，照旧报 high。
- **看门狗触发后最终返回**：`ModelCallUnpaired` 的同 index 后来出现 AfterModel / AfterModelRaw / TurnError 时，改报 `model_call_slow_response`（medium），detail 带总耗时，以及这段时间里 StreamRestart 的原因序列（如 `server_error → auth_failed → retry_same`）。
- **计费恒等式的退出截断**：计费事件偏少时，按 `agent_id:index` 多重集配对，列出缺计费事件的建连。缺口全部是 SessionEnd 前 10 秒内建的连接时，`billing_identity_broken` 降为 low，并写明是退出截断。

## 放弃了什么（以及为什么不选）

- **按 content 的「权限拒绝:」前缀判**：文案是给人看的，改一次措辞判据就静默归零。`llm/types.ts` 的 `permissionDenied` 字段注释和 app.ts 的 fidelity 计数已经因为这个原因不按文案判。本地实测 157 条带前缀的权限拒绝里 156 条有 `PermissionDenied` 事件，另有 2 条没有前缀但有事件。messages.json 的 `permissionDenied` 字段只由 query/tool-executor 一条路径写（只覆盖 76 条），也不选。
- **权限拒绝完全不报**：非交互模式下没放行工具、`[injection:*]` 规则误报，这两类本身值得看，只是不是工具故障。所以留一条 low。
- **中断在途只认「最后一个 BeforeModel」**：收尾期间可能再发一次（1fa54a0a 的 90→91），只认最后一个会漏掉前一个。
- **中断在途一律降级，不看超时**：87302ec8 是 16 分钟没响应、超时重试后用户才中断，那是真 stall。
- **看门狗改成只要后来返回就不报**：返回慢到触发看门狗本身值得知道，所以报 medium 而不是删掉。
- **在采集侧给看门狗扣掉等用户选 fallback 的时间（`excluded_prompt_ms`）**：方案 T3 里有这一步，这次没做。它改采集、只对新会话生效，适合单独一个 PR；旧会话已经被「后来配对成功就降为慢响应」兜住。
- **退出截断窗口取更大值**：10 秒取自复核样本（建连后 7–8 秒关终端）留的余量，没有更多实测依据。

## 拿什么证明它生效了

- 新增 `packages/core/tests/trace/digest-harness-actions-not-faults.test.ts`，13 条用例覆盖四种形态及其反例（end_turn 时仍报 hang、中间未配对仍报 high、真 stall 仍报 high、一直不返回仍报 high、缺口离结束很远仍报 high、只有文案没有事件仍按工具错误计）。
- 变异自证，六处都看到预期的红：
  - 不认 PermissionDenied 事件：2 fail
  - 不看退出状态：1 fail
  - 看门狗不看结局：1 fail
  - 退出截断不降级：1 fail
  - stall 例外失效：1 fail
  - 只取最后一个而非尾部一段：2 fail
- 本地真实数据验收：对 359 个有 summary 的会话，分别用 main 和本分支的 `scripts/trace-digest.ts --json` 跑，逐会话对比：

  | | main | 本分支 |
  | --- | --- | --- |
  | 有 high 的会话 | 224 | 208 |
  | `real_errors > 0` 的会话 | 158 | 122 |
  | `tool_result_is_error` high / medium | 48 / 98 | 26 / 82 |
  | `unpaired_before_model` high | 21 | 2 |
  | `model_call_unpaired_watchdog` high | 15 | 5 |
  | `billing_identity_broken` high | 14 | 12 |

  本分支没有在任何会话里新增 high。仍报 `unpaired_before_model` 的 2 个会话（87302ec8、7b137546）都是中断前已经超时重试过的真 stall。
- `bun test packages/core/tests/trace/`：989 pass / 0 fail；`bun run affected-tests:run`：989 pass；`make build` 自检通过。
- 口径变化：northstar 的「单会话真错误」读的是 `real_errors`，本地 36 个会话会从 > 0 变成 0。这是口径修正，不是进步，读趋势时要按 2026-11-02 断开。
