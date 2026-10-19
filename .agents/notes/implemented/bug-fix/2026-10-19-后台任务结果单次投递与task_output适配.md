---
Status: implemented
Date: 2026-10-19
---
# 后台任务结果单次投递与 task_output 适配

来源：会话 `20261019-002707-0d3ddd0e` 里有 4 个后台 explore 子代理。模型用 `task_output(timeout=600000)` 阻塞等了 3–5 分钟，同时屏幕上是 4 张空白卡片。结束时，同一批结论在同一条 user 消息里出现了三份：task_output 的 result、它的 `.output` 流、通知的 `<result>`，合计 65,458 字符。

## 决定了什么

- **F1 投递所有权（R1）**：registry 新增 `resultDeliveredVia` 字段，配 `claimResultDelivery(id, via)`，首次认领成功，之后幂等。
  - 刻意不复用 `notified`。它在入队之前就置位，表示「已有投递通道」，驱逐判据和 S3 修复都依赖这个语义。
  - task_output 读到终态并认领成功后，`withdrawTaskNotification` 只撤回**该任务**的**终态**通知。队列为此新增 `removeWhere`，其余命令的顺序和序号都不变。
  - 第二道防线是 `isSupersededNotification`，出队和 `hasPendingNotifications` 共用这一个判据，避免空闲唤醒为一条作废通知空跑一轮。
  - 反向情况（通知先注入）：认领失败，task_output 照常返回，算模型的显式重读。
  - 前台子代理完成时直接以 `tool_result` 认领。
- **F2 返回体（R4）**：终态 agent 只返回 `<result>`，上限与通知一致（16000，超出给 output-file），不再拼 `.output` 流。格式从 JSON 改为 `<task-output>` 标签块，与通知同源。
- **F3 提示词（R2）**：以下几处统一写明「完成会自动通知，不要用 task_output 等待或轮询，简短告诉用户并结束本轮」：
  - sub_agent 的 `run_in_background` 描述和后台启动返回（后者附 `output_file`）；
  - bash 后台启动返回；
  - task_output 的 description；
  - 中英 system prompt 的 `subagent-result-policy`。
  - `block` 默认值没改，协调模式依赖它。
- **F4 TUI（R3）**：
  - `task_output / bg_task_get / task_stop` 的 header 显示「等待 / 查看 / 停止 · 任务描述」，取不到描述时退回 task_id。
  - 结果卡片只上屏 `<result>/<error>/<output>` 正文，摘要是「已读取结果 · N 行」，不再满屏 JSON 和 `\n` 转义。
- **F5（R5）**：`onTurnEnd` 增加 `turnText`（本轮文本，没有就是空串），6 个调用点都补齐。sub-agent 落盘 `.output` 改用 `turnText`。`textOutput` 保持「最后一次文本」语义，salvage 和汇总依赖它。
- **F6 可观测**：
  - `TaskLifecycle delivered` 带上 `via`；
  - digest 新增 L0 异常 `dual_result_delivery`，用纯函数 `detectDualResultDelivery` 扫 messages.json，新旧两种返回体都认。

## 放弃了什么（以及为什么不选）

- **只在 TUI 去重**：上下文里仍然是三份，「更省」这个方向没修到。
- **禁止对后台 agent 调 task_output**：协调模式靠它读 Worker（`coordinator/mode.ts`）。
- **学 cc 把 `notified` 改成「已投递」**：驱逐判据和 S3 修复都依赖现有语义，牵连面大。而且 cc 只封住了「TaskOutput 先读到」这一个方向，反向竞态没管。
- **推迟入队，制造 await 窗口**：这是靠时序赌竞态，不是判据。
- **改 `block` 默认值为 false**：会破坏协调模式和已有用法。F3 只降低模型阻塞的概率，正确性由 F1 兜底。
- **给 task_output 做专用 React 渲染组件**：文档 §4 F4 设想的是 ctrl+o 展开 markdown。本次只在数据层抽出正文，沿用通用折叠卡片，没有新建 UI 区（见反模式记忆 `subagent-progress-third-region-antipattern`）。展开形态如果还不够，再单开。

## 拿什么证明它生效了

- 基线：`detectDualResultDelivery` 跑会话 `20261019-002707-0d3ddd0e` 的 messages.json，检出 **7** 个任务（`set3biru7, senfhxhhe, a2rjb7yur, aslqowd4g, a1cw8bxet, ap4fn0mqo, azga4eb8b`），与文档预期的 [58] 1 + [66] 1 + [72] 4 + [90] 1 一致。
- 新增测试（共 11 例全绿；2026-10-19 follow-up 更正：原写 14 例，实际 11 例 = result-delivery 5 + subagent 1 + digest 2 + tool-summary 3），每条都做了变异自证或明确标注：

  | 测试文件 | 覆盖 | 变异 → 结果 |
  |---|---|---|
  | `packages/core/tests/task/result-delivery-ownership.test.ts` | F1、F2，5 例 | 删撤回调用 → 红；`hasPendingNotifications` 不用同一过滤 → 红；撤回去掉终态判据 → 红；恢复拼接输出流 → 红 |
  | `packages/core/tests/agent/subagent-output-turn-text.test.ts` | F5 | 改回 `info.textOutput` → 红，Received: 3 |
  | `packages/cli/tests/ui/tool-summary-coverage.test.ts`（新增 3 例） | F4 | 删 header 分支 → 2 红 |
  | `packages/core/tests/trace/digest-dual-result-delivery.test.ts` | F6 | 去掉 `viaNotification.has(id)` 交集判据 → 红（1 pass / 1 fail，2026-10-19 follow-up 补测） |

- `bun run affected-tests:run`：7039 pass / 0 fail（585 文件）。另外 `tests/tool + tests/task` 加新测试共 1329 pass。
- `typecheck:gate`、`lint`、`format:check`、`lint:boundary`、`lint:command-system` 全绿。`docs:gen-reference` 更新了 `website/ref/tools.md`。
- 端到端复测（本分支构建的二进制，无头模式，会话 `20261019-024840-d75dc356`）：让模型启动 3 个 `run_in_background=true` 的 explore 子代理，拿到结果后汇总。
  - 模型启动后**零次调用 `task_output`**，转去自己跑 glob（F3 生效；基线会话 4/4 次紧接着就阻塞 600s）；
  - `TaskLifecycle` 显示 3 个任务各有一条 `delivered via=notification`，没有第二路；
  - `detectDualResultDelivery` 跑该会话的 messages.json，结果是 **0**（基线是 7）；通知注入共 3,028 字符。
  - 这次场景小（每个子代理一次 glob），只证明了「不轮询 + 单次送达」，没有复现基线那种 4 个大结论的体量，65,458 → 约 2.5 万这条体量预期没有直接测到。
- 完成瞬间的叠印残影（文档 §6）不在本次范围内。
