---
Status: proposed
Date: 2026-08-24
---
# SWE-bench 阶段 A：10 题只做二值 smoke，arm64 本地重建镜像不上云

## 决定了什么

SWE-bench Verified 阶段 A 的方案定死为三件事（**方案，尚未实施** —— 本 PR 只落决策与目录，
执行由后续 PR 承接）：

**① 产出口径是二值 smoke，不报百分比、不进 release 曲线。** 报告模板长这样：

```
link_ok             : 10/10 instance 产出非空 patch        ← 二值
graded_ok           : 10/10 拿到 report.json（无 ungraded） ← 二值
gold_ok             : PASS                                 ← 二值
solved_count        : n/10  ← 绝对数，不换算百分比
patch_touches_tests : n     ← 「禁改测试文件」那道硬检查的计数
```

**② arm64 用 `--namespace ''` 本地重建镜像，sb-cli / Modal 明确不用。**

**③ 执行顺序 preflight 最先、失败即停**，五项断言：运行期网络隔离 / 构建期与运行期出网策略分离 /
镜像内无上游 fix commit / 镜像可构建性+计时 / sid-code 的 flag **真的被接受**。

配套定死的两条契约（写进 `接入计划.md §4.3`）：prompt 只给 `problem_statement` 原文、
入库带版本号（`prompt-v1.txt`）、写死后不再改；「禁止改测试文件」是 prompt 层软约束，
**必须配 patch 提取后的机械检查**（含测试文件路径 → 标记 `patch_touches_tests` 单独列出，
不静默计入解出）。

落地物：`evals/_reports/external/` 目录 + README（三条隔离铁律 + 「污染不可逆」+ 口径）。

## 放弃了什么（以及为什么不选）

**放弃「10 题报 pass@1 百分比 / 当回归哨兵用」。** 二项标准误实算：n=10 在 p≈0.7 时
**SE=14.5pp、95% CI 半宽 ±28pp**，一道题的粒度就是 10pp。**60% 与 70% 在统计上无法区分**，
而「回归哨兵」的定义恰恰是「退步了要能报警」。这与判 HumanEval 时用的那把尺子
（164 题时 87% 与 90% 不可区分）是同一把 —— 得对自己也用。

**放弃「扩到 50 题」。** 在本地重建镜像的前提下代价是 ×5 的镜像构建时间与磁盘（每实例 GB 量级），
而 SE 只从 14.5pp 降到 6.5pp，**仍撑不起 10pp 退步检出**（需约 357 题）。
花 5 倍成本买一个仍然不可用的口径，是最差的一档。

**放弃（后移）`pass^k`。** 口径本身正确，但它属于对照实验阶段。在阶段 A 就上，会把
「打通链路」与「度量稳定性」两件事绑在一起 —— 阶段 A 的目的明确是前者。

**放弃 sb-cli / Modal（上云判分）。** 硬理由是与「数据主权」直接冲突：sb-cli 要把 predictions
（**含我们 agent 产出的完整 patch**）上传到第三方评测服务，Modal 要把二进制和轨迹送出去。
为绕开一个架构问题破掉一条北极星特性，代价不对等。加分理由：磁盘够（实测 602GB 可用 vs
官方 120GB，且那是全量 500 题口径，10 题只需 10 个镜像）。

**⚠️ 这条裁决的已知风险不隐藏**：arm64 构建耗时**官方无任何基准**，从源码构建 conda testbed
镜像可能是**小时量级**；老版本 Python 包可能**缺 arm64 wheel** → 回落源码编译 → 更慢或失败。
**兜底是借一台 x86_64 linux 机器本地跑，而不是上云** —— 仍守住数据主权。
所以「镜像可构建性计时」被排进 preflight 第 ④ 项：**在第 5 步才发现构建不出来，前四步就白做了。**

**放弃把 preflight 排在后面。** 原方案排第 5 步，意味着前 4 步的产出可能全部作废；
业界 harness 是把 `preflight()` 放在加载 subset **之前**且失败即退出。
不做这一步分数不可信 —— 实测有 25% rollout 试图 `git log` 找答案。

**放弃「构建期与运行期共用一份 allowlist」。** 本地重建镜像**必须能访问 PyPI / conda / GitHub**
才能装被测仓库依赖，这与防作弊要求的「只放 model API」直接矛盾。解法是两段分离：
构建期放开（agent 未启动，无作弊面）、运行期收紧（这才是要断言的）。
连带风险是构建期拉到的东西固化进镜像层，所以补一条「镜像内无 fix commit」的断言。

**放弃「扩 candidate_pool / 改 subset 规模」。** 10 题被定位为二值 smoke 后，
「要不要扩」这个问题自动消解；`verified-subset.yaml` 里那 5 条候选保留为
「某条 instance_id 校验不过时的替补」——那正是它当初的用途。

## 拿什么证明它生效了

**⚠️ 这是一份 `proposed` Note，方案本身尚未跑过。** 下面区分「已实测的前提」与「待验证的部分」，
不把机理当证据。

**已实测（本次）：**

① `evals/_reports/external/` 此前**确实不存在** —— 实测 `evals/_reports/` 下只有
`capability-plan-*` 与 `eval-latest.json`。而隔离铁律要求报告落这里：**目录不存在时，
第一次跑的人会写到 `_reports/` 根下和自家报告混住**，正是铁律要防的。本 PR 已建目录 + README。

② 顺带实测到一个方案没提的坑：两个现存脚本
（`evals/scripts/run-external-baseline.ts:27`、`self-vs-external-report.ts:27`）的落点是
**仓库根** `_reports/external`，不是 `evals/_reports/external`。跑一次 `--validate` 就会在
仓库根 `mkdir` 一个未被 git 追踪的 `_reports/`：

```
$ bun run evals/scripts/run-external-baseline.ts --track exec --validate
$ git check-ignore -v _reports/external   # → NOT ignored，显示为 untracked
```

根 `_reports/` 不在 `.gitignore` 的资产白名单里（资产目录是 `evals/_reports/`），
**报告写到那里等于产物丢失**。两个脚本当前都是骨架（`runExecTrack` 硬编码 `pass: 0`，
跑出来的数字没有意义），所以**本次不改它们的落点逻辑**，只在 README 的「已知漂移」表里登记，
由接实跑那个 PR 修。

**待验证（不能现在声称）：**

- ③ preflight 五项能否真的断言成功 —— 尤其第 ⑤ 项「flag 真的被接受」。
  它要拦的 bug（`--no-session-persistence` 报未知选项）的三种常规核验（grep 源码命中、
  `--help` 里列着、node 跑 parseArgs 通过）**全部误判它可用**，只有跑编译产物才暴露。
  **这正是为什么它必须是 preflight 断言而不是文档里一条注意事项。**
- ④ arm64 单实例镜像构建耗时 —— 官方无基准，preflight 第 ④ 项就是去测这个数。
- ⑤ `gold_ok` 能否 PASS —— 这一步是把「环境错」与「能力差」分开的唯一手段，
  gold 跑不过就是环境问题。

**验收时必须落的一条**：`ungraded` **不静默算失败**。
「`swebench eval` 没跑起来 / 没读回 `report.json` 却把结果当 0」会得到一个假 0% ——
和被否决的路径 A 那个「scorer 硬编码返 0」是**同一个陷阱换了位置，不是消失了**。
见 [[2026-08-24-swe-bench-接入路径a-inspect-否决]]。
