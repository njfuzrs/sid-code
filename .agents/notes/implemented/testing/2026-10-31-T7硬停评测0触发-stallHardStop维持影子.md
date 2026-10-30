---
Status: implemented
Date: 2026-10-31
---
# T7 硬停评测：terminal-bench 54 题 0 触发，`stallHardStop` 默认维持 false

## 决定了什么

在 `terminal-bench-w3-54@2.0` 上用 hard 档（`--ak`/env `stall_escalation=hard`）跑满 54 题，停滞阶梯 **L1 = 0、L2 = 0**。结论：

- 「开硬停不伤基线」成立：阶梯从未介入任何 trial
- **但评测给不出 L2 误判率**：分母（L2 命中数）是 0。`stallHardStop` 默认值**维持 false（影子）**，误判率改由本地交互影子数据（`StallEscalation{level:2}`）攒样本后再判，不再为此跑评测

归档：`evals/external-benchmarks/harbor/results/t7-sid-ds41-54-hard-m3g.json`。配置：二进制 `24a2b533`（含 #490 后台等待排除、#492 评测档、#494 `--verbose`），`--override-memory-mb 3072`（#495），`-n 4`，max_turns 80，模型 `origin-deepseek-v4-1-flash`。

### 为什么 0 触发（判据本身的行为，不是开关没生效）

- 开关确认生效：从 colima VM 读容器内 sid-code 进程 environ，带 `SID_CODE_STALL_ESCALATION_HEADLESS=1`、`SID_CODE_STALL_HARD_STOP=1`；每个 trial 的 metadata `sid_stall_escalation=hard`
- **窗口经常满**：24/54 题工具轮 ≥25；前 23 题里 9 题出现连续 ≥15 个工具轮没有 edit/write 落盘（最长 26 轮）
- **但那些段是正常探查**：段内工具调用重复率 0–30%，多数为 0%；不少在用 bash heredoc 写文件，2a 账本只认 edit/write 看不见
- **信号门槛拦住了**（`stall-escalation.ts` L1 需 ≥3 个信号且至少 1 个非回退）：全部轨迹 `UnchangedObservationRun` = 0、`TodoReworkDetected` = 2；绿点回归只解析 bun test，terminal-bench 用不到

## 放弃了什么（以及为什么不选）

- **据此把 `stallHardStop` 默认改 true**：0 次触发只证明「不伤基线」，证明不了「触发时判得对」。没有命中样本就改默认值，等于拿没测过的判据去停用户的任务
- **放宽 L1 信号门槛让评测能触发**：这 9 次窗口满全是正常探查，门槛正是挡住它们的那道。要放宽，必须先把 bash 写文件纳入 2a 账本，否则误报会大量涌进来
- **换一批题再跑**：terminal-bench 以 bash 为主是常态，换题不改变「账本看不见 bash 写入、信号源只有 bun」这两个结构原因；成本不值

## 拿什么证明它生效了

- 54/54 题 `StallEscalation` 事件数 = 0（逐个读 `trajectories/sessions/*/events.jsonl`）
- pass@1 = 66.7%（36/54，Wilson 95% [53.4%, 77.8%]），成本 $2.82（下界）。基线 `w3-sid-ds41-54` 51.9%、$7.81。**档位、max_turns、内存、并发、二进制五个变量同时变**，差值不能归给阶梯（阶梯 0 次介入）
- 仪器失败 7 题，不计能力账：sid-code 自身 memcg OOM 4（anon-rss 1.2–1.8GiB）、bash 挂住后手动 kill 2、上游 400 1。剔除后配对 47 题：0.745 / 0.553
- 第一次全量 `t7-sid-ds41-54-hard` 作废（2GiB 下 sid-code OOM，且二进制 27df03bf 不含 #490），保留为 `runs/t7-sid-ds41-54-hard.attempt1-oom`

### 顺带挖出、单独立项的两个缺陷

1. **bash 工具：后台 daemon 继承 stdout 时超时失效**。`install-windows-3.11`、`mailman` 最后一次工具调用后 1.5–2 小时无任何事件。本地最小复现：`perl -MPOSIX -e 'POSIX::setsid(); sleep 20' & echo started`、timeout 3s → **22.9s 才返回**；daemon 输出重定向走则 21ms。机理：`killForTimeout` 只杀进程组，`setsid` 的进程逃逸；`runToCompletion` 的 `Promise.all([pump(stdout), pump(stderr)])` 等管道 EOF，写端被 daemon 持有（`packages/core/src/tool/bash.ts` 约 1100–1155 行）
2. **sid-code 进程内存随上下文增长**：`filter-js-from-html` 上下文 2.3 万 → 19.5 万 token 时 RSS 到 1.8GiB；同批题容器峰值 p95 从 30586ff 的 1439MiB 涨到 27df03bf 的 1836MiB。属「更省」方向，需单独 profile
