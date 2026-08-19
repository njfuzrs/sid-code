---
Status: implemented
Date: 2026-08-19
---
# 建 Agent Note 作为决策留痕载体（P1-4 防方向漂移）

## 决定了什么

建 `.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-标题.md`，lifecycle 与 class 都是闭集
（`proposed`/`implemented`/`rejected` × `feature`/`architecture`/`bug-fix`/`simplification`/`process`/`testing`）。
格式固定三段：决定了什么 / 放弃了什么 / 拿什么证明它生效了。

配套：

- `scripts/verify-agent-note.ts` —— **只校验形态**，挂 pre-commit（触发条件：staged 含 `.agents/notes/**`）
- `tests/build/agent-note-gate.test.ts` —— 门禁自己的反漂移测试，含变异自证
- 规则一句话进 `CLAUDE.md` 与 `CONTRIBUTING.md`
- 一次性迁移 6 份否决记录进 `rejected/`（本 PR 内）

规则原文：**非平凡改动必须在同一个 PR 内加或更新一份 Agent Note。**
平凡 = 纯机械/局部编辑，不改行为、契约、结构、流程、理由。

## 放弃了什么（以及为什么不选）

**① 放弃"继续靠 CLAUDE.md + agent 记忆目录防漂移"。** 内容质量不是问题，**载体属性**是问题：
记忆目录只有一个 harness、一台机器读得到，不进 review、不随 PR 走；CLAUDE.md 所有人可读但不随改动走。
最贵的损失是否决记录 —— 一个方案被否决的完整论证只活在某个 agent 的记忆里，
下一个 agent 明天完全可能重新提议同一件事（本 PR 迁移的 6 份里，
"循环检测默认开启"就已经在 2026-07-06 与 07-14 之间被反复提过一轮）。

**② 放弃校验内容。** 不查字数、不查论证是否充分、不查证据是否真实。内容只有人能审 ——
校验器拦不住"把内部重构写成用户特性"或"漏掉真实的破坏性变更"。这与本仓 changelog curated
的哲学一致（必须人工过目才提交）。用正则审内容只会得到一个自己定义、自己达标的数字。

**③ 放弃"缺 Note 就阻断提交"这种硬门禁形态。** 判断"这次改动是否非平凡"需要语义理解，
机器做不到；硬拦的必然结果是 agent 学会写一份空洞的 Note 来过闸，或者一路 `--no-verify`。
所以门禁只在**已经有 Note 时**校验它的形态；"该写没写"这一层交人在 PR review 时看。
这是刻意的能力边界，写进了 README，不是漏做。

**④ 放弃一上来铺 1,369 份**（DSH 的规模）。先迁 6 份高价值否决记录 + 本 Note，让机制先跑起来。

**⑤ 放弃预建 18 个空 class 目录。** git 不追踪空目录，铺 18 个 `.gitkeep` 只是噪声；
class 目录按需创建，闭集由校验器守住。

## 拿什么证明它生效了

三条，全部是跑出来的：

1. **校验器对每一类违规都真的报红** —— `tests/build/agent-note-gate.test.ts` 里有 12 组变异夹具
   （错 lifecycle / 错 class / 缺 frontmatter / Status 与目录不一致 / Date 与文件名不一致 /
   假日期 2026-02-31 / 缺任一段 / 任一段为空 …），每组都断言 `checkNote` 返回非空违规。
   这是按 CLAUDE.md「新增门禁必做变异自证」做的 —— 一个恒绿的门禁比没有门禁更危险。
2. **正向样本全绿** —— 本 PR 的 7 份 Note 跑 `bun run verify:agent-note`：
   `verify-agent-note: 7 份 Agent Note 形态合规。`，exit 0。
3. **门禁真的接线了** —— 同一测试文件断言 `pre-commit.sh` 里存在 `.agents/notes` 触发段
   且调用了本脚本，`package.json` 有 `verify:agent-note` 入口。这一条治的是本仓反复出现的
   「建好未接线」病灶：脚本写好了、hook 没挂，于是门禁一次都不触发（`harness-defenses-built-but-zero-triggered`
   与「函数零调用」两条教训同源）。

⚠️ 有一条**尚未证明**的东西，说清楚免得下次被当成已验证：这个机制能不能真的减少方向漂移，
本 PR 拿不出数据 —— 它需要几个月后回头看「rejected/ 里的结论有没有被重新提议过」。
本次只证明了载体与门禁按设计工作。
