---
Status: implemented
Date: 2026-11-09
---
# wait-audit：等待窗口的轨迹回放判据，以及三项全量扫描

## 决定了什么

新增 `scripts/wait-audit.ts`（纯函数 `auditEvents` + `main` 只做 IO，风格对齐 `scripts/wakeup-audit.ts`），
把「等待窗口」这个分母写死成可机械复算的东西，输出 12 个字段：

- 窗口推断**三档**：新会话用 `WaitRegistered → 最后一个 WaitReleased`（真实事件）；
  老会话回退到「首个 `schedule_wakeup` 的**那一轮请求** → 最后一次状态查询 + 120s 宽限内的收尾」；
  `--window-start/--window-end` 可显式覆盖。输出里带 `window_basis`，读数字的人能看见分母怎么来的。
- 窗口起点必须**回填到产生首个 `schedule_wakeup` 的那一轮 `BilledRequest`**（比工具 action 早 10–20ms）。
  不这么做，7dd98bf5 会少 1 条请求 / 214,934 token，9e3a681d 少 1 条 / 259,546 token ——
  正好是方案 §2.3 与实测的差额。这是本次最容易被写错的一处。
- **两个查询字段并存**：`fg_status_polls`（命中 §5.5.2 命令表，P1 拦截的真实覆盖口径）
  与 `gh_queries`（命令含 `gh `，§2.3 基线口径）。两者不等价（实测 56/95 vs 96/106），
  混用会让「P1 覆盖了多少」与「模型查了多少」两个问题互相污染。
- 夹具进 `packages/core/tests/fixtures/wait-audit/`（两条基线会话），**裁剪 + 脱敏**：
  events 只留审计字段，traj 只留 `message_type/timestamp/tool_name/tool_input.command/is_error/tool_use_id`，
  observation 的正文只保留「退出码 N」。对话正文不进仓库（数据主权）。裁剪不改变任何被断言字段的取数。
- 三项全量扫描（§十四第 3 条）结果写回方案 §2.3.2：909 个会话里
  ① 有等待窗口的 6 个、其中 4 个窗口内 `gh` 查询 ≥ 20 次（66.7%，**不只这两条**，
  ff00575d 156 次 / 8,750 万 token 比两条基线都严重）；
  ② 「一轮内 todo 未完成数 >0→0→>0」出现在 2 个会话（非 0，§10.5 的收紧条件成立）；
  ③ 「排完唤醒后同一轮仍有工具调用」8/8 会话、16/16 次调用（100%）——现状里唤醒只是事后兜底。

## 放弃了什么（以及为什么不选）

- **不把 `LEGACY_CLOSE_GRACE_MS = 120_000` 说成普适常量**。它是从这两条基线会话标定出来的
  （7dd98bf5 的最后查询→收尾间隔 189s，中间在改文档；9e3a681d 是 40s，中间只有 todo_write）。
  写成「经验值」而不写来源，下一个人会拿它去判别的会话然后发现不适用。
  新会话一律走 `WaitRegistered/WaitReleased`，不经过这条启发式。
- **不改方案 §2.3 的「bash 失败 45」**。实测双源（traj observation 与 events `PostToolUse.is_error`）
  都是 44、全部退出码 8；第 45 条候选是 03:51:04 的 `gh pr merge`（退出码 1）在窗口起点前 26 秒。
  L2 明确要求「不许改方案的数字去迁就脚本」，所以文档保留 45、脚本输出 44、差异写进落地记录。
  反向也做过检查：把窗口起点前移到 03:51:04 能凑出 45，但那会把一条退出码 1 算成「退出码 8」。
- **不在 `--all` 里默认读 `raw.jsonl`**。它体积大（每会话 2–3MB），而 `monitor_events` 只有评估
  monitor 时才需要；用 `--with-raw` 显式开。
- **不给 `auditEvents` 加 p50/p95 查询间隔**。方案 §2.3 有这两个数，但 §9.5 的字段表没有；
  加进来会让「验收字段」与「归因字段」混在一个接口里，需要时另加。
- **不做「等待窗口自动聚合多段」**。一条会话里多次独立等待（中间用户插话）目前算一个窗口，
  因为 §9.5 的 `wait_windows` 定义就是「区间数」而 §2.3 的两条基线各只有一段。
  真出现多段时再拆，先不做没人验证过的抽象。

## 拿什么证明它生效了

**基线复现（L2 验收第 1 条）** —— `bun scripts/wait-audit.ts <id>`（不传任何窗口参数，走自动推断）：

```text
7dd98bf5: windows=1 basis=legacy-wakeup [03:51:30.887Z → 04:04:53.267Z]
          fg_polls=56 gh=96 polls/min=7.18 req=106 tok=26405804
          zombie=1 gate_retry=1 exit8=44 monitor_ev=0 violations=0(late_terminal=0)
9e3a681d: windows=1 basis=legacy-wakeup [03:42:06.188Z → 03:58:43.310Z]
          fg_polls=95 gh=106 polls/min=6.38 req=130 tok=40539922
          zombie=1 gate_retry=0 exit8=0 monitor_ev=0 violations=0(late_terminal=0)
```

对方案 §2.3：`gh` 96/106 ✓、请求 106/130 ✓、token 26,405,804/40,539,922 ✓、
僵尸唤醒 1/1 ✓、`todo_gate_retry` 1/0 ✓；唯一差异是 exit8 44 vs 45（见上）。
**两条会话的窗口都精确落回方案的人工窗口**，说明窗口推断不是靠手填时间凑出来的。

**单测 15 条**（`bun test ./tests/scripts/wait-audit.test.ts`，0 fail）覆盖：
老会话回退的起点回填与终点宽限、无窗口时 `wait_windows=0`（不进分母）、
WaitRegistry 窗口、显式窗口优先、两个查询口径、`late:true` 与 `late_while_terminal` 的正反向、
僵尸唤醒、`todo_gate_retry`、exit8、`monitor_events` 去重与窗口过滤、
以及两条夹具的端到端数字。

**变异自证两处**（改坏 → 确认对应断言变红 → 恢复 → 变绿）：
① `backfillRequestStart` 直接返回 action 时刻 → 起点回填用例 + 两条夹具回归共 3 条红；
② `LEGACY_CLOSE_GRACE_MS = 0` → 终点宽限用例 + 9e3a681d 夹具回归共 2 条红。

**全量扫描**：`bun scripts/wait-audit.ts --all --json` 扫 909 个会话输出 6 个有窗口的会话，
结果表写在方案 §2.3.2。
