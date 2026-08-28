# SWE-bench Verified 二值 smoke —— routeb-mini

> 数据隔离：本报告独立于 sid-code 自家评测（不写 baseline_scores、不进 grader registry）。
> **不含百分比字段**：n=10 时 SE=14.5pp、0.95 置信区间半宽 ±28pp，
> 六成与七成统计上无法区分，所以这里只报绝对数，且**不进 release 曲线**。
> （连这段说明里也不出现百分号：门禁是机械的 —— 报告里出现 `数字+%` 即判违规。
> 门禁做得这么钝是**故意的**，「在正文里现算一个 6/10 得六成」和加一个
> percent 字段是同一件事，而只拦字段名拦不住前者。)

- prompt 版本：`prompt-v1`
- 被测模型：`anthropic/claude-sonnet-5`
- 网关 host：`code.ppchat.vip`
- **被测产物**：commit 未记录（本机制上线之前的 run）—— 不知道这个分数是哪份代码跑的
- 宿主 HEAD：`未记录`（跑评测时宿主在哪个 commit，**不是产物身份**，仅供对照）
- 版本号：`未记录`（**仅供对照** —— `make build` 不 bump，同一版本号对应过几十个 commit）
- 产物指纹：`未记录`
- 必控变量：effort `未记录`，成本闸门 不限，并发 未记录
- link_ok（**单次**跑完即产出非空 patch；不合并复跑）：**FAIL**
  > ⚠️ FAIL 只说明**这一次**有实例零 patch，**不等于 agent 做不出来**。
  > 偶发故障（网关抖动、容器起不来）与能力不足在这个字段上长得一样，
  > 要分开必须复跑那几条并把结论写进正文 —— 见 ZZ.5 第 4 条。
- graded_ok（拿到 report 且无 ungraded）：**PASS**
- gold_ok（环境自检）：**PASS**
- solved_count：**8 / 10**（绝对数）
- patch_touches_tests：**0**
- wall_ms（harness 时钟，非 agent 自报）：0
- meter：`null` —— 无中立计价源；成本数字为 agent 自报，未交叉校验
- partial：false
- unaccounted：10 条未取回遥测、权限拒绝数为 **null（不知道）而非 0**：astropy__astropy-12907, astropy__astropy-8872, django__django-13964, django__django-15128, matplotlib__matplotlib-20488, matplotlib__matplotlib-26466, pydata__xarray-4075, pydata__xarray-6461, pytest-dev__pytest-10081, pytest-dev__pytest-7982 —— 这几条不能当作"没被权限层打残"来读 | 未记录产物 commit —— 事后无法确定这一轮跑的是哪份代码（版本号不够：`make build` 不 bump，同一版本号对应过多个 commit） | 未记录 effort_level —— 它直接决定推理预算与成本，是必控变量

## 六类结果分布

- solved: 8
- no_patch: 1
- wrong_patch: 1

## 逐条

| instance_id | outcome |
| --- | --- |
| astropy__astropy-12907 | solved |
| astropy__astropy-8872 | solved |
| django__django-13964 | solved |
| django__django-15128 | solved |
| matplotlib__matplotlib-20488 | no_patch |
| matplotlib__matplotlib-26466 | wrong_patch |
| pydata__xarray-4075 | solved |
| pydata__xarray-6461 | solved |
| pytest-dev__pytest-10081 | solved |
| pytest-dev__pytest-7982 | solved |

## 耗时画像（harness 时钟，非 agent 自报）

> ⚠️ 本轮缺三段分解（setup/agent/extract）—— 旧 run 或中途改过计时点。
> 只报 wall，**不用 wall 顶替 agent**：那会凭空造出一份「全是模型耗时」的分解。

逐题（按耗时降序，**先看最上面那条**）：

| instance | wall |
| --- | --- |
| `astropy__astropy-12907` | 0.0 min |
| `astropy__astropy-8872` | 0.0 min |
| `django__django-13964` | 0.0 min |
| `django__django-15128` | 0.0 min |
| `matplotlib__matplotlib-20488` | 0.0 min |
| `matplotlib__matplotlib-26466` | 0.0 min |
| `pydata__xarray-4075` | 0.0 min |
| `pydata__xarray-6461` | 0.0 min |
| `pytest-dev__pytest-10081` | 0.0 min |
| `pytest-dev__pytest-7982` | 0.0 min |
