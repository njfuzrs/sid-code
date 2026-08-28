# SWE-bench Verified 二值 smoke —— routeb-sid80c

> 数据隔离：本报告独立于 sid-code 自家评测（不写 baseline_scores、不进 grader registry）。
> **不含百分比字段**：n=10 时 SE=14.5pp、0.95 置信区间半宽 ±28pp，
> 六成与七成统计上无法区分，所以这里只报绝对数，且**不进 release 曲线**。
> （连这段说明里也不出现百分号：门禁是机械的 —— 报告里出现 `数字+%` 即判违规。
> 门禁做得这么钝是**故意的**，「在正文里现算一个 6/10 得六成」和加一个
> percent 字段是同一件事，而只拦字段名拦不住前者。)

- prompt 版本：`prompt-v1`
- 被测模型：`claude-sonnet-5-ppchat`
- 网关 host：`code.ppchat.vip`
- **被测产物**：commit `abb8233e9cd89f8e37c40b13db6c03b635f2d57d`（分支 `main`，origin `local`） ← 产物自报，**事实源**
- 宿主 HEAD：`53ef0b01df08e483df216cc87e27f92193dd74af` ⚠️ 宿主工作区脏（跑评测时宿主在哪个 commit，**不是产物身份**，仅供对照） ⚠️ **与产物 commit 不一致**（在 PR 分支上验证改动时这是正常的）
- 版本号：`0.1.601`（**仅供对照** —— `make build` 不 bump，同一版本号对应过几十个 commit）
- 产物指纹：`c401748439fd041841bb79b36bfdc71d76402451ebf278d605367eb844d89a98`
- 必控变量：effort `max`，成本闸门 不限，并发 1
- link_ok（**单次**跑完即产出非空 patch；不合并复跑）：**PASS**
- graded_ok（拿到 report 且无 ungraded）：**PASS**
- gold_ok（环境自检）：**PASS**
- solved_count：**9 / 10**（绝对数）
- patch_touches_tests：**0**
- wall_ms（harness 时钟，非 agent 自报）：10308323
- meter：`null` —— 无中立计价源；成本数字为 agent 自报，未交叉校验
- partial：false
- unaccounted：无

## 六类结果分布

- solved: 9
- wrong_patch: 1

## 逐条

| instance_id | outcome |
| --- | --- |
| astropy__astropy-12907 | solved |
| astropy__astropy-8872 | solved |
| django__django-13964 | solved |
| django__django-15128 | solved |
| matplotlib__matplotlib-20488 | solved |
| matplotlib__matplotlib-26466 | wrong_patch |
| pydata__xarray-4075 | solved |
| pydata__xarray-6461 | solved |
| pytest-dev__pytest-10081 | solved |
| pytest-dev__pytest-7982 | solved |

## 耗时画像（harness 时钟，非 agent 自报）

- 合计 **171.8 min** = 搬运 0.1 + 模型 171.5 + 收尾 0.2（单位均为 min）
  > 搬运 = docker run + 解压 + cp 产物/题面；收尾 = 提取 patch + 取回轨迹。
  > 这两段与模型能力无关 —— **它们的量级大就说明该优化 harness 而不是调 prompt**。

- 串行代价：**1.9×** （串行 171.8 min vs 最慢单条 91.0 min）
  > 这是并发的**上界不是承诺** —— 实测受 docker daemon、网关限流、宿主 CPU 三处制约。
  > 报它是为了让「要不要开 SWE_JOBS」有个数可依，而不是凭感觉。

逐题（按耗时降序，**先看最上面那条**）：

| instance | wall | 搬运 | 模型 | 收尾 |
| --- | --- | --- | --- | --- |
| `django__django-15128` | **91.0 min** | 0.0 | 90.9 | 0.0 |
| `pytest-dev__pytest-10081` | **21.8 min** | 0.0 | 21.7 | 0.0 |
| `django__django-13964` | **17.1 min** | 0.0 | 17.0 | 0.0 |
| `matplotlib__matplotlib-20488` | **16.3 min** | 0.0 | 16.3 | 0.0 |
| `matplotlib__matplotlib-26466` | **5.3 min** | 0.0 | 5.3 | 0.0 |
| `pydata__xarray-4075` | **5.3 min** | 0.0 | 5.3 | 0.0 |
| `astropy__astropy-12907` | **5.3 min** | 0.0 | 5.2 | 0.0 |
| `pydata__xarray-6461` | **4.7 min** | 0.0 | 4.7 | 0.0 |
| `astropy__astropy-8872` | **3.6 min** | 0.0 | 3.6 | 0.0 |
| `pytest-dev__pytest-7982` | **1.5 min** | 0.0 | 1.4 | 0.0 |
