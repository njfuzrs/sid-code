---
Status: implemented
Date: 2026-11-15
Source: 记忆提取把 agent 行为固化成经验——根因与修复方案（2026-11-13）§8.5 / PR-5 / §8.4
---
# 记忆提取补三处落地缺口：written 口径、只读 git 权限、造数据验收

## 决定了什么

补齐 2026-11-13 那份方案里「PR-1~PR-5 已合、但编排与验收仍留缺口」的三件事，外加一项
方案明确要求却漏做的变异自证。四条都在同一条链路（提取代理 → 写盘闸门 → 观测）上，
一次 review 能读完，合成一个 PR。

### 1. `written` 口径：从「发起写入」改成「落盘成功」`(packages/core/src/memory/extract/extractor.ts)`

方案 §8.5 把 `MEMORY_EXTRACT.written` 的「连续 3 天 p50 = 0」定为 P0-2 的回滚判据，
并在同一节写死了前提：「`extractWrittenPaths` 统计的是发起的 `tool_use` 数，被拒的调用
同样计入 `written`，**先修口径再拿来当判据**」。这个前提一直没做 —— 5 个 PR 都没列它，
方案也没给它指定归属（§8.5 是 review 时追加的章节，加进去时没同步到 §7.0 的 PR 表）。

新增 `settledToolUseIds(messages)`：扫 `tool_result` 建「已确认落盘」的 id 集合
（`is_error === true` 排除，**没有配对 result 也排除** —— fork 触顶 `maxTurns` 或超时
中断时最后那条 `tool_use` 根本没执行），`extractWrittenPaths` 与 `hasMemoryWritesSince`
都改成只认这个集合。

后半句是复核时发现的同源缺陷：`hasMemoryWritesSince` 也只看 `tool_use`，于是主代理
**一次被拒**的 `save_memory` 会让 `extractor.ts:181-191` 以 `reason:"main_wrote"`
把整轮后台提取跳过。改一处必须改两处，否则另一半继续静默。

### 2. 只读 git 权限：只把 `git` 一个程序交给主会话的判定 `(packages/core/src/memory/extract/permissions.ts)`

P1-2 的核实段提示词向模型承诺「可以 grep / read 项目源码、跑 git 命令」，但
`READONLY_BASH_PREFIXES` 只有 9 个前缀、没有 `git`，而仓里另有一套完整的只读 git 判定
（`tool/bash/read-only-validation.ts` 的 `isReadOnlyCommand` + `permission/readonly-git-boundary.ts`）。
承诺与权限对不上，模型照提示词行动就是白烧一轮，而核实轮预算只有一轮。

`isReadonlyBash` 的白名单循环里，非白名单段若 `command === "git"`，委托
`isReadOnlyCommand([command, ...args].join(" "))` 判定。

### 3. §8.3 验收：缺样本就自己造数据 `(packages/core/tests/memory/extract/agent-action-e2e.test.ts)`

方案 §8.2 已证明 G2 回放做不出来（fork 请求不进 `raw.jsonl`，回放时 fork 拿不到响应，
「没写入」这个断言恒为真 = 假绿）。于是 §8.3 的三项只能靠真实模型手工跑 —— 但手工跑
不可重复、进不了 CI，日常也未必撞得上「归档带附件的文档」这个场景。

新增 4 条端到端用例：脚本化假模型（固定返回某几次 `save_memory`）驱动**真实**
`initExtractMemories` → 真实 `MemoryTool`（含全部闸门）→ 真实 `MemoryStore`，
断言污染场景不落盘、反向验收落盘且 `source` 被强制覆写成 `agent_action`、混合场景
「已保存」文案只列通过的那条、主代理路径不被误伤。

### 4. 补 T-M8b 的变异自证

方案 §8.4 要求 PR-1 覆盖「T-M8 / T-M8b / T-M8c + T-M3」，PR #830 正文只做了三项
（T-M8 / T-M8c / T-M3），缺的正是 T-M8b。做了「去掉 `_querySource === "memory-extract"`
限定」这一向变异并记录结果。

## 放弃了什么（以及为什么不选）

- **把 `"git"` 加进 `READONLY_BASH_PREFIXES`**：那是按前缀放行，`git commit` / `git push` /
  `git config --global` 会一起过。实测 `isReadOnlyCommand("git commit -m x")` 与
  `("git push")` 都是 deny，加白名单等于把写操作放进来。
- **整条命令都委托 `isReadOnlyCommand`**（彻底统一成一套）：它还认 `gh`（联网）、`jq`、
  `sort`，而提取代理本来连 `web_fetch` 都没有。整体委托会把能力面撑到比现状大得多，
  与「只对核实轮放开 git」的原意不符。所以只委托 `git` 一个程序。
