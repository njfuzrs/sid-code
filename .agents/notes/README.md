# Agent Note —— 决策留痕即审查界面

这个目录是 sid-code 的**决策事实源**。一份 Note 回答三个问题：决定了什么、放弃了什么、拿什么证明它生效了。

## 为什么需要它（不是"为了规范"）

并行开发的真正瓶颈不是产出速度，是**人还能不能保持方向控制权**。多个 agent 同时改代码时，
没人 review 得完每天几百个文件的 diff，但完全 review 得完几份「决定了什么 / 放弃了什么 / 怎么证明生效」。

在此之前，决策记录散在三个地方，每个都有结构性缺陷：

| 载体 | 谁能读 | 能进 review | 随 PR 走 |
| --- | --- | --- | --- |
| Claude 的记忆目录 | 只有那一个 harness、那一台机器 | ✗ | ✗ |
| `CLAUDE.md` | 所有 agent + 人 | ✗（不随改动走） | ✗ |
| commit message | 所有人 | ✓ | squash 后只剩一行 |
| **Agent Note** | **所有 agent + 人** | **✓** | **✓ 同一个 PR** |

最贵的损失在 `rejected/`：一个方案被否决的完整论证如果只活在某个 agent 的记忆里，
下一个 agent 明天完全可能重新提议同一件事，而你要把整套论证重做一遍。

## 目录形态

```
.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-标题.md
```

- **lifecycle**（闭集）：`proposed` → `implemented`，或 `rejected`
- **class**（闭集）：`feature` / `architecture` / `bug-fix` / `simplification` / `process` / `testing`

两个都是**闭集**，非法目录会被 `scripts/verify-agent-note.ts` 拒绝。理由是自由文本会让同一类
决策散成 `perf/` `performance/` `optimization/` 三个目录，之后既没法统计也没法检索。

`proposed/` 的 Note 落地后**移动**到 `implemented/`（同时改 frontmatter 的 `Status`，两者必须一致）；
被否决则移到 `rejected/`。移动而非复制 —— 一份决策只应有一个当前位置。

## 格式（模板见 `_template.md`）

```markdown
---
Status: implemented
Date: 2026-08-19
---
# <标题>

## 决定了什么

## 放弃了什么（以及为什么不选）

## 拿什么证明它生效了
```

第三段是这份格式里最重要的一段，对应 `CLAUDE.md` 收尾自检第 2 问：写**跑了什么命令、看到什么输出**，
不写"机理上讲得通"。教训是实测过的 —— 目标指标改善 + 测试全绿 + 机理讲得通，三者同时成立时结论仍可能是错的。

## 什么时候必须写

> **非平凡改动必须在同一个 PR 内加或更新一份 Agent Note。**
> 平凡 = 纯机械 / 局部编辑，不改行为、契约、结构、流程、理由。

判断卡不住时问一句：**半年后有人问"当时为什么这么定"，答案在哪？** 答案只在你脑子里或某个
agent 的记忆里 → 需要一份 Note。答案在代码里一目了然（改个拼写、提取一个变量）→ 不需要。

## 门禁只查形态

`scripts/verify-agent-note.ts` 挂在 pre-commit（触发条件：staged 里有 `.agents/notes/**`），查的是：

- 路径形态、lifecycle / class 在闭集内、文件名日期真实存在
- frontmatter 有 `Status` 与 `Date`，**`Status` 与所在 lifecycle 目录一致**，`Date` 与文件名日期一致
- 一级标题存在；三个二级标题都存在**且各段非空**

**刻意不查内容**：字数、论证是否充分、证据是否真实，全都不查。内容只有人能审 ——
校验器拦不住"把内部重构写成用户特性"，也拦不住"漏掉真实的破坏性变更"。这与本仓
changelog curated 的哲学一致（必须人工过目才提交）。

手动跑：

```bash
bun run verify:agent-note
```
