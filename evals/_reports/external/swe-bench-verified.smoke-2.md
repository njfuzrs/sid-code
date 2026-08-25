# SWE-bench Verified 二值 smoke —— smoke-2

> 数据隔离：本报告独立于 sid-code 自家评测（不写 baseline_scores、不进 grader registry）。
> **不含百分比字段**：n=10 时 SE=14.5pp、0.95 置信区间半宽 ±28pp，
> 六成与七成统计上无法区分，所以这里只报绝对数，且**不进 release 曲线**。
> （连这段说明里也不出现百分号：门禁是机械的 —— 报告里出现 `数字+%` 即判违规。
> 门禁做得这么钝是**故意的**，「在正文里现算一个 6/10 得六成」和加一个
> percent 字段是同一件事，而只拦字段名拦不住前者。)

- prompt 版本：`prompt-v1`
- 被测模型：`claude-sonnet-5-ppchat`
- 网关 host：`code.ppchat.vip`
- link_ok（产出非空 patch）：**FAIL**
- graded_ok（拿到 report 且无 ungraded）：**PASS**
- gold_ok（环境自检）：**PASS**
- solved_count：**6 / 10**（绝对数）
- patch_touches_tests：**0**
- wall_ms（harness 时钟，非 agent 自报）：10449795
- meter：`null` —— 无中立计价源；成本数字为 agent 自报，未交叉校验
- partial：false
- unaccounted：无

## 六类结果分布

- solved: 6
- no_patch: 2
- grader_error: 2

## 逐条

| instance_id | outcome |
| --- | --- |
| astropy__astropy-12907 | solved |
| astropy__astropy-8872 | solved |
| django__django-13964 | no_patch |
| django__django-15128 | grader_error |
| matplotlib__matplotlib-20488 | grader_error |
| matplotlib__matplotlib-26466 | no_patch |
| pydata__xarray-4075 | solved |
| pydata__xarray-6461 | solved |
| pytest-dev__pytest-10081 | solved |
| pytest-dev__pytest-7982 | solved |