- **改提示词删掉「跑 git 命令」**（最小改动）：核实轮确实能靠 grep + read 走完，但
  「这条记忆写下之后代码变没变」主要靠 `git log` / `git show`，删掉等于主动放弃一半核实能力，
  而放开只读 git 的成本只有上面那一段判定。
- **把 §8.3 写成「继续等真实使用积累样本」**：那等于把结论押在不确定会不会发生的事件上。
  用户 2026-11-15 明确要求「缺样本就自己造数据」。
- **把 `isReadonlyBash` 里 `>` / 命令替换的严格检查也换成主路径口径**：extract 代理是
  无人监督的后台 fork，这层「比主路径严」是刻意的（`>/dev/null` 也拒），保持不动。

## 拿什么证明它生效了

**单测（新增 / 更新，全部实跑）**

- `bun test ./packages/core/tests/memory/extract/agent-action-e2e.test.ts` → `4 pass / 0 fail`
- `bun test ./packages/core/tests/agent/forked-agent.test.ts` → 29 pass（含新增 4 条：
  被拒的 save_memory / 被拒的 write / 无配对 tool_result / 成功失败混合）
- `bun test ./packages/core/tests/memory/sc07-memory-p0-p1.test.ts` → 45 pass（新增
  `git log` / `git status` / `git diff` / `git show` / 管道 5 条 allow，以及
  `git commit` / `git push` / `git -C <异仓>` / `--git-dir` / `--work-tree` / `--output` / `gh` 7 条 deny）
- `bun test ./packages/core/tests/memory/extract-quantify-t1-t3.test.ts` → 24 pass
  （T2 节流夹具按新契约补上 `tool_result`）

**变异自证（看它报了什么，不只看退出码）**

把 `packages/core/src/tool/memory.ts` 的 `params._querySource === "memory-extract" &&`
整行删掉后跑 `memory.test.ts`：

```
(pass) T-M8：提取代理写无原话的 feedback → 拒绝，且给出改正指引
(fail) T-M8b：主代理手动写无原话的 feedback → 放行（闸门只管提取代理）
(fail) T-M8c：auto-dream 写无原话的 feedback → 放行
(fail) T-M8c2：auto-dream 带原话 → 放行
```

T-M8 仍绿、T-M8b/M8c/M8c2 全红 —— 正是这一向变异该有的形状。恢复后 20/20 全绿。

**真机（真实模型，3 个有效样本）**

自造夹具：`docs/plan.md` 正文引用 `docs/assets/diagram.png`，任务「归档到 archive/，
注意别弄坏图片引用」，`SID_CODE_MEMORY_EXTRACT_INTERVAL=1` 强制每轮提取，
独立 `SID_CONFIG_DIR` 隔离。3 次会话的遥测：

```
{'extract_outcome': 'ran', 'seq': 1, 'interval': 1, 'written': 0, 'output_tokens': 261}
{'extract_outcome': 'ran', 'seq': 1, 'interval': 1, 'written': 0, 'output_tokens': 319}
{'extract_outcome': 'ran', 'seq': 1, 'interval': 1, 'written': 0, 'output_tokens': 338}
```

三次提取都真跑了，`written=0`，`memory_guard` 零事件，`memory/` 目录零新增 ——
比「被闸门拒了」更强的结果：污染源没有产生。

⚠️ 真机这一半是**阴性证据**，不能替代「模型想写时闸门是否拦住」——后者由上面的
确定性 e2e 覆盖。两者合起来才是 §8.3 的完整判据。

**门禁**

- `bun run format` / `lint` / `format:check` / `typecheck:gate`（62/62 无新增）/
  `lint:boundary` / `lint:command-system` / `lint:legacy-tool` 全绿
- `bun run affected-tests:run` → `1375 pass / 1 fail`
- `make build` → 自检通过
- `bun run smoke` → `30 例：30 通过，0 失败`

那 1 个 fail 是 `isolated-subagent-cwd.test.ts` 的「未绑定 cwd 时不出现隔离提示」，
三条证据齐全：① 它不 import 本次改动的任何模块（测隔离子代理的系统提示词）；
② 父仓 main 上单跑 `12 pass / 0 fail`；③ 环境成因明确 —— 该用例以「默认 cwd 是否在
worktree 里」为判据，而本次改动是在 worktree 里跑的，`node_modules` 之外的路径全落在
`.sid-code/worktrees/memory-extract-gaps`，于是注入了「【隔离环境提示】」。CI 在 main
checkout 里跑不会有这个失败。

**没验证到的**：T-M8b 的变异只在本机跑过一次并记录在 PR 正文，没有做成自动门禁
（要做成门禁得让 CI 反向改源码再跑测试，成本远大于收益）。
