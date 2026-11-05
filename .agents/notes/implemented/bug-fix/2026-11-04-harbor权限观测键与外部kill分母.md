---
Status: implemented
Date: 2026-11-04
---
# harbor 的两个观测键拆开用，并把「被外部 kill」样本摘出能力分母

对应《评测接入 CI/CD》§6.6 泳道 B 的 **T08 / T09**（外部评测缺陷 1 / 3）。

## 决定了什么

**T08：`sid_permission_denials` 一个键拆成两个，语义各归其位。**

`evals/external-benchmarks/harbor/sid_code_agent.py` 原先在 `populate_context_post_run`
里把这个键写两次：

- 观测计数（`int`，审计日志里 `decision == "deny"` 的条数）——「换档生效」的判据；
- 清单（`list[dict] | None`，result 事件的 `permission_denials`）——「拒的是哪个工具」。

第二处写入在 `metadata.update()` 里、排在前面之后 ⇒ 正常路径上恒覆盖；而零拒绝时
result 事件里根本没有这个字段 ⇒ 覆盖值是 `None`。于是「审计日志真的采到了、真的是
0 拒绝」被下游一律读成「没采到」——一次成功的换档自证看起来像采集失败，且**不报错**。

改法：

1. 清单改写到新键 `sid_permission_denials_list`，`sid_permission_denials` 只承载观测计数。
2. 新增 `arm_health.sid_denials(metadata)` 作为这一格**唯一的取数处**，归一化三种形态：
   `counted_list`（新格式）/ `counted`（覆盖前老 run）/ `overwritten`（覆盖期产物：
   计数被清单占用，**计数不可判**）。⛔ 不许把 list 当计数，也不许把 `None` 当 0。
3. 三个下游消费者同步改：`w3-summary.py`（计数 + 清单 + 覆盖期 caveat）、
   `progress-permission-switch.py`（回落日志时标 `(日志,覆盖期)`）、
   `analyze-permission-switch.py`（一致性比对只比计数；覆盖期与「旧 run 无此键」分别披露）。

**T09：新增「被外部 kill」判据，从能力分母摘出并单独计数。**

`verifier_health.externally_killed(result)` = `sid_result_event_missing is True`
**且** `sid_subtype is None` **且** reward 非正分。判据按本仓落点写，⛔ 不照抄博客那条
（博客要求「成本来源缺失」，而本批 cost 从 traj 兜底拿得到，照抄会漏掉最该抓的样本）。

同步到全部判据消费者：`w3-classify.py`（`DROP_REASONS` 新增「被外部kill」，插在
`llm_fatal` 之前）、`compare-paired.py`（顺序逐字对齐）、`analyze-permission-switch.py`
（`excluded()` 新增一条）、`progress-permission-switch.py`（进度标签）、
`w3-summary.py`（单独计数 caveat：条数 + 占全部 trial 比例 + 两臂不可直接并列的警告）。

**门禁**（`.py` 的改动必须自带 TS 侧门禁，evals/CLAUDE.md §4.1）：

- T08：L1 checker 用 stdlib `ast` 提取 `populate_context_post_run` 里 metadata 的
  直接下标赋值键与 `metadata.update({...})` 键，断言**同一条执行路径上不重复赋值**
  （`assigned ∩ updated == ∅`）。带路径敏感：`if result is None: ... return` 那种
  必然返回的分支不算覆盖，`if decisions is not None:` 之后继续往下走的才算。
- T09：断言判据只在 `verifier_health.py` 定义一处；消费者读 `sid_result_event_missing`
  必须用共享判据；L1c 行为层覆盖「有 / 无 result 事件」两路 + 正分豁免 + 矛盾形态 fail-closed。
- 两处都做了变异自证（改回同名键 / 删清单键 / 改方法名 / 正分样本等）。

## 放弃了什么（以及为什么不选）

1. **不选「保留一个键、下游按类型分支」**：那正是当前形态。下游要同时判
   `isinstance(int)` / `isinstance(list)` / `None`，三态各自有不同语义，而任何一处漏判
   都是静默的。拆键把语义写进键名，让错误变成不可能，而不是靠每个消费者各自小心。
2. **不选「删掉清单（只留计数）」**：清单回答的是「拒的是哪个工具、哪条命令」，
   `analyze-permission-switch` 与人工复盘都要用它。丢它换简单是拿信息换省事。
3. **不选「把外部 kill 并进『上游打断』」**：两者成因与修法都不同 —— 上游打断是重试链
   耗尽（治网络/重试），外部 kill 是进程被墙钟/硬顶杀掉（治超时层与轮数预算）。
   合并后**无法归因**，而缺陷 3 的价值恰恰是让这两类在数据上可分。
