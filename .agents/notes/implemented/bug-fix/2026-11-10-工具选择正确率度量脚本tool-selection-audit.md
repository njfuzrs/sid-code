---
Status: implemented
Date: 2026-11-10
Source: monitor实测暴露的退出泄漏与审计口径缺陷-修复与验收方案（2026-11-09）
---

# 新增 tool-selection-audit 脚本：度量「场景该用 A 模型选了 B 没有」（FIX-6 D7）

## 决定了什么

新增 `scripts/tool-selection-audit.ts` + `tests/scripts/tool-selection-audit.test.ts`（纯新增，不碰产品代码）：从 `messages.json` 的用户消息识别等待类场景（event-stream / ci-single / delayed-reminder / log-watching 四行期望工具表），从 `session.traj` 的 action 序列归纳模型实际选择（monitor / bash 后台 / schedule_wakeup / 前台轮询 / 前台长 sleep），按期望表输出 `selection_accuracy` / `misuse_count` / `missed_opportunity`，支持 `--all` / `--since`（按会话开始时间切前后段）/ `--json` / `--samples`（抽样输出 prompt 供人工核对）。

口径要点（引用数字前先读）：

- 分母是**识别出的场景数**，不是会话数；一个会话可命中多场景（各算一个）。
- 调用次数 = session.traj 的 action 口径（方案 §0.1），禁用 events 行命中数 ÷ 3。
- **前台轮询的命令信号场景归 `ci-single`（期望 bash 后台），不归 event-stream（期望 monitor）**：前台轮询的最常见形态是「等 CI/PR 状态」，一次通知即可。首版误归 event-stream 导致 956 会话里 misused=201/211（accuracy 0.5%）——口径修正后 46.8%，这条修正已被单测「前台反复查同一 PR → 识别为 ci-single，不是 event-stream」锁住。
- 会话开始时间优先读 metadata.json 的 start_time，缺文件（进行中/异常结束的会话）回退解析会话 ID 前缀的时间戳——否则 startedAt=null 的会话会穿透 `--since` 过滤，污染前后段切分。

## 放弃了什么（以及为什么不选）

- **不做「每行期望工具表独立 JSON 配置」**：期望表就是指标定义本身，放脚本里（带注释、带单测结构断言锁住）比放配置文件少一层间接；改表 = 改指标，必须过变异自证与 review，配置化反而让「改一下」显得轻。
- **不给 wakeup 留在 ci-single 的可接受替代里**：方案期望表该行替代只有 monitor。实测证据 `20261107-094412-067218f8`：排了 schedule_wakeup 仍在等待期前台查 gh:pr:632 共 17 次——唤醒只解决「定时叫醒」，不解决「等待期别空转」，按替代计会把这类会话判成选对。
- **不在 judge 里给「只用一次 bash 后台」一律判误用**：event-stream 行的该误用形态加了 `taskOutputCount === 0` 的豁免——起了后台并持续 `task_output` 跟进（如 `20261014-110202-8c0ffb30` 13 次后台 + 12 次跟进）是在承担通知职责，只是没用 monitor，判 missed（错失优化）比判 misused（选错）准确。
- **prompt 匹配不要求互斥**：「每出现一行告诉我（日志）」同时命中 event-stream 与 log-watching 是设计行为（日志监控是事件流的特化，两者期望都是 monitor），判定结果不受重叠影响；单测用 `toContain` 锁这个语义。

## 拿什么证明它生效了

**基线（2026-11-10 16:2x 本机快照，958 个会话目录，956 有 session.traj）**：

```text
合计: 场景=205 matched=96 misused=109 missed=0
selection_accuracy=46.8% misuse_count=109 missed_opportunity=0
  ci-single: matched=95 misused=106 missed=0
  event-stream: matched=0 misused=2 missed=0
  delayed-reminder: matched=1 misused=0 missed=0
  log-watching: matched=0 misused=1 missed=0
```

按 PR #722（FIX-3，2026-11-10 06:59Z 合入）切分：前段 950 会话（场景 204，accuracy 47.1%），后段 7 会话（场景 1：`20261110-152006-77684ab7` misused，fg-poll "other"）——后段样本量 1，**不能**用来评判 FIX-3 效果；真正判据是上线两周后真实会话重跑（方案 FIX-3 条同款结论）。

抽样核对（D7 风险段要求，14/14 分类合理）：matched 抽 6（全部真实用了 run_in_background 且在轮询 CI）；misused 抽 8（全部纯前台轮询、零后台零 monitor）。

**变异自证（两轮）**：

- MUT-A（删 event-stream 行的 monitor 期望）：单测 2 红（判定矩阵 matched 断言 + 期望表结构断言）；全量指标不变——历史会话里 event-stream 场景 0 个 monitor 样本（与 D4 记录的「940 会话 monitor 自然调用 0 次」一致），这是**数据的性质不是判定失效**，故补 MUT-B。
- MUT-B（删 ci-single 行的 bashBg 期望）：单测 3 红；全量 matched 96→1、misused 109→204、accuracy 46.8%→0.5%——判定管道在真实数据上生效。
- 两轮变异恢复后：单测 31 pass / 0 fail，全量回到基线值。

**门禁**：`bun test ./tests/scripts/tool-selection-audit.test.ts` 31 pass / 0 fail；`affected-tests:run` 2095 pass / 2 fail（两条为 worktree 环境已知假失败：`tests/build/rules-paths-scope-nonempty.test.ts` 不 import 本改动、父仓 main 单跑 3 pass、成因是 worktree `.git` 指针文件使 ruleOwnerDir 解析到主仓根）；`make build` 自检通过；lint / format:check / lint:boundary / lint:command-system / lint:legacy-tool / typecheck:gate 全绿。

**已知限制**：场景识别是启发式，误判靠 `--samples` 抽样核对兜底（本次 14 个全对，不代表普适）；没有 messages.json 的老会话（237/958）只有命令信号一路；missed_opportunity=0 是因为「什么都没用」的会话若也无命令形态，场景识别本身就不命中（prompt 场景 + 零选择的会话仅 0 个出现在本快照，样本特性）。
