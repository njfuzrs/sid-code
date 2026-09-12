---
Status: implemented
Date: 2026-09-12
---
# Harbor 的 token 归一化漏了「厂商族」这一维：A1 缓存命中率 48.0% 实为 92.2%

## 决定了什么

**`arm_health.normalized_tokens()` 的 sid 分支改为按 provider 族拆分，
并把三处「只写在 docstring 里靠调用方自觉」的纪律落进代码。**

原实现只按 arm（cc / sid）分支，对 sid 臂无条件按「`n_input_tokens` 是纯 fresh」拆：

    Anthropic  `input_tokens`  = 未命中余量（**不含** cache_read）
    OpenAI 族  `prompt_tokens` = 完整输入（**含** cached_tokens）

而 sid 臂在 A2 跑 sonnet（anthropic）、A1 跑 deepseek（openai）—— **同一条臂、两个族、
语义相反**。这不是推断出来的：pin 住的那个二进制里本来就有显式分族逻辑
（`git show 30586ff003c9:packages/core/src/llm/types.ts` 的 `normalizeCacheUsage()`：
anthropic 走 `uncached = input`、openai 族走 `uncached = input - hit - write`），
所以**成本那一侧一直是对的**，错的只有取数脚本。

四处改动：

1. **`normalized_tokens()` sid 分支按族拆**，族未知时 fail-closed 返回 None。
2. **新增 `observed_model_family()`** —— 两臂各自的观测源（sid 取容器 settings.json 的
   `availableModels[0].provider`；cc 的 `modelUsage[m].provider` 是 `firstParty` 这类
   内部标签、不是族名，退回按模型名判）。有了它，门控才能落在判据自己身上。
3. **`pricing_ratio()` 加族门控**：族不是 anthropic 就返回 None（判不出来）。
4. **`w3-summary.py` 的 `maxed` 改三态** + 归档新增 `maxed_turns_judgeable_denominator`。

## 放弃了什么（以及为什么不选）

**① 放弃「按模型分组看比值」—— 原 docstring 写的那个计划本身行不通。**
`pricing_ratio` 的 docstring 原话是「换模型臂单价不同，比值会整体偏移到**另一个常数**
⇒ 调用方要按模型分组看」。实测这句话有两处错：比值不是常数（A1 散在 0.006–0.034，
CV 0.39），因为偏离量取决于每题的 cache 占比、而两族单价结构的差异不是等比的。
所以不存在「另一个常数」可供分组比对 ⇒ 改成直接返回 None。

**② 放弃 `max(0, fresh)` 兜底。** openai 族算出负 fresh 时返回 None，与 cc 分支
那条既有纪律一致：clamp 成 0 会把「族判错了」抹成一个看起来正常的数。

**③ 放弃「族未知时默认按 anthropic 拆」。** 那个默认值在 A2 上恰好全对
（整臂都是 anthropic），只在换模型臂上错 —— 正是最难发现的形态。变异 M8 守着它。

**④ 放弃给「换模型臂 token 是否低报」造一个新判据。** 当前如实标 None（判不出来）。
用一个恒真的判据冒充它比没有判据更坏（CLAUDE.md「防线全在、调用全 0」的同型）：
A1 首版归档就是这么把 54/54 题全标成「token 低报」、还附一句
「⛔ 别拿这些题算缓存命中率」，等于把整臂缓存口径作废掉。

**⑤ 放弃让生成器迁就 formatter。** pre-commit 的 oxfmt 会折叠 `["openai"]` 这种短数组，
而 `w3-summary.py` 只写 `json.dump(indent=2)` 的展开形态。改生成器去迁就 oxfmt 的方向
不可行：`results/*.json` 是**唯一入库的评测产出**（`runs/` 整个在 .gitignore 里），
重跑一次要再花钱，它必须能被原样复现。⇒ 加进 `.oxfmtrc.json` 的 ignorePatterns，
与 changelog.json / evals/_reports 同类。

## 拿什么证明它生效了

**① 逐位复算（⛔ 不是「机理讲得通」）。** 按族修正后拿 token 反算实付，
A1 臂 **52/54 题逐位闭合**，相对误差中位 **1.11e-16**（浮点级）。
修前用同一份价表算，**54 题一题都不闭合**（比值散在 0.14–0.87，CV 0.42）。
残差那 2 题（`count-dataset-tokens` +7.7%、`fix-code-vulnerability` +3.7%）方向都是
**实付高于按累计 token 的预测** ⇒ 疑似有未进 token 累加的额外请求，不是口径问题
（口径错会让全部 54 题**同向**偏移，而不是 2 题）。

**② 数值后果可量。** A1：fresh 56,621,493 → 4,410,944（虚高 **12.8 倍**），
缓存命中率 48.0% → **92.2%**。⚠️ 而 A2 是 71.0% ⇒ 修前那两个数并列会读成
「换模型后缓存命中率从 71% 掉到 48%」，真相是**升到 92.2%**，方向反的。

**③ 回归判据：修复只作用于 openai 族。** 重生成 A2 归档，只有 source 标签变了
（`sid-metadata` → `sid-metadata:anthropic`），token 数值 / Wilson CI / 成本 /
失败构成 / undercount 那 3 题**逐字不变**。

**④ 变异自证 12/12 能红**（⛔ 不是「测试通过了」）：
- `test-arm-health.py` 44 断言 / 9 条变异全红。新增 **M7 复原本次修掉的真 bug**
  （sid 分支退回无条件纯 fresh）、M8（族未知时猜 anthropic）、M9（拿掉族门控）。
- `test-w3-summary.py` **新建**，13 断言 / 3 条变异全红。V1 精确复现下面那个形态。

**⑤ 一个当场踩到、值得单独记的形态。** 给「撞满轮数」补可判分母时，
`maxed` 是**二态布尔**（不可判折叠成 `False`），于是
`sum(1 for r in rows if r["maxed"] is not None)` **恒等于全部题数** ——
分母披露静默失效，输出「其余 **0** 题不可判」而真值是 **13** 题。
改成三态才修好。这是本仓那条「一个字段混了两个相反语义」的同型：
折叠掉的那一态，恰恰是引用时最需要知道的一态。变异 V1 守着它。

**⑥ 分母口径的实际后果（「分母比分子重要」）。** 两臂不可判题数差 4 倍（A1 13 / A2 3），
所以「A1 撞满 10 < A2 撞满 12」是假的：按各自可判分母是 **24.4%(10/41) vs 27.5%(14/51)**，
而在两侧都可判的 **39 题交集**上是 **A1 9 > A2 7 —— 方向反过来**。

## 服务哪个北极星方向

**更省**（主口径就是单位任务的 token 与成本；缓存命中率是它的核心归因项）
+ **可观测**（没有可信轨迹就画不出那条曲线）。

trade-off：**牺牲了一点「更快」换「更准」** —— `normalized_tokens()` 现在每题多读一次
容器 `settings.json`（有 `sid_settings()` 的既有开销），且族未知时**整题弃用**而不是
给个近似值。这是刻意的：一个偏 12.8 倍的数比没有数更坏。
