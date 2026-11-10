---
Status: implemented
Date: 2026-11-10
---
# monitor 缺陷的验收基建：verify-monitor 五 case + 三态判定

## 决定了什么

新增 `scripts/verify-monitor.ts`（`bun run verify:monitor`）与
`tests/scripts/verify-monitor.test.ts`，作为《20261109-monitor 实测暴露的退出泄漏与审计口径缺陷》
修复方案里 FIX-0 的交付物。**纯新增，不碰产品代码**：

- 五个 case：`D1b-signal`（TERM + HUP 两轮）、`D1b-sigkill`（启动扫描兜底）、
  `D2D3-audit`（`wait-audit` 的 `monitor_ev` 口径）、`D1b-orphan-scan-negative`（多会话不误杀）、
  `D4-discovery`（模型自然发现 monitor）。
- 三态判定：`PASS` / `FAIL` / `INVALID`。`INVALID` 单独一档的理由是「monitor 没挂上」时
  「子进程为空」天然成立——把它算成 PASS 就是恒绿门禁。
- 断言只从真实 `-p` 会话的 `events.jsonl` / `session.traj` / `ps` / `process.kill(pid,0)` 读，
  不读屏幕、不开 TUI。
- `--json` 供基线落盘与 CI（未来）消费；`package.json` 加 `verify:monitor` 别名。
- 单测覆盖七个纯函数：宿主过滤、终态扫描、`wait-audit` 输出解析、D4 判据、
  清理日志匹配、三态合成、CLI 参数。

## 放弃了什么（以及为什么不选）

- **不直调内部函数**（如直接调 `killMonitorTask` 或 `killAllRunningTasks`）。
  前一份方案 §一.3 记录过这个教训：`killMonitorTask` 代替 `task_stop`、纯逻辑替代进程退出，
  会同时得到「测试全绿 + 生产路径断开」。代价是每个 case 要起真实模型会话（耗时、花 token），
  换来的是断言真的落在 `/quit`、信号、真实 `raw.jsonl` 这些出问题的入口上。
- **`/quit` 分支不做 E2E**：`-p` 无头模式直接拒绝 `/quit`（`runHeadless` 的硬校验），
  本脚本无法覆盖。改为「单测锁 `case "quit"` 分支（FIX-1 交付）+ 信号路径 E2E」，
  两条路都有人管；本脚本只负责后者。
- **不进 CI 常驻门禁**：五个 case 都需要真实模型调用与 provider 配置，CI runner 上没有这些；
  硬塞进 CI 只会产出一条恒 INVALID 的假门禁。它按方案要求由执行者在本地/修复前后手动跑，
  `--json` 输出落盘对账。
- **D4-discovery 不用真实 CI 目标**：第 4 层实测用 PR #662 做目标，结果 PR 已合并、CI 全绿，
  测试无效。改用本地文件 + 后台写循环，不依赖 `gh` 网络与仓库状态，完全可控可重复。
- **写循环不用内联命令行**：D4 的后台写文件循环用独立脚本文件启动，命令行不含 token；
  否则 `monitorPids()` 会把它当成 monitor 子进程，污染「子进程为空」类断言。
- **反向用例的 PASS 不当作扫描正确的证据**：启动扫描实现之前 `D1b-orphan-scan-negative`
  恒 PASS（没有扫描 → 自然不误杀），脚本的汇总输出里显式打印这条提醒，防读者误读。

## 拿什么证明它生效了

### 1. 单测：39 条纯函数断言全绿

```bash
$ bun test tests/scripts/verify-monitor.test.ts
 39 pass
 0 fail
 50 expect() calls
Ran 39 tests across 1 file.
```

### 2. 变异自证（恒绿门禁等于没有门禁）

两次变异，都是「改坏把单测变红 → 恢复后变绿」：

**变异 1：回退宿主过滤正则的 `?`**（`sc` 会被当成 monitor 子进程）

```bash
$ bun test tests/scripts/verify-monitor.test.ts
 38 pass
 1 fail   ← 「排除四个宿主二进制名（sid-code / sid-code-dev / sc / sc-dev 的 -p 形态）」
```

恢复后回到 `39 pass / 0 fail`。

**变异 2：删掉 `scanMonitorEvents` 的 `WaitReleased` 判断**（终态只剩 completed）

```bash
$ bun test tests/scripts/verify-monitor.test.ts
 37 pass
 2 fail   ← 「完整一生：started + registered + completed + released」
           ← 「杀掉的终态带 status=killed（退出路径的期望值）」
```

恢复后回到 `39 pass / 0 fail`。

### 3. 真实基线（`--all --json`，修复前）

```bash
$ bun run scripts/verify-monitor.ts --all --json > /tmp/verify-before.json
```

| case | verdict | 关键断言（修复前） |
| --- | --- | --- |
| `D1b-signal` | **FAIL** | ✓ TERM/HUP 后 5s 内宿主退出；✗ 子进程残留（PPID=1，pid 37424 / 38561）；✗ events 只有 started+registered，无 completed/WaitReleased |
| `D1b-sigkill` | **FAIL** | ✓ SIGKILL 后子进程 40095 仍存活；✗ 第二次启动后仍残留 40095（无启动扫描）；✗ 启动日志无清理记录 |
| `D2D3-audit` | **FAIL** | `monitor_ev=0`（D2 的精确形态：真实格式 `<event untrusted="true">` 被 `<event>` 严格匹配漏掉）；violations=0 |
| `D1b-orphan-scan-negative` | PASS | ✓ B 已退出、A 的 monitor 仍存活、A 无终态事件（无扫描 → 天然不误杀，**此 PASS 无判据意义**） |
| `D4-discovery` | **PASS** | `called=true searched=true mentioned=true` —— 模型**自然调用**了 monitor（与文档 §一「大概率 FAIL」的预期不同，见下） |

**D4 的基线意外（必须交给 FIX-3）**：方案文档 §一 记录「940 会话 monitor 0 次调用」，
预期 `D4-discovery` FAIL。本次实测（2026-11-10，v0.1.614 dev 构建）**3 次全部 PASS（3/3）**，
且最硬的判据 `called=true`（events 里有 `PreToolUse{tool_name:"monitor"}`，不是只靠文本提及）：

```text
run 1: D4-discovery PASS (121.3s) — called=true searched=true mentioned=true
run 2: D4-discovery PASS (121.3s) — called=true searched=true mentioned=true
run 3: D4-discovery PASS (121.3s) — called=true searched=true mentioned=true
```

两个可能原因：① 本地文件场景（「盯一下 log，每出现一行就告诉我」）正是 monitor 的定义域，
而 2026-11-09 的 D4 实测用的是「盯 PR #662 的 CI」（那个 PR 早已合并，场景本身不成立）；
② 模型/配置与文档快照时不同。**结论：FIX-3 的「修复前基线」必须重新采，
不能沿用文档里的 0**——本脚本已交付，直接跑 3 次即可，实测 3/3 命中意味着
「修复后自然调用率提升」这条验收需要换一个更强/更复杂的场景，否则天花板已经打满。

### 4. 静态门禁


```bash
$ bun run lint                 # 0 warnings / 0 errors
$ bun run format:check         # All matched files use the correct format.
$ bun run typecheck:gate       # 无新增类型错误（62 处 / 基线 64）
$ bun run lint:boundary        # 越界依赖 0 处
$ bun run lint:command-system  # 四道门禁通过
$ bun run lint:legacy-tool     # 工具接口棘轮通过（58/58）
$ bun run scripts/smoke/expect-guard.ts   # 本次没有改动 G2 用例
$ bun run verify:agent-note    # 722 份 Agent Note 形态合规
```

