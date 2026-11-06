#!/usr/bin/env python3
r"""L2 判定器：把一次评测 run 判成方案 §5.2 的四种结论之一。

用法:
    python3 eval-verdict.py --baseline baselines/v0.2.1.json --current runs/l2-v0.1.600
    python3 eval-verdict.py --baseline b.json --current run1 --current run2   # 补跑合并
    python3 eval-verdict.py ... --block "预算账本拒绝：本月已花 $149 + 上限 $40 > $150"
    python3 eval-verdict.py ... --out ~/.sid-code/eval-gate/v0.1.600.verdict.json --json

## 四种结论（闭集，写死在 `VERDICTS`）

| 结论 | 条件 | 动作 |
| --- | --- | --- |
| `INVALID` | 指纹非 VALID（被测的二进制 sha / commit 除外）/ 任一题没跑 / infra 故障率 > 10% / 外部阻断 / 基线不自洽 | 不出结论，不放行 |
| `REGRESSION` | 稳定必过子集 S′ 中失败题数 ≥ m′（\|S′\|<6 时改用通过率 < 50% 兜底） | 阻断 promote |
| `WARN` | S′ 有失败但 < m′ / 全集配对净回退 > 0 / 缓存下降 >10pp / 成本上涨 >30% | 放行，人工复核 |
| `PASS` | 以上都不满足 | 放行 |

## 为什么 S 不是「基线里跑过的题」，而是「k 次全过的题」

全集配对比较的翻转主要是噪声：基线里「有时过有时不过」的题，它们的翻转率就是
噪声底线本身。把这些题放进阻断判据，阈值只能抬到 ~19 pp 才不误拦（§3.3），
等于没有闸门。S 里的题基线上从不失手，一次退化会让好几题同时掉，**信噪比高得多**。
这与 gemini-cli 只让 `ALWAYS_PASSES` 进 PR 门禁是同一个思路。

## 为什么 m 用**精确二项尾概率**而不是浮点近似

`|S|=10、ε=0.15` 恰好落在边界上：P(X≥4)=0.04997，离 α=0.05 只有 3e-5。
浮点实现的成败取决于累加顺序 —— 同一个基线在两台机器上可能算出不同的 m，
而 m 差 1 就是「阻断」与「放行」的差别。所以尾概率一律用 `Fraction` 精确算，
`test-eval-verdict.py` 里与 T13 冻结的 15 格 m 表逐格对账。

## 指纹比对复用 T11 的实现，不另立版本号

`run_fingerprint.compare()` 的三态（VALID / INVALID / INCOMPLETE）直接用：
`INCOMPLETE` 在这里**也判 INVALID** —— 它的语义是「无法证明一致」，
而「无法证明一致」不等于「一致」，更不等于通过（T11 文件头写死了这条）。
`verdict_rule_version` 复用 `run_fingerprint.VERDICT_RULE_VERSION`：
同一批产物用两套判据能得出相反结论，那时差异不是配置造成的。

## 降级规则（§7.1 D3，预先登记）

`|S′| < 6` 时 `REGRESSION` 这一行停用，L2 进入「只看趋势」模式；
但 promote 仍要求一次非 INVALID 的有效运行，且 S′ 的通过率 ≥ 50%（防「整个跑崩了」）。
本文件把这条兜底做成**同样的阻断结论**（`REGRESSION` + `degraded=true`），
因为下游只认「阻断 / 放行」；把兜底包装成一个新的第五种结论会让 `release.sh`
多一个必须记得处理的分支，而那正是本仓「防线在、调用点漏」的同型。

## 基线文档格式（`--baseline`）

```json
{
  "schema_version": 1,
  "fingerprint": { ... run_fingerprint.py collect 的完整 doc ... },
  "per_task": {"T0001": [1.0, 1.0, 1.0], "T0002": [0.0, 1.0, 0.0]},
  "infra_fault": {"T0009": "MAX_ARG_STRLEN"},
  "noise": {"flip_rate": 0.19, "stable_set": ["T0001"], "epsilon": 0.10, "m": 3},
  "cost": {"per_run_usd": 26.21},
  "cache": {"hit_rate_by_family": {"anthropic": 0.82}}
}
```

- `per_task` 的值是**逐次 reward**（k 次），不是均值。S 由「k 次全为 1.0」复算，
  ⛔ 不读 `noise.stable_set` 当唯一来源 —— 声明值与复算不一致时判 INVALID
  （基线被手改的形态是「声明的 S 比实际小」，那会把阻断阈值悄悄放宽）。
- `noise.epsilon` 缺省时按 §5.2 的下限 0.10 取，并在报告的 `caveats` 里留痕。
- `noise.m` 缺省时由 `min_m(|S′|, ε)` 现算；给了也只用于**对账**：
  `|S′| == |S|` 时必须与现算值一致，否则判 INVALID（基线不自洽）。
- `cost.per_run_usd` 是**单轮**成本。基线是 k=3 时若只给了 `total_usd`，
  本文件按 `total_usd / k` 折算并留 caveat —— 拿三轮合计与一轮比会把
  「k 从 3 降到 1」判成成本上涨 200%，而那不是回归。

## ⛔ 本文件不做的事

- **不判「为什么没解出来」**：归因在 `w3-classify.py` / `zero-diag`。
- **不重算排除判据**：逐题结局只从 `trial_outcomes.py` 取（唯一取数处）。
- **不读预算账本**：账本是 TS 侧 `scripts/eval/lib/eval-budget.ts` 的事。
  T20 的入口脚本判完预算后，把「拒绝开跑」作为 `--block` 传进来 ——
  跨语言重复实现一份账本解析，迟早分叉成两套口径。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from fractions import Fraction
from math import comb
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import run_fingerprint  # noqa: E402
import trial_outcomes as O  # noqa: E402

#: 判定规则版本。**复用 T11 的常量，不另立**（见文件头）。
VERDICT_RULE_VERSION = run_fingerprint.VERDICT_RULE_VERSION

#: 结论闭集。改这个元组等于改契约 —— `release.sh` 按它分支。
VERDICTS = ("PASS", "WARN", "REGRESSION", "INVALID")

#: 基线文档格式版本。**改既有字段语义必须 +1**。
BASELINE_SCHEMA_VERSION = 1

# ───────────────────────────────────────────── §5.2 的阈值（写死，执行前不得临场改）

#: infra 故障题占比超过它 → INVALID（不出结论，先修环境）。
#: 分母是**基线题集大小**，不是「跑出来的题数」——后者会随着故障越多而变小，
#: 让故障率永远看起来不高。
INFRA_FAULT_MAX_RATIO = 0.10

#: 缓存命中率较基线下降超过这么多**百分点** → WARN。
CACHE_DROP_PP = 10.0

#: 总成本较基线上涨超过这个比例 → WARN。
COST_RISE_RATIO = 0.30

#: |S′| 低于它 → 降级为「只看趋势」，REGRESSION 停用（§7.1 D3）。
MIN_STABLE_FOR_BLOCKING = 6

#: 降级模式下的兜底：S′ 通过率低于它 → 仍要拦截（防「整个跑崩了」）。
DEGRADED_MIN_PASS_RATE = 0.50

#: ε 的下限。§5.2：`ε = max(样本外实测值, 0.10)`。基线没给 ε 时按这个下限取。
EPSILON_FLOOR = Fraction(1, 10)

#: 显著性水平 α（双侧 5% 的单侧用法：零假设误拦率 ≤ 5%）。
ALPHA = Fraction(1, 20)

#: 被测变量：L2 比的就是「新二进制 vs 基线」，这两项不同是前提，不是配置漂移。
#: 只豁免「值不同」，两边仍必须采到（`run_fingerprint.compare` 的 `under_test`）。
#: ⛔ 别往里加别的字段 —— 模型、题集、预算任一变了，结果就不能比。
UNDER_TEST_FIELDS = ("sid_binary_sha256", "sid_commit")

#: 退出码：放行 0 / 阻断 2 / 无效 3（与 `run_fingerprint.py` 的 EXIT 风格一致）。
EXIT = {"PASS": 0, "WARN": 0, "REGRESSION": 2, "INVALID": 3}


# ───────────────────────────────────────────────── 精确二项：m 表与 McNemar


def binomial_tail(n: int, k: int, p: Fraction) -> Fraction:
    """`P(X ≥ k)`，X ~ Binomial(n, p)。**精确有理数**，不用浮点。

    k ≤ 0 返回 1；k > n 返回 0（不抛异常：调用方会拿它做「最小 m」搜索）。
    """
    if k <= 0:
        return Fraction(1)
    if k > n:
        return Fraction(0)
    q = 1 - p
    total = Fraction(0)
    for i in range(k, n + 1):
        total += comb(n, i) * (p**i) * (q ** (n - i))
    return total


def min_m(stable_size: int, epsilon: Fraction | float | str, alpha: Fraction = ALPHA) -> int | None:
    """§5.2 的阻断阈值 m：使 `P(X ≥ m | n=|S|, p=ε) ≤ α` 的**最小** m。

    `None` = 即使 S 全部失败也不显著（|S| 太小或 ε 太大）⇒ 这个 |S| 下
    没有可用的阻断阈值。调用方必须把 None 与一个具体数字分开处理，
    ⛔ 不能折叠成 0：「没有阈值」与「阈值为 0」的处置完全相反。

    ⚠️ ε 用 `Fraction(str(x))` 转换，不是 `Fraction(x)`：后者对 0.15 会取
    浮点二进制展开的精确值（0.1499999…），在 |S|=10 那条边界上算出
    P(X≥4)=0.050000000000000003 而不是 0.04997，m 直接翻一档。
    """
    if stable_size <= 0:
        return None
    eps = epsilon if isinstance(epsilon, Fraction) else Fraction(str(epsilon))
    for m in range(1, stable_size + 1):
        if binomial_tail(stable_size, m, eps) <= alpha:
            return m
    return None


def mcnemar_one_sided_p(up: int, down: int) -> Fraction:
    """McNemar 精确单侧 p：`P(X ≥ down | n=up+down, p=1/2)`。

    只问「回退是否显著多于进步」。`up+down == 0` 返回 1（没有任何翻转，
    谈不上回退）。
    """
    n = up + down
    if n == 0:
        return Fraction(1)
    return binomial_tail(n, down, Fraction(1, 2))


# ───────────────────────────────────────────────── 基线校验


def _is_binary_reward(value: object) -> bool:
    """traj-bench 的 reward 是 0/1。`bool` 不算：JSON 里 true 不是 1.0。"""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and float(value) in (0.0, 1.0)


def stable_set(per_task: dict[str, list[float]]) -> list[str]:
    """S = 基线 k 次**全部** 1.0 的题。按题名排序（输出稳定，便于比对）。"""
    return sorted(t for t, rewards in per_task.items() if rewards and all(r == 1.0 for r in rewards))


def validate_baseline(doc: object) -> list[str]:
    """基线自洽性检查。返回问题清单；**非空即 INVALID**（不出结论）。

    这里只查「基线本身能不能当尺子」，不查它好不好：
    - reward 非二值 ⇒ S 与 m 的前提不成立；
    - 同一题既在 `per_task` 又在 `infra_fault` ⇒ 两个相反的处置；
    - 声明的 S 与按 per_task 复算的不一致 ⇒ 基线被手改过，或者生成器有两套口径。
    """
    problems: list[str] = []
    if not isinstance(doc, dict):
        return ["基线不是 JSON 对象"]
    if doc.get("schema_version") != BASELINE_SCHEMA_VERSION:
        problems.append(
            f"schema_version={doc.get('schema_version')!r}，期望 {BASELINE_SCHEMA_VERSION}"
        )

    per_task = doc.get("per_task")
    if not isinstance(per_task, dict) or not per_task:
        problems.append("per_task 缺失或为空 —— 没有可复算的基线")
        return problems

    for task, rewards in per_task.items():
        if not isinstance(rewards, list) or not rewards:
            problems.append(f"{task}: per_task 不是非空列表")
            continue
        bad = [r for r in rewards if not _is_binary_reward(r)]
        if bad:
            problems.append(f"{task}: reward 非二值 {bad!r} —— S 与 m 的前提不成立")

    infra = doc.get("infra_fault") or {}
    if not isinstance(infra, dict):
        problems.append("infra_fault 不是对象")
        infra = {}
    both = sorted(set(per_task) & set(infra))
    if both:
        problems.append(f"这些题同时出现在 per_task 与 infra_fault: {both}")

    declared = (doc.get("noise") or {}).get("stable_set")
    if declared is not None:
        if not isinstance(declared, list):
            problems.append("noise.stable_set 不是列表")
        else:
            recomputed = stable_set(per_task)
            if sorted(declared) != recomputed:
                only_declared = sorted(set(declared) - set(recomputed))
                only_recomputed = sorted(set(recomputed) - set(declared))
                problems.append(
                    "noise.stable_set 与按 per_task 复算的不一致 —— "
                    f"声明多出 {only_declared}，复算多出 {only_recomputed}"
                )

    eps = (doc.get("noise") or {}).get("epsilon")
    if eps is not None:
        try:
            e = Fraction(str(eps))
        except (ValueError, ZeroDivisionError):
            problems.append(f"noise.epsilon={eps!r} 不是可解析的数")
        else:
            if not (0 < e < 1):
                problems.append(f"noise.epsilon={eps!r} 不在 (0,1) 内")

    m = (doc.get("noise") or {}).get("m")
    if m is not None and (not isinstance(m, int) or isinstance(m, bool) or m < 1):
        problems.append(f"noise.m={m!r} 不是正整数")

    return problems


# ───────────────────────────────────────────────── 当前 run 的取数


def current_fingerprint(
    run_dirs: list[str], declared: dict[str, str]
) -> tuple[dict[str, Any] | None, list[str]]:
    """采集并合并多个 run 的指纹。第二个返回值是问题清单（非空即 INVALID）。

    补跑合并的前提是**所有 run 同一套配置**。分别采集再两两比对，
    任一非 VALID 就拒绝 —— 拿两个不同配置的 run 拼成一个分母，
    是「分母不是同一批题」的同型错误（`compare-paired.py` 文件头）。
    """
    docs: list[dict[str, Any]] = []
    for run_dir in run_dirs:
        try:
            doc = run_fingerprint.collect(run_dir, declared)
        except (OSError, ValueError) as exc:
            return None, [f"指纹采集失败 {run_dir}: {exc}"]
        if doc.get("n_trials") == 0:
            return None, [f"{run_dir} 下没有任何 trial（判据：有 result.json）"]
        docs.append(doc)

    for other in docs[1:]:
        try:
            cmp = run_fingerprint.compare(docs[0], other)
        except ValueError as exc:
            return None, [f"指纹比对失败: {exc}"]
        if cmp["verdict"] != "VALID":
            return None, [
                f"补跑的 run 之间指纹不一致（{cmp['verdict']}）: "
                f"{docs[0].get('run_dir')} vs {other.get('run_dir')}；"
                f"字段 {cmp['differing_fields']}"
            ]
    return docs[0], []


def _current_cache(outcomes: dict[str, O.Outcome], run_dirs: list[str]) -> dict[str, Any] | None:
    """当前 run 的缓存命中率（按 provider 族、token 加权）。

    ⚠️ 口径复用 `arm_health.normalized_tokens` + `cache_hit_ratio`，
    ⛔ 不在这里另写一份 token 拆分：三族的 `n_input_tokens` 成分不同
    （`w3-summary.py` 的 caveat 记着：按错口径算会把 92.2% 报成 48.0%）。

    返回 `None` = 一个 token 都拆不出来（不是 0%）。调用方记 `unavailable`，
    ⛔ 不把它当成「下降 0pp」—— 那会让一个采不到的指标永远不触发 WARN。
    """
    import arm_health  # lazy：只有基线声明了 cache 段才会走到这里

    sums: dict[str, dict[str, int]] = {}
    for run_dir in run_dirs:
        for td in O.trial_dirs(run_dir):
            task = O.task_key(td)
            if task not in outcomes or outcomes[task].excluded:
                continue
            result = O.read_result(td)
            if result is None:
                continue
            tok = arm_health.normalized_tokens(result, td)
            if not tok:
                continue
            family = arm_health.observed_model_family(td) or "unknown"
            bucket = sums.setdefault(
                family, {"fresh": 0, "cache_read": 0, "cache_write": 0, "out": 0, "total_in": 0}
            )
            for key in bucket:
                bucket[key] += int(tok.get(key) or 0)
    if not sums:
        return None
    return {
        family: arm_health.cache_hit_ratio(bucket) for family, bucket in sorted(sums.items())
    }


def _current_cost(outcomes: dict[str, O.Outcome], run_dirs: list[str]) -> tuple[float, int, int]:
    """当前 run 的总成本。→ `(合计, 有成本的题数, 缺成本的题数)`。

    ⛔ None 不当 0：缺成本的题单独计数并进报告。把它当 0 会低报成本，
    而低报的一侧在「成本上涨 > 30%」这条判据里看起来更省 —— 朝有利方向失真。
    """
    total = 0.0
    with_cost = 0
    without = 0
    for run_dir in run_dirs:
        for td in O.trial_dirs(run_dir):
            task = O.task_key(td)
            if task not in outcomes or outcomes[task].excluded:
                continue
            result = O.read_result(td)
            cost = (result.get("agent_result") or {}).get("cost_usd") if result else None
            if isinstance(cost, (int, float)) and not isinstance(cost, bool):
                total += float(cost)
                with_cost += 1
            else:
                without += 1
    return total, with_cost, without


# ───────────────────────────────────────────────── 基线的两个可复算量


def _baseline_k(baseline: dict) -> int | None:
    """基线的 k（逐题跑了几次）。`per_task` 各题长度必须一致（校验里已拦）。"""
    per_task = baseline.get("per_task") or {}
    for rewards in per_task.values():
        if isinstance(rewards, list) and rewards:
            return len(rewards)
    return None


def _baseline_epsilon(baseline: dict) -> tuple[Fraction, str]:
    """ε 与其来源。缺省时取 §5.2 的下限 0.10 并标 `defaulted`。"""
    eps = (baseline.get("noise") or {}).get("epsilon")
    if eps is None:
        return EPSILON_FLOOR, "defaulted"
    return Fraction(str(eps)), "baseline"


def _baseline_cost_per_run(baseline: dict) -> tuple[float | None, str]:
    """基线**单轮**成本 → `(usd, source)`。

    ⚠️ 基线是 k=3、当前是 k=1。拿三轮合计与一轮比会把「k 从 3 降到 1」
    判成成本上涨 200%，而那不是回归。所以优先读生成器算好的 `per_run_usd`；
    只有 `total_usd` 时按 `total_usd / k` 折算，并把折算方式写进 source。
    """
    cost = baseline.get("cost") or {}
    per_run = cost.get("per_run_usd")
    if isinstance(per_run, (int, float)) and not isinstance(per_run, bool) and per_run > 0:
        return float(per_run), "per_run_usd"
    total = cost.get("total_usd")
    if isinstance(total, (int, float)) and not isinstance(total, bool) and total > 0:
        k = _baseline_k(baseline)
        if k:
            return float(total) / k, f"total_usd/{k}"
    return None, "missing"


# ───────────────────────────────────────────────────────────── 判定主流程


def evaluate(
    baseline: dict,
    current_run_dirs: list[str],
    *,
    blocks: list[str] | None = None,
    declared: dict[str, str] | None = None,
) -> dict[str, Any]:
    """跑一次 L2 判定。**纯函数**（不读时间、不写盘），便于测试与复算。

    `blocks` 是**外部阻断信号**（预算账本拒绝 / oracle-nop 预检未过）。
    判定器只消费、不重算：账本在 TS 侧、预检在入口脚本（T20），
    跨语言重复实现一份判据迟早分叉成两套口径。
    """
    blocks = list(blocks or [])
    declared = dict(declared or {})

    doc: dict[str, Any] = {
        "verdict": "INVALID",
        "verdict_rule_version": VERDICT_RULE_VERSION,
        "schema_version": BASELINE_SCHEMA_VERSION,
        "baseline_run": (baseline.get("fingerprint") or {}).get("run_dir")
        if isinstance(baseline.get("fingerprint"), dict)
        else None,
        "current_runs": list(current_run_dirs),
        "invalid_reasons": [],
        "warn_signals": [],
        "caveats": [],
        "reasons": [],
        "degraded": False,
        "stable_set": None,
        "noise": None,
        "paired": None,
        "infra": None,
        "cache": None,
        "cost": None,
        "fingerprint": None,
    }
    invalid: list[str] = doc["invalid_reasons"]
    warn: list[str] = doc["warn_signals"]
    caveats: list[str] = doc["caveats"]

    # ── 0. 基线自洽性：它自己都不能当尺子时，后面的数一个都不可信 ──
    problems = validate_baseline(baseline)
    if problems:
        invalid.extend(f"基线不自洽：{p}" for p in problems)
        doc["reasons"] = ["基线不可用，未进入判定"]
        return doc

    # ── 1. 外部阻断（预算账本 / oracle-nop 预检）──
    invalid.extend(f"外部阻断：{b}" for b in blocks)

    per_task: dict[str, list[float]] = baseline["per_task"]
    infra_base: dict[str, str] = dict(baseline.get("infra_fault") or {})
    base_tasks = sorted(set(per_task) | set(infra_base))
    baseline_s = stable_set(per_task)

    # ── 2. 当前 run ──
    outcomes = O.load_runs(current_run_dirs)
    if not outcomes:
        invalid.append("当前 run 下没有任何 trial（判据：有 result.json）")
        doc["reasons"] = ["当前 run 为空，未进入判定"]
        return doc

    # ── 3. 指纹：不一致的两次结果不能比（§3.4）──
    cur_fp, fp_problems = current_fingerprint(current_run_dirs, declared)
    if fp_problems:
        invalid.extend(f"指纹：{p}" for p in fp_problems)
    else:
        base_fp = baseline.get("fingerprint")
        if not isinstance(base_fp, dict):
            invalid.append("指纹：基线缺 fingerprint —— **无法证明可比，不等于通过**")
        else:
            try:
                cmp = run_fingerprint.compare(base_fp, cur_fp, under_test=UNDER_TEST_FIELDS)
            except ValueError as exc:
                invalid.append(f"指纹比对失败：{exc}")
            else:
                doc["fingerprint"] = cmp
                if cmp["verdict"] != "VALID":
                    # INCOMPLETE 也在这里被拦：它的语义是「无法证明一致」，
                    # 而「无法证明一致」不等于一致，更不等于通过（T11 文件头）。
                    invalid.append(
                        f"指纹比对 {cmp['verdict']}（不是 VALID）："
                        f"字段 {cmp['differing_fields']}"
                        + (f"；两边都没采到 {cmp['both_missing']}" if cmp["both_missing"] else "")
                    )
                    if cmp["verdict"] == "INCOMPLETE":
                        caveats.append(
                            "指纹 INCOMPLETE 的语义是「无法证明一致」，不是通过 —— "
                            "补齐采集后重跑，⛔ 不要当成 VALID 用。"
                        )

    # ── 4. 题集双向（缺陷 28 的同一条纪律：两个方向都要查）──
    current_tasks = set(outcomes)
    base_only = sorted(set(base_tasks) - current_tasks)
    current_only = sorted(current_tasks - set(base_tasks))
    if base_only:
        invalid.append(f"有 {len(base_only)} 题尚未跑（不是被排除）：{base_only}")
    if current_only:
        invalid.append(
            f"有 {len(current_only)} 题不在基线题集里（两侧题目集不是同一批）：{current_only}"
        )

    # ── 5. infra 故障率：分母是基线题集大小，不是「跑出来的题数」──
    excluded_now = {t: o.excluded for t, o in outcomes.items() if o.excluded}
    n_base = len(base_tasks)
    infra_ratio = len(excluded_now) / n_base if n_base else 0.0
    doc["infra"] = {
        "n_base_tasks": n_base,
        "n_excluded": len(excluded_now),
        "ratio": infra_ratio,
        "max_ratio": INFRA_FAULT_MAX_RATIO,
        "tasks": dict(sorted(excluded_now.items())),
    }
    if n_base and infra_ratio > INFRA_FAULT_MAX_RATIO:
        invalid.append(
            f"infra 故障率 {infra_ratio:.1%} > {INFRA_FAULT_MAX_RATIO:.0%}"
            f"（{len(excluded_now)}/{n_base}）—— 不出结论，先修环境"
        )

    # ── 6. 稳定必过子集 S → S′，以及冻结的 ε / 现算的 m′ ──
    s_prime = [t for t in baseline_s if t in outcomes and not outcomes[t].excluded]
    # ⚠️ `!= 1.0` 而不是 `< 1.0`：reward=None 也在这里被算作「没有通过」。
    # 它不是 0 分，但 S 的判据是「拿到 1.0」，两者都不能算通过。
    s_failed = sorted(t for t in s_prime if outcomes[t].reward != 1.0)
    eps, eps_source = _baseline_epsilon(baseline)
    if eps_source == "defaulted":
        caveats.append(
            "基线未提供 noise.epsilon，按 §5.2 的下限 0.10 取。"
            "⛔ 真实 ε 要等 T16 样本外一轮实测后写回基线，这一轮结论的阈值偏保守。"
        )
    m = min_m(len(s_prime), eps)
    doc["stable_set"] = {
        "n_recomputed": len(baseline_s),
        "n_declared": len((baseline.get("noise") or {}).get("stable_set") or []),
        "n_prime": len(s_prime),
        "tasks": s_prime,
        "failed": s_failed,
        "failed_outside_s": sorted(
            t
            for t, o in outcomes.items()
            if t not in set(s_prime) and not o.excluded and o.reward != 1.0
        ),
    }
    doc["noise"] = {
        "epsilon": str(eps),
        "epsilon_source": eps_source,
        "m_reported": (baseline.get("noise") or {}).get("m"),
        "m_prime": m,
        "alpha": str(ALPHA),
    }

    # 基线冻了 m 时对账：同一 |S| 下现算值与冻结值必须一致。
    # 不一致的形态是「基线声明了小一点的 S / 大一点的 ε」——都会把阈值悄悄放宽。
    reported_m = (baseline.get("noise") or {}).get("m")
    if reported_m is not None and len(s_prime) == len(baseline_s):
        if reported_m != m:
            invalid.append(
                f"基线冻结的 m={reported_m} 与按 |S|={len(baseline_s)}、ε={eps} "
                f"现算的 m={m} 不一致 —— 基线不自洽或生成器有两套口径"
            )

    # ── 7. REGRESSION：先看阻断，再看趋势 ──
    regression = False
    n_fail = len(s_failed)
    if len(s_prime) == 0:
        invalid.append("稳定必过子集 S′ 为空 —— 没有可判样本，判据不可用")
    elif m is None or len(s_prime) < MIN_STABLE_FOR_BLOCKING:
        doc["degraded"] = True
        pass_rate = (len(s_prime) - n_fail) / len(s_prime)
        doc["reasons"].append(
            f"降级模式：|S′|={len(s_prime)} < {MIN_STABLE_FOR_BLOCKING}"
            f"（或该题量下没有可用阈值）⇒ REGRESSION 停用，只看趋势；"
            f"S′ 通过率 {len(s_prime) - n_fail}/{len(s_prime)} = {pass_rate:.1%}"
        )
        if pass_rate < DEGRADED_MIN_PASS_RATE:
            regression = True
            doc["reasons"].append(
                f"降级兜底：S′ 通过率 {pass_rate:.1%} < {DEGRADED_MIN_PASS_RATE:.0%}"
                "（防「整个跑崩了」）"
            )
    else:
        doc["reasons"].append(
            f"|S′|={len(s_prime)} ≥ {MIN_STABLE_FOR_BLOCKING}，ε={eps}（{eps_source}）"
            f"⇒ m′={m}；S′ 中失败 {n_fail} 题"
        )
        if n_fail >= m:
            regression = True
            doc["reasons"].append(f"失败题数 {n_fail} ≥ m′={m} ⇒ REGRESSION")
        elif n_fail > 0:
            warn.append(f"S′ 中有 {n_fail} 题失败（< m′={m}）")

    # ── 8. 全集配对：只看两侧都可比的题，翻转交给 McNemar ──
    paired = [
        t
        for t in per_task
        if t not in infra_base and t in outcomes and not outcomes[t].excluded
    ]
    up = down = 0
    for t in paired:
        base_pass = all(r == 1.0 for r in per_task[t])
        cur_pass = outcomes[t].reward == 1.0
        if cur_pass and not base_pass:
            up += 1
        elif base_pass and not cur_pass:
            down += 1
    p_value = mcnemar_one_sided_p(up, down)
    doc["paired"] = {
        "n": len(paired),
        "up": up,
        "down": down,
        "net_regression": down > up,
        "mcnemar_one_sided_p": float(p_value),
        "p_lt_0_05": p_value < ALPHA,
        "baseline_pass_rule": "k 次全过才算过（与 S 的定义一致）",
    }
    if down > up:
        warn.append(
            f"全集配对净回退 {down - up}（↑{up} / ↓{down}，n={len(paired)}）"
            + ("；McNemar 单侧 p<0.05，显著" if p_value < ALPHA else "")
        )

    # ── 9. 缓存（按 provider 族、token 加权）──
    base_cache = (baseline.get("cache") or {}).get("hit_rate_by_family")
    if not isinstance(base_cache, dict) or not base_cache:
        doc["cache"] = {"baseline": None, "current": None, "unavailable": "基线未提供 cache 段"}
        caveats.append("缓存命中率未参与判定：基线未提供 cache.hit_rate_by_family。")
    else:
        cur_cache = _current_cache(outcomes, current_run_dirs)
        doc["cache"] = {"baseline": base_cache, "current": cur_cache, "drops": []}
        if cur_cache is None:
            doc["cache"]["unavailable"] = "当前 run 一个 token 都拆不出来"
            caveats.append(
                "缓存命中率未参与判定：当前 run 拆不出 token（不是 0%）。"
                "⛔ 采不到不等于没下降。"
            )
        else:
            for family, base_rate in sorted(base_cache.items()):
                cur_rate = cur_cache.get(family)
                if not isinstance(base_rate, (int, float)) or isinstance(base_rate, bool):
                    continue
                if cur_rate is None:
                    caveats.append(f"缓存：基线有 {family} 族、当前 run 没采到同族，跳过该族比较。")
                    continue
                drop_pp = (float(base_rate) - float(cur_rate)) * 100
                doc["cache"]["drops"].append(
                    {"family": family, "baseline": base_rate, "current": cur_rate, "drop_pp": drop_pp}
                )
                if drop_pp > CACHE_DROP_PP:
                    warn.append(
                        f"缓存命中率下降 {drop_pp:.1f}pp（{family}："
                        f"{float(base_rate):.1%} → {float(cur_rate):.1%}，阈值 {CACHE_DROP_PP:g}pp）"
                    )

    # ── 10. 成本（基线单轮 vs 本次一轮）──
    base_cost, cost_source = _baseline_cost_per_run(baseline)
    if base_cost is None:
        doc["cost"] = {"baseline_usd": None, "current_usd": None, "unavailable": "基线未提供成本"}
        caveats.append("成本未参与判定：基线未提供 cost.per_run_usd / total_usd。")
    else:
        cur_cost, with_cost, without = _current_cost(outcomes, current_run_dirs)
        doc["cost"] = {
            "baseline_usd": base_cost,
            "baseline_source": cost_source,
            "current_usd": cur_cost if with_cost else None,
            "current_tasks_with_cost": with_cost,
            "current_tasks_without_cost": without,
        }
        if with_cost == 0:
            doc["cost"]["unavailable"] = "当前 run 没有任何一题带成本"
            caveats.append("成本未参与判定：当前 run 没有任何一题带成本（不是 0 元）。")
        else:
            rise = (cur_cost - base_cost) / base_cost if base_cost > 0 else 0.0
            doc["cost"]["rise_ratio"] = rise
            doc["cost"]["max_rise_ratio"] = COST_RISE_RATIO
            if rise > COST_RISE_RATIO:
                warn.append(
                    f"总成本上涨 {rise:.1%}（${base_cost:.2f} → ${cur_cost:.2f}，"
                    f"阈值 {COST_RISE_RATIO:.0%}）"
                )
            if without > 0:
                # 缺成本的题按 0 求和会让 current 偏低 ⇒ 成本上涨判不出来。
                # 这是**朝放行方向**的失真，必须显式写明。
                caveats.append(
                    f"当前 run 有 {without} 题没有成本，合计 ${cur_cost:.2f} 是**下界** —— "
                    "⛔ 「没触发成本 WARN」不等于「成本没涨」。"
                )

    # ── 11. 结论 ──
    if invalid:
        doc["verdict"] = "INVALID"
    elif regression:
        doc["verdict"] = "REGRESSION"
    elif warn:
        doc["verdict"] = "WARN"
    else:
        doc["verdict"] = "PASS"
        doc["reasons"].append("S′ 全部通过、无净回退、缓存与成本未超阈值 ⇒ PASS")

    return doc


# ───────────────────────────────────────────────────────────── 人读输出


def render(doc: dict[str, Any]) -> str:
    """人读输出。**第一行就是结论**，阻断时第二屏就能看到原因。"""
    lines = [f"=== L2 判定 ===  结论: {doc['verdict']}"]
    lines.append(f"  判定规则版本: {doc['verdict_rule_version']}")
    if doc.get("degraded"):
        lines.append("  ⚠️ 降级模式：|S′| < 6，REGRESSION 停用，只看趋势（S′ 通过率 < 50% 仍拦截）")
    lines.append(f"  当前: {' + '.join(doc.get('current_runs') or [])}")

    fp = doc.get("fingerprint")
    if isinstance(fp, dict):
        tail = ""
        if fp.get("differing_fields"):
            tail = f"  字段: {', '.join(fp['differing_fields'])}"
        lines.append(f"  指纹: {fp.get('verdict')}{tail}")
    else:
        lines.append("  指纹: 未完成比对")

    ss = doc.get("stable_set")
    noise = doc.get("noise") or {}
    if isinstance(ss, dict):
        lines.append(
            f"  稳定必过子集: 声明 {ss['n_declared']} / 复算 {ss['n_recomputed']}"
            f" / 本次可用 S′ {ss['n_prime']}；ε={noise.get('epsilon')}"
            f"（{noise.get('epsilon_source')}） m′={noise.get('m_prime')}"
        )
        if ss["failed"]:
            lines.append(f"     S′ 中失败 {len(ss['failed'])} 题: {ss['failed']}")

    paired = doc.get("paired")
    if isinstance(paired, dict):
        lines.append(
            f"  全集配对: n={paired['n']}  ↑{paired['up']} / ↓{paired['down']}"
            f"  净{'回退' if paired['net_regression'] else '变化'} "
            f"{paired['down'] - paired['up']:+d}"
            f"（McNemar 单侧 p={paired['mcnemar_one_sided_p']:.4f}"
            f"{'，显著' if paired['p_lt_0_05'] else ''}）"
        )

    cache = doc.get("cache")
    if isinstance(cache, dict):
        if cache.get("unavailable"):
            lines.append(f"  缓存: 未参与（{cache['unavailable']}）")
        elif cache.get("drops"):
            for d in cache["drops"]:
                lines.append(
                    f"  缓存: {d['family']} {float(d['baseline']):.1%} → "
                    f"{float(d['current']):.1%}（{d['drop_pp']:+.1f}pp）"
                )

    cost = doc.get("cost")
    if isinstance(cost, dict):
        if cost.get("unavailable"):
            lines.append(f"  成本: 未参与（{cost['unavailable']}）")
        elif cost.get("current_usd") is not None:
            rise = cost.get("rise_ratio")
            rise_txt = f"（{rise:+.1%}）" if isinstance(rise, float) else ""
            lines.append(
                f"  成本: ${cost['baseline_usd']:.2f} → ${cost['current_usd']:.2f}{rise_txt}"
                f"  基线口径={cost['baseline_source']}"
            )

    if doc.get("warn_signals"):
        lines.append("  ⚠️ 警告信号:")
        lines.extend(f"     - {w}" for w in doc["warn_signals"])
    if doc.get("invalid_reasons"):
        lines.append("  ⛔ 无效原因:")
        lines.extend(f"     - {r}" for r in doc["invalid_reasons"])
    if doc.get("effective_reasons"):
        lines.append("  理由:")
        lines.extend(f"     - {r}" for r in doc["effective_reasons"])
    elif doc.get("reasons"):
        lines.append("  理由:")
        lines.extend(f"     - {r}" for r in doc["reasons"])
    if doc.get("caveats"):
        lines.append("  📝 备注（引用结论前先读）:")
        lines.extend(f"     - {c}" for c in doc["caveats"])
    return "\n".join(lines)


# ───────────────────────────────────────────────────────────── CLI


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="L2 判定器：按方案 §5.2 输出 PASS / WARN / REGRESSION / INVALID",
        epilog="退出码：0 放行（PASS/WARN） / 2 阻断（REGRESSION） / 3 无效（INVALID）",
    )
    ap.add_argument("--baseline", required=True, help="基线文档（见文件头的格式）")
    ap.add_argument(
        "--current",
        action="append",
        required=True,
        help="当前 run 目录，可重复（多个 = 补跑合并，后者覆盖前者）",
    )
    ap.add_argument(
        "--declare",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="声明 run 产物里取不到的指纹字段（traj_bench_commit / network_policy），可重复",
    )
    ap.add_argument(
        "--block",
        action="append",
        default=[],
        metavar="REASON",
        help="外部阻断信号（预算账本拒绝 / oracle-nop 预检未过），任一即 INVALID，可重复",
    )
    ap.add_argument("--out", default="", help="把裁决写成 JSON 落盘（§5.3）")
    ap.add_argument("--json", action="store_true", help="stdout 额外输出机器可读的完整裁决")
    args = ap.parse_args(argv)

    try:
        with open(args.baseline, encoding="utf-8") as fh:
            baseline = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"⛔ 读不了基线 {args.baseline}: {exc}", file=sys.stderr)
        return 1

    # 复用 T11 的声明校验（只接受 run 产物里取不到的字段）。两套口径分叉会让
    # 「采到的」与「人手声称的」混成同一个值 —— 那正是 T11 刻意防住的形态。
    try:
        declared = run_fingerprint._parse_declared(args.declare)
    except SystemExit as exc:  # argparse 风格的退出，保持它的错误信息
        print(exc, file=sys.stderr)
        return 1

    doc = evaluate(baseline, list(args.current), blocks=list(args.block), declared=declared)
    doc["generated_at"] = (
        __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
    )
    print(render(doc))

    if args.out:
        out_dir = os.path.dirname(os.path.abspath(args.out))
        os.makedirs(out_dir, exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print(f"\n裁决已落盘: {args.out}")

    if args.json:
        print(json.dumps(doc, ensure_ascii=False, indent=2))

    return EXIT[doc["verdict"]]


if __name__ == "__main__":
    sys.exit(main())
