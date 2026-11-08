---
Status: implemented
Date: 2026-11-08
---
# `-c` / `--resume` 后 `--output-format json` 的 `session_id` / `trajectory_path` 改用逻辑会话 id

## 决定了什么

`runHeadless` 的 json 结果原来用 `sessionState.sessionId`（进程新 id）拼 `session_id` 和 `trajectory_path`。resume 时：

- 轨迹续写进被恢复会话的目录（collector `traceSessionId = resumed_from`），`sessions/<进程 id>/` 根本不存在；
- `--resume <进程 id>` 报「未找到会话」exit 1，只有逻辑 id 能恢复。

2026-11-08 构建产物探针复现：首次 `-p` 得 S1；`-c -p` 交出 S2 与 `sessions/S2/session.traj`，磁盘上只有 `sessions/S1/`；`--resume S2` exit 1，`--resume S1` 正常。

改为 `getLogicalSessionId()`，两个字段同源。非 resume 时逻辑 id = 进程 id，行为不变。

新增 G2 用例 `X4-resume-id`（台账 §三 X4）：主运行 `-p`，`after` 跑 `-c -p`，断言第二次交出的 `trajectory_path` **在磁盘上存在**、`session_id` 等于被恢复的会话。运行器 print 步骤结果补 `stdout` 字段供断言。

## 放弃了什么（以及为什么不选）

- **新增 `process_session_id` 字段同时交出进程 id**：不加。目前没有消费者要进程 id（eval 适配器读 `trajectory_path` 判健康、读 `session_id` 拼 trace id），加字段就是无调用方的契约。
- **改 stream-json `result` 的 `session_id`**：不在本次。`headless-runner.ts` 的错误分支是空串，成功分支来自 SDK 引擎（它收到的也是进程 id），是另一条路径，需单独探针核实 resume 下的实际值。
- **静态源码门禁锁「这里必须调 getLogicalSessionId」**：不加。已有 G2 真二进制用例按磁盘事实断言，文本门禁只会锁住实现写法。
- **断言写成「session_id 等于某个 id」为主判据**：主判据是「路径存在」。两个 id 都是合法 string，相等断言容易对着错的那个写（agent 记忆「resume 两个 id」）；「存在」只认磁盘事实。

## 拿什么证明它生效了

- `bun run smoke -- X4-resume-id`：PASS（0.6s）。
- `bun run smoke:mutate -- X4-resume-id`：1/1 killed。改回 `this.sessionState.sessionId` → 「`-c -p` 交出的 trajectory_path 不存在」。
- `bun run affected-tests:run`：4951 pass / 10 skip / 0 fail（388 files）。
- 跨域字面量 grep（`trajectory_path`、`sessionState.sessionId`）命中的 3 个测试文件单跑：52 pass / 0 fail。
- `make build`、lint、typecheck:gate、lint:command-system、`docs:gen-reference --check` 全绿。
