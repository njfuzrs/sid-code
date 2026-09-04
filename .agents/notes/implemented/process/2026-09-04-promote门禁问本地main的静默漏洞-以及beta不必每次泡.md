---
Status: implemented
Date: 2026-09-04
---
# G2 促升门禁问的是本地 main —— 一个 9 分钟宽的静默放行窗口;顺带把「每次发版都要泡 beta」这个误解写清楚

## 决定了什么

**① 修 G2 促升门禁的 ref 选择：`origin/main` 优先，本地 `main` 退化且自报。**

原判据 `probe.revParse("main") !== null ? "main" : "origin/main"` 先问本地 main。
但发布流程里 `release.sh` **自己**提交 `bump vX.Y.Z` 到本地 main，
那个提交要走 PR 才进远端 main（CLAUDE.md 发版第 4 步）。于是
「`--upload` 跑完、PR 未合并」这段窗口里，产物 commit
**在本地 main = YES、在 origin/main = NO** —— 门禁放行，输出还是一句 ✅。

新增 `pickMainRef()`(`scripts/lib/artifact-identity.ts`)承担这个选择并返回
`degraded` 标志;`scripts/artifact-identity.ts` 与 `scripts/release.sh` 的
**tag 退化判据**都改成问 `origin/main`;`--promote` 开头加一次
`git fetch origin main --tags`(失败只 warn —— 离线发版机是合法场景)。

**② 修 4 项仓库设置 + 补 ruleset(GitHub 侧,不在代码里)。**
迁新账号 `njfuzrs` 时漂了:`merge_commit_title`/`merge_commit_message`/
`allow_auto_merge`/`delete_branch_on_merge`,且 ruleset `protect-main`
**只剩 `deletion`+`non_fast_forward`——PR 要求与必需检查全丢**。

**③ 文档:把「beta 是否必须」写成按风险二选一,并如实标注判据未满足。**
CLAUDE.md 新增「先决定走哪条路」表(快车道 / 泡制道),点明
`--promote` 与 `--upload` 之间**没有任何时长门禁**;
补上第 5 步的删分支与第 7 步的端到端核验;修掉「4 平台」(实际 5)。
CONTRIBUTING.md 在合并一节加「换仓库/换账号必须重核这几项设置」的 checklist。

## 放弃了什么（以及为什么不选）

**给 beta 泡制加机械时长门禁（如「至少 24h 才能 promote」）。** 否决。
判据本身没有依据可依：泡多久取决于改动风险，而风险无法从 diff 机械推断。
更要紧的是**当前没人真的装 beta 在用**（下面有实测），加门禁只会得到
「等 24 小时然后什么都没验证」——把流程拖长却换不到任何保护，
而且必然催生一个 `--force-promote` 逃逸阀，那时门禁就彻底空了。

**把「每次发版必泡 beta」写成硬规则。** 否决，理由是收益不对称：
泡制道的价值依赖「有人真的装 beta 去用」这个**尚未发生**的前提，
而快车道的兜底（`rollback.sh` 纯指针秒级回滚）是已实测过的。
所以默认走快车道是当前诚实的选择，泡制道留给判断为高风险的那几次。

**顺手删掉 beta 通道机制。** 否决。它的结构性设计（共用版本目录、
`--upload` 绝不写 latest.txt、清理豁免指针版本）是对的，
问题只在「没人用」这一个社会性前提上 —— 撤掉机制解决不了那个前提，
而重建它要付一次完整的设计代价。

**把仓库设置核验做成 CI 门禁。** 否决。CI 跑在仓库内部，
而这些是仓库**自身**的配置：一个能改仓库设置的 token，权限远大于 CI 该有的权限。
用它换一道每年触发一次的检查不值 —— 这属于迁仓 checklist，靠文档记。

**批量修 21 个 curated 文件里对不上的旧 hash。** 否决（延续昨日那份 Note）。
它是 warn 非 error、`generate-changelog.ts` 不调 `checkCoverage`、
release.sh 对其失败也是 `|| warn` 不阻断。改 21 个文件换一个不影响任何产物的数字好看，不值。

## 拿什么证明它生效了

**漏洞是实测出来的，不是推断：**

```
$ git merge-base --is-ancestor 9b10703c main         # 产物 commit，本地 → 0（是祖先）
$ git merge-base --is-ancestor 9b10703c 27bcbefa     # PR 合并前的 origin/main → 非 0
时序：--upload 结束 16:39:23 ｜ PR #13 合并 16:48:20  ⇒ 窗口 9 分钟
```

**四条变异自证**（每条都单独跑过，改回去必红，改完还原后复验全绿）：

| 变异 | 结果 |
| --- | --- |
| `pickMainRef` 两个 if 调换顺序（= 恢复漏洞） | ❌ 「两个都在时选 origin/main」红 |
| `degraded` 恒设 false（= 弱判据冒充强判据） | ❌ 「只有本地 main 时退化」红 |
| release.sh 的 `_promote_main_ref` 初值改回 `"main"` | ❌ 「tag 退化判据问 origin/main」红 |
| 删掉 `git fetch origin main` 那一行 | ❌ 「promote 前先 fetch」红 |

⚠️ 第 4 条**第一次做假阴性**：perl 正则没匹配上，文件其实没被改，
测试当然全绿。改用 `grep -v` 真删掉才复现出红。
教训:**变异自证必须先确认变异真的落地了**（`grep -c` 数一下），
否则「改了也不红」会被读成「断言失效」，而事实是「根本没改」——
这与本仓反复强调的「说不出取数源的数字就是自我感觉」是同一类错误。

**测试**：`tests/eval/artifact-identity.test.ts` 48 pass / 0 fail；
`tests/release-channel.test.ts` 26 pass / 0 fail。

**仓库设置修完复核**（实际输出）：
`merge_commit_title=PR_TITLE`、`merge_commit_message=PR_BODY`、
`allow_auto_merge=true`、`delete_branch_on_merge=true`；
ruleset 现含 `deletion` / `non_fast_forward` / `pull_request` /
`required_status_checks`(`all-checks-passed`)。
必需检查名与 PR #13 上实际出现过的 check-run 名**逐字比对一致**
（`all-checks-passed`）—— 这一步不能省：名字写错的失效形态是
**PR 永久 pending、不报红只转圈**，CONTRIBUTING 记着已经踩过两次。

**「beta 从未被真实使用」是查证的，不是印象**：通道 2026-08-25 建立
（`52220a20`），此后只发过 v0.1.602（因账号封停+历史重写作废）与 v0.1.603，
两次都无 beta 使用记录。所以 A2 的验收判据
「至少一次真实回归在 beta 期被发现」**至今未满足**，已在 CLAUDE.md 里如实标注。

**发布链路耗时实测**（回答"流程是不是太慢"）：
`release.sh --upload` 5m25s（其中全量 `bun test` 183s ≈ 56%）、
PR CI 3m52s、`website-deploy.sh` 50s、`--promote` 5s。
即**人不等 beta 的话，一次完整发布约 10 分钟，其中 9 分钟是机器在跑**。
慢的不是通道机制，是全量测试与 CI ——
把 beta 泡制期算进"发布很慢"是归因错误。
