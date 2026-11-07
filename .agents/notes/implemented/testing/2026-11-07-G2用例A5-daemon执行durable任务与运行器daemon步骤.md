---
Status: implemented
Date: 2026-11-07
---
# G2 用例 A5-daemon-schedule：运行器加 daemon 步骤，守住「会话建 durable 任务 → daemon 执行」

## 决定了什么

运行器新增 `SmokeCase.after: DaemonStep[]`，这是为 A5 加的最小多步能力。主 `-p` 跑完后，在同一隔离环境（同一用例仓、配置目录、假 HOME）里起 `daemon start --interval <ms>`，然后轮询 `daemon.log` 直到 `until` 正则命中。轮询相当于就绪/完成探针，不用固定 sleep。命中或超时后发 SIGTERM，宽限 5s 后 SIGKILL，无论成败都停掉。daemon 的 job 子进程继承 daemon 的 env，所以 `SID_CODE_REPLAY_FILE` 指向步骤自己的夹具（`job.jsonl`），这份夹具同样做 `${CASE_ROOT}` 替换和越界校验。

用例 `A5-daemon-schedule`：
1. 回放 `cron_create`，建一次性 durable 任务（`* * * * *`，`recurring=false`）。
2. `prepare` 把任务的 `createdAt` 往前拨 3 分钟。
3. 起 daemon，启动时的 catch-up 会补跑这个错过的一次性任务。

断言：
- `daemon.log` 按序出现 `调度任务入队` → `headless job 启动 source=schedule` → `headless job 完成`；
- `daemon-jobs/sched-*.json` 恰好 1 个，`source=schedule`、`exitCode=0`、`timedOut=false`，output 来自 `job.jsonl`；
- `scheduled_tasks.json` 变成 `[]`（一次性任务执行后自删）；
- `PostToolUse{cron_create, is_error=false}` 恰好 1 条。

判据取自触发清单 A5 人工实测 ②（2026-11-05，任务 a95b3443）。

## 放弃了什么（以及为什么不选）

- **像人工实测那样建「N 分钟后」的任务，然后等真实时钟**：不选。最快也要等到下一个整分钟，用例耗时在 0–60s 之间随机，还依赖 runner 的时钟。拨 `createdAt` 走 catch-up 是确定性的，0.7s 跑完。拨 `createdAt` 是安全的，因为它不在授权指纹里（`durable-grants.ts` `taskFingerprint` 不含 `createdAt`），不会被当成篡改拦下。代价是这条用例走的是 catch-up 路径，不是 `check()` 的周期到点路径。后者由单测 `core/tests/cron/` 覆盖，G2 这里不重复。
- **做通用的多步 / `services:` 框架**：本次不做。`DaemonStep` 只够 A5 用。A11 / A12 需要的桩服务（端口注入、就绪探针、日志并入）留到落 A11 时按总纲 §184 单独设计。这次的「轮询日志代替 sleep、无论成败都停」两条原则可以复用。
- **断言 daemon 进程的退出码**：不选。SIGTERM 后的退出码语义没有写成契约，判据放在日志和 job 记录上。

## 拿什么证明它生效了

- `make build && bun run smoke`：9 例全过。A5 连跑 3 次分别是 0.7 / 0.8 / 0.7s。第一次跑用了 20.9s，没能复现，推测是刚构建完首次启动二进制的冷启动开销。
- `bun run smoke:mutate -- A5-daemon-schedule`：2/2 killed。
  - `daemon.ts` 的 `onFireTask` 不入队：30s 内没有 `headless job 完成`。
  - `scheduler.ts` 不登记 durable-projects：daemon 发现不了任务，结果同上。
- 运行器的失败信息在变异复跑中自己修过一次。第一版在停机之后才读 `exitedEarly`，结果总是 true，「超时后被停」被误报成「daemon 提前退出」。改为发信号前先取值，复跑后显示「超时后已停止」。正则里的中文原先显示成 `\uXXXX`，已还原成原文。
- 跑完 `pgrep` 查不到残留的 daemon 进程，P-3 的假 HOME 断言也通过。
