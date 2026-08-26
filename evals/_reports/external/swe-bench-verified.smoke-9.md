# SWE-bench Verified 二值 smoke —— smoke-9

> 数据隔离：本报告独立于 sid-code 自家评测（不写 baseline_scores、不进 grader registry）。
> **不含百分比字段**：n=10 时 SE=14.5pp、0.95 置信区间半宽 ±28pp，
> 六成与七成统计上无法区分，所以这里只报绝对数，且**不进 release 曲线**。
> （连这段说明里也不出现百分号：门禁是机械的 —— 报告里出现 `数字+%` 即判违规。
> 门禁做得这么钝是**故意的**，「在正文里现算一个 6/10 得六成」和加一个
> percent 字段是同一件事，而只拦字段名拦不住前者。)

- prompt 版本：`prompt-v1`
- 被测模型：`claude-sonnet-5-ppchat`
- 网关 host：`code.ppchat.vip`
- 被测代码：commit `454cf79c90c5b83655effdcd032cb3630364c9a6` ⚠️ **工作区脏，只可自比**（version `0.1.601` 仅供对照，同一版本号可对应多个 commit）
- 产物指纹：`b634e8f9149d4be54ecdc748fae6972a5b415362a20058b1237150988843a665`
- 必控变量：effort `max`，成本闸门 不限，并发 1
- link_ok（**单次**跑完即产出非空 patch；不合并复跑）：**FAIL**
  > ⚠️ FAIL 只说明**这一次**有实例零 patch，**不等于 agent 做不出来**。
  > 偶发故障（网关抖动、容器起不来）与能力不足在这个字段上长得一样，
  > 要分开必须复跑那几条并把结论写进正文 —— 见 ZZ.5 第 4 条。
- graded_ok（拿到 report 且无 ungraded）：**PASS**
- gold_ok（环境自检）：**PASS**
- solved_count：**8 / 10**（绝对数）
- patch_touches_tests：**0**
- wall_ms（harness 时钟，非 agent 自报）：5114441
- meter：`null` —— 无中立计价源；成本数字为 agent 自报，未交叉校验
- partial：false
- unaccounted：工作区不干净（git_dirty=true）—— 产物与 454cf79c 不完全对应，这一轮**只可自比，不可与其他 run 外比**

## 六类结果分布

- solved: 8
- no_patch: 1
- wrong_patch: 1

## 逐条

| instance_id | outcome |
| --- | --- |
| astropy__astropy-12907 | solved |
| astropy__astropy-8872 | solved |
| django__django-13964 | no_patch |
| django__django-15128 | solved |
| matplotlib__matplotlib-20488 | solved |
| matplotlib__matplotlib-26466 | wrong_patch |
| pydata__xarray-4075 | solved |
| pydata__xarray-6461 | solved |
| pytest-dev__pytest-10081 | solved |
| pytest-dev__pytest-7982 | solved |

## 耗时画像（harness 时钟，非 agent 自报）

- 合计 **85.2 min** = 搬运 0.1 + 模型 84.9 + 收尾 0.2（单位均为 min）
  > 搬运 = docker run + 解压 + cp 产物/题面；收尾 = 提取 patch + 取回轨迹。
  > 这两段与模型能力无关 —— **它们的量级大就说明该优化 harness 而不是调 prompt**。

- 串行代价：**5.3×** （串行 85.2 min vs 最慢单条 16.1 min）
  > 这是并发的**上界不是承诺** —— 实测受 docker daemon、网关限流、宿主 CPU 三处制约。
  > 报它是为了让「要不要开 SWE_JOBS」有个数可依，而不是凭感觉。

逐题（按耗时降序，**先看最上面那条**）：

| instance | wall | 搬运 | 模型 | 收尾 |
| --- | --- | --- | --- | --- |
| `django__django-13964` | **16.1 min** | 0.0 | 16.1 | 0.0 |
| `pydata__xarray-6461` | **13.6 min** | 0.0 | 13.5 | 0.0 |
| `django__django-15128` | **13.3 min** | 0.0 | 13.2 | 0.0 |
| `matplotlib__matplotlib-20488` | **11.0 min** | 0.0 | 11.0 | 0.0 |
| `matplotlib__matplotlib-26466` | **8.5 min** | 0.0 | 8.4 | 0.0 |
| `pytest-dev__pytest-10081` | **6.8 min** | 0.0 | 6.8 | 0.0 |
| `pydata__xarray-4075` | **6.2 min** | 0.0 | 6.2 | 0.0 |
| `pytest-dev__pytest-7982` | **4.7 min** | 0.0 | 4.7 | 0.0 |
| `astropy__astropy-12907` | **3.1 min** | 0.0 | 3.0 | 0.0 |
| `astropy__astropy-8872` | **2.0 min** | 0.0 | 2.0 | 0.0 |
