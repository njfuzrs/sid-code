---
Status: implemented
Date: 2026-11-06
---
# bg_task_list 同状态轮询改为拦截，管道憋输出的后台 shell 不再被判「静默」，任务列表不再整段 XML 上屏

## 决定了什么

事故会话 20261106-101611-d0a96bc1：后台全量测试 `bun test … 2>&1 | tail -60` 运行期间，
主代理 6 分钟内调用 71 次 `bg_task_list({status:"all"})`（中位间隔 4.3s，每轮输入约 24.6 万 token），
最后自己 `task_stop` 杀掉测试；TUI 上是 71 张 `⏺ bg_task_list` + 整段 `<task-list>` 标签块。

轨迹显示是三处缺陷串成的一条链，一并修：

1. **起点：静默口径误判**（`task/background-await.ts`）。`… | tail -60` 在退出前结构上不可能有输出，
   60s 后被判「静默 = 不会回报」。02:49:30 的 EndTurnShape 记 `running_background_tasks=false`，
   todo 闸门 T2 不再放行、转为 `todo_gate_retry` 强推续跑——模型无事可做，开始轮询。
   新增 `outputBufferedUntilExit(command)`：管道末段是 `tail`（非 `-f/-F/--follow`）/ `sort` / `wc` / `tac`
   时，该 shell 始终算「值得等」（它退出时照常有完成通知）。
2. **主因：轮询拦截漏了入口**（`task/background-poll-guard.ts`）。Q1 拦了 read `.output` / ls tasks 目录 /
   阻塞 task_output·bg_task_get，唯独没有 `bg_task_list`；循环检测的同参拦截默认关闭也不在场。
   新增 kind `status_poll`：有运行中后台任务、且「过滤条件 + 各任务 id/status/子代理工具调用数」签名与
   上次**放行**时相同 → 不执行，回一句带当前运行中任务的说明（非错误）。签名刻意不含耗时与 token 数——
   71 次返回体里唯一在变的就是 `<duration>`。回执文案 `BACKGROUND_RECEIPT_NOTICE` 同步点名 bg_task_list。
3. **显示**（`cli/ui/ui-utils.ts`、`history-adapter.ts`）。header 摘要「查看后台任务」，⎿ 正文为每任务一行
   「描述 · 状态 · 耗时」，结果摘要「N 个运行中」；模型侧 tool_result 不变。

## 放弃了什么（以及为什么不选）

- **默认开启循环检测**：它默认关闭有定案（shape 检测对 bash 结构性误判，见 loop-detection 默认关闭的实证），
  为一个工具的同参轮询重开整套检测器代价不对称。改在 Q1 加一个精确的入口。
- **按次数限流 bg_task_list**（如 N 次后拦）：两次之间状态真变了就是新信息，按次数拦会吞掉它；按状态签名拦
  不会丢任何信息。
- **把 bg_task_list 设为 `resultDisplayMode: "summary"/"hidden"`**：hidden 不满足判据②（没有别处呈现后台任务
  清单的结论）；summary 会连「当前有哪些任务」一起丢掉。改为提取可读正文，与 task_output 同一做法。
- **按命令文本识别「常驻服务」**：background-await 文件头已否决（词表列不全）。本次只识别 shell 语义上确定的
  「末段读到 EOF 才输出」，漏判的后果是退回今天的静默口径，不会新增死等。
- **打开 stallHardStop**：那是独立的默认值决策，不在本次范围。

代价：更省/更快 ↔ 更准。模型在状态未变时拿不到最新耗时；`… | tail` 形态的命令若真的挂住，不会再有静默唤醒，
只能靠用户或 ESC——此前它在 60s 后就被当作「不值得等」，实测这恰好是事故的起点。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/task/background-poll-guard.test.ts ./packages/core/tests/task/background-await.test.ts ./packages/cli/tests/ui/tool-summary-coverage.test.ts ./packages/core/tests/agent/background-receipt-copy.test.ts ./packages/core/tests/query/background-poll-intercept-wiring.test.ts` → 68 pass 0 fail；接线测试走真实 `executeTools`，第二次同状态 bg_task_list 的 execute 未被调用、发出 `status_poll` 事件、Pre/Post 配对。
- 变异自证：签名比较改成 `false` → guard + 接线测试 4 fail；删掉 `outputBufferedUntilExit` 分支 → await 测试 1 fail；history-adapter 的 bg_task_list 分支改成 `false` → 翻卡断言 1 fail。恢复后全绿。
- 端到端待验收：下一次真实会话里 `BackgroundPollIntercepted{kind:"status_poll"}` 应出现，且同一后台任务运行期间连续 bg_task_list 调用数 ≤ 2。