4. **不选「照抄博客判据（成本来源缺失）」**：本仓 cost 由宿主侧从
   `session.traj` 兜底解析，被 kill 也能拿到 ⇒ 博客判据在本批**恒不触发**，
   会漏掉 T0010/T0051/T0059 这三条最该抓的样本。
5. **不选「额外要求 `exception_type`」**：实测有三种终止者
   （`AgentTimeoutError` / `CancelledError` / `NonZeroAgentExitCodeError`），
   逐族枚举会漏 —— 与 `llm_fatal` 的片段表同一个坑：换个终止者就换一种措辞。
6. **不选「不豁免正分样本」**：ds41 臂有 2 条 `reward=1.0` 但同样被外部 kill 的样本
   （`configure-git-webserver` / `large-scale-text-editing`）。把它们摘出分母会**抬高**
   通过率，是朝对我们有利方向的失真 —— 与 `llm_fatal._positive_reward` 同一条纪律。

## 拿什么证明它生效了

**变异自证（门禁必须能翻红）：**

- `bun test tests/eval/harbor-agent-contract.test.ts` → **50 pass / 0 fail**（262 expect）。
  其中新增的变异用例：把 `sid_permission_denials_list` 改回 `sid_permission_denials`
  ⇒ `overlap == ["sid_permission_denials"]`；删掉清单键 ⇒ `updated` 里缺它；
  回填方法改名 ⇒ `metadata_keys` 为 `null`（门禁静默失效会被发现）。
- `python3 test-w3-classify.py` → **51 pass / 0 fail**（新增 ⑩ 组 8 条）：
  「事件缺失 + subtype 缺失 + 0 分」判 kill；`cost_source=missing` 同样判；
  **正分 kill 样本保留计分**；有 result 事件不判；矛盾形态 fail-closed 不判；
  两个真 kill 进 drop、keep=3。

**真实 run 复算（数据在主仓 `runs/`，worktree 里用绝对路径引）：**

- T09：`python3 w3-classify.py runs/w3-sid-sonnet-66`
  → 9 题非能力失败，其中 **3 条「被外部kill」**（`gpt2-codegolf` /
  `install-windows-3.11` / `model-extraction-relu-logits`），与缺陷文档逐题一致。
  `runs/w3-sid-ds41-54` → **11 条「被外部kill」+ 3 条「上游打断」**；
  两条 `reward=1.0` 的 kill 样本（`large-scale-text-editing` 等）按正分豁免留在计分侧 ——
  与文档「13 条 result 事件缺失、其中 2 条正分」的数字对得上。
- T08：`python3 analyze-permission-switch.py runs/w3-sid-sonnet-66`
  → `metadata deny 与实数比对 54/54 题；不一致 0 处`（**不再走「旧 run 预期如此」分支**），
  并如实披露 `54 题只有计数、无清单键(覆盖前老 run)`。
- T09 汇总层：`python3 w3-summary.py runs/w3-sid-ds41-54`
  → `排除构成 {'被外部kill': 11, '上游打断': 3}`，且 caveat 打印
  `🔴 被外部 kill 11/54 题 [...]`（单独计数，带占比与「两臂不可直接并列」警告）。

**构建与门禁：**

- `make build` ✅（产物自检六项全过；worktree 先按 CLAUDE.md 处置删 `node_modules`
  软链并 `bun install`，否则 `@sid-code/tui` 解析失败）。
- `bun run lint` ✅ / `bun run format:check` ✅ / `bun run typecheck:gate` ✅。
- `bun run affected-tests:run` → 1684 pass / 1 skip / **2 fail**，两条都是
  `tests/build/rules-paths-scope-nonempty.test.ts`。已按「判定与我无关必须举证」核过：
  ① 该测试不 import 本次改动（只读 CLAUDE.md frontmatter + `git ls-files` + `rules.ts`）；
  ② 父仓 main 单跑 `bun test tests/build/rules-paths-scope-nonempty.test.ts` = **3 pass / 0 fail**；
  ③ 环境成因已定位：worktree 路径 `<repo>/.sid-code/worktrees/<name>` 本身含 `.sid-code` 段，
  `ruleOwnerDir()` 把 `.sid-code` 当规则归属边界，于是 owner 被解析成主仓
  （实测输出 `ownerAbs=/Users/zhourusheng/Code/person/sid-code`），候选文件集为空。
  这是 worktree 目录约定的结构性冲突，与本次改动无关，留给后续单独处理。
