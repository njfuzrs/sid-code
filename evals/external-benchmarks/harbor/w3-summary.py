#!/usr/bin/env python3
"""T5 汇总:把一个 job 目录嚼成**一份可入库的 JSON**(逐题表 + 分母 + 置信区间)。

    python3 w3-summary.py runs/w3-cc-sonnet-72                    # 打印
    python3 w3-summary.py runs/w3-cc-sonnet-72 -o results/        # 落盘归档
    python3 w3-summary.py runs/w3-sid-sonnet-72 runs/w3-cc-sonnet-72 -o results/
                          └ 两个 job = 顺带产出配对对照(公共干净子集)

## 🔴 为什么必须有这个脚本:`runs/` 整个不入库

`.gitignore:228` 排除了 `/evals/external-benchmarks/harbor/runs/` —— 理由正当
(跑分产物、体积大、天生可再生)。但后果是 **T4 三臂 $108–123 的产出只活在本机磁盘上,
没有第二份**。一次 `docker prune`、换机器、或 colima 出事,数据就没了。

⇒ 本脚本产出的 JSON **刻意做得小**(几十 KB:逐题表 + 分母 + 口径声明,
不含轨迹/verifier 输出),落在 `results/` 下 —— **那个目录不在 ignore 里**,
所以它是唯一能进版本库、能被 review、能跨机器活下来的那一份。

⚠️ 「可再生」对 $0 的产物成立,对**花了钱的**产物不成立:重跑一次要再花 $108。

## 判据全部复用,⛔ 本文件不新写一份口径

  - 排除规则 → `w3-classify.classify()`(与 `compare-paired.load()` 逐字同序)
  - cc 侧字段 → `arm_health`(cc 的 turns/subtype/denials 在 `claude-code.txt` 里)
  - token 归一化 → `arm_health.normalized_tokens()`(🔴 两臂 `n_input_tokens` 语义相反)

## ⚠️ 三条写死在输出里的口径纪律

1. **分母是 `scored`,⛔ 不是 72。** 置信区间按参与计分的题数算 ——
   拿 72 当分母会把「被排除的基础设施故障」算成「答错」,把成绩系统性压低。
2. **reward 必须是 0/1。** Wilson 区间假设二值;真出现小数就 fail-closed
   (⛔ 不悄悄按均值当 p 算,那个区间是错的)。
3. **TTFT 不做两臂对照。** 理由见 `arm_health.cc_ttft_ms` —— cc 侧是整会话
   一个标量、且**缺失偏在撞满轮数那些题上**,与 sid 侧的逐 fetch 分布不是同一个量。
"""

from __future__ import annotations

import argparse
import datetime as _dt
import glob
import importlib.util
import json
import math
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from arm_health import (  # noqa: E402
    cache_hit_ratio,
    cc_api_error_status,
    cc_denials,
    cc_model,
    cc_provider,
    cc_subtype,
    cc_turns,
    cc_ttft_ms,
    detect_arm,
    normalized_tokens,
    pricing_ratio,
    sid_binary_identity,
    self_reported_success_cc,
    sid_model,
    token_undercount_suspected,
)
from verifier_health import self_reported_success  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

#: 轮数上限。⚠️ 与 `analyze-model-switch.py:MAX_TURNS` 同一个环境变量 ——
#: 两处写死不同值的形态是「撞满题数」在两份报告里不一致,而它不报错。
MAX_TURNS = int(os.environ.get("SID_MODELSWITCH_MAX_TURNS", "40"))


def _load_classify():
    """import `w3-classify.py` 的 `classify()`。

    ⚠️ 文件名带连字符 ⇒ 不能 `import w3_classify`,必须走 importlib。
    **值得这点麻烦**:替代方案是在本文件重写一遍五条排除规则,
    而「同一判据两份拷贝」是这个目录已经踩过的错(顺序都必须逐字一致)。
    """
    path = os.path.join(HERE, "w3-classify.py")
    spec = importlib.util.spec_from_file_location("w3_classify", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.classify


classify = _load_classify()


# ── 置信区间 ────────────────────────────────────────────────────────────────


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score 区间。**比正态近似更该用的那一个。**

    07 号 §6.4 用的是 `1.96*sqrt(0.25/n)` —— 那是 **p=0.5 时的最坏情况半宽**
    (n=72 ⇒ ±11.5pp),用来做**规划**(「跑多少题够」)是对的。
    但用它报**结果**有两个问题:

      1. 它与实测的 p 无关 —— p=0.3 时真实区间比它窄;
      2. 它在 p 靠近 0 或 1 时会给出**越界**的区间(如 -4% ~ 18%),
         而 pass@1 恰恰常在低位。terminal-bench 上 0.3 附近尚可,
         但一旦某臂只解出 3/72,正态近似就会给出负下界。

    Wilson 不会越界,且小样本下覆盖率更好。两个数都报,标清哪个是哪个。
    """
    if n <= 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = (z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d
    return (max(0.0, centre - half), min(1.0, centre + half))


def worst_case_halfwidth_pp(n: int, z: float = 1.96) -> float | None:
    """p=0.5 的正态近似半宽(07 号 §6.4 那个数)。**规划用,⛔ 不报成结果区间。**"""
    if n <= 0:
        return None
    return z * math.sqrt(0.25 / n) * 100


# ── 逐题取数 ────────────────────────────────────────────────────────────────


def job_unfinished(run_dir: str) -> tuple[bool | None, int | None]:
    """这个 job 跑完了没有。→ `(未跑完?, harbor 声明的总题数)`；`None` = 判不出。

    ## 判据是 harbor 自己写的 `finished_at`，⛔ 不是「题数差」

    我第一版判据写的是「dataset 应有题数 − 已落盘 trial 数 > 0 ⇒ 未跑完」，
    **它在 A2 上假红了**：A2 的 job 声明的是 `terminal-bench-local@2.0`(66 题)，
    而它**实际只跑并计分 54 题**（§4.8 记载的历史：开跑时题集是 66，
    sonnet 额度耗尽后收敛到 54）。于是一个**已经跑完并已发表**的 run
    被判成「还差 12 题」—— 那比不判更坏：它会让人怀疑一份正确的结论。

    ⇒ 正确的源是 job 级 `result.json` 的 `finished_at`：
    有时间戳 = harbor 认为这轮结束了；`None` = 还在跑。
    **这是观测值**（harbor 落的），而「题数差」是我自己的推断 ——
    本仓的纪律是取观测方，不取推断方。

    ⚠️ `n_total_trials` 一并返回但**只用于显示**：它同样是 66/54 这种口径，
    ⛔ 不能拿它当 pass@1 的分母（分母永远是 `scored`）。
    """
    try:
        with open(os.path.join(run_dir, "result.json"), encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return (None, None)
    if not isinstance(d, dict):
        return (None, None)
    total = d.get("n_total_trials")
    total = int(total) if isinstance(total, (int, float)) else None
    return (d.get("finished_at") is None, total)


def collect(run_dir: str) -> dict:
    """嚼一个 job 目录 → 汇总 dict(含逐题表)。"""
    arm = None
    rows: list[dict] = []
    for f in sorted(glob.glob(os.path.join(run_dir, "*", "result.json"))):
        td = os.path.dirname(f)
        if "__" not in os.path.basename(td):
            continue  # job 级 result.json 不是 trial
        task = os.path.basename(td).split("__")[0]
        with open(f, encoding="utf-8") as fh:
            d = json.load(fh)
        arm = arm or detect_arm(td)
        this_arm = detect_arm(td)

        # 🔴 排除规则**复用** w3-classify,⛔ 不在此重写(见模块头)
        reward, excl = classify(td)

        tok = normalized_tokens(d, td)
        ar = d.get("agent_result") or {}
        md = ar.get("metadata") or {}

        # 逐臂取数源不同 —— 这是本质的,不是可以合并的分支
        if this_arm == "cc":
            turns, subtype = cc_turns(td), cc_subtype(td)
            deny, allow = cc_denials(td), None  # cc 无 allow 计数
            selfrep = self_reported_success_cc(d, td)
            ttft, api_err = cc_ttft_ms(td), cc_api_error_status(td)
            # 模型名取**观测值**(modelUsage 键),⛔ 不取 config.agent.model_name(意图)
            model, provider = cc_model(td), cc_provider(td)
        else:
            turns, subtype = md.get("sid_num_turns"), md.get("sid_subtype")
            # 🔴 `sid_num_turns` 有**两个语义不同的源**,判「撞满轮数」时必须区分:
            #   `stream-json-result`   ⇒ result 事件的 `num_turns`(真·API 轮数)
            #   `session-traj-fallback` ⇒ traj 的 `total_steps`(**步骤数,不是轮数**)
            # 见 `sid_code_agent.py:821` 与 `trace/collector.ts:2406-2407`
            # (`turns: apiCalls` vs `total_steps: pairs.length` 是两个字段)。
            # 实测 A2 三个 fallback 样本的 steps/api 恒为 2.0×、A1 达 2.3–5.3×
            # ⇒ 拿 total_steps 与 MAX_TURNS 比会**虚报撞满**。
            # 实测踩到:A2 的 `install-windows-3.11`(steps=42、api_calls=21、
            # subtype 为 None)被计进「撞满 40 轮」,让已发表的 13/54 多算一题(真值 12)。
            turns_is_api_calls = md.get("sid_cost_source") == "stream-json-result"
            deny, allow = md.get("sid_permission_denials"), md.get("sid_permission_allows")
            selfrep = self_reported_success(d)
            ttft, api_err = None, None  # sid 侧 TTFT 在 digest 里,不在 result.json
            # ⚠️ 模型名**不在 metadata 里**(实测 19 个键里没有;我初版写
            # `md.get("sid_model")` 是猜的,当场被 diagnostics 抓到未使用)。
            # 唯一可靠源是容器内那份 settings.json 的 availableModels[0] ——
            # 它是「落到容器里的事实」,而环境变量只是意图
            # (口径与 analyze-model-switch._model_of 一致)。
            model, provider = sid_model(td)

        rows.append({
            "task": task,
            "arm": this_arm,
            "reward": reward,
            "excluded": excl,
            "turns": turns,
            # ⛔ fail-closed:源不是权威的 result 事件时**一律不判撞满** ——
            # 宁可漏报(那只是少一条 caveat),也不要虚报(虚报会把一个正常结束的样本
            # 说成「用完预算」,而那正是这条 caveat 要人别误读的东西)。
            # ⚠️ cc 臂 `turns_is_api_calls` 恒 False 会让它整臂不判撞满 ——
            # 所以 cc 分支单独给 True(cc 的 turns 取自 result 事件,同权威)。
            # 🔴 **三态**:True=撞满 / False=判了但没撞满 / **None=判不出来**。
            # ⚠️ 初版是二态(不可判折叠成 False),那让「判了没撞满」与「turns 源
            # 不权威所以判不了」**无法区分** —— 于是想给这条 caveat 补一个
            # 「可判分母」时,`sum(1 for r in rows if r["maxed"] is not None)`
            # 恒等于全部题数,分母披露静默失效(2026-09-12 实测,当场踩到)。
            # 这是本仓那条「一个字段混了两个相反语义」的同型:折叠掉的那一态
            # 恰恰是引用时最需要知道的一态。
            "maxed": (
                None
                if turns is None or not (turns_is_api_calls if this_arm != "cc" else True)
                else turns >= MAX_TURNS
            ),
            "subtype": subtype,
            "self_reported_success": selfrep,
            "permission_denials": deny,
            "permission_allows": allow,
            # 🔴 必控变量的**观测证据**:两侧都不取 config.agent.model_name(意图)。
            # 没有这一格,「A2 vs A3 同模型」就只有命令行作证 —— 而本仓三个已实测
            # 的坑全是「传了但没生效且不报错」。
            "model_observed": model,
            "provider_observed": provider,
            # 🔴 **真跑二进制**的身份(⛔ 不是归档顶层那个 sid_code_commit ——
            # 那个是「跑汇总时本仓 HEAD」,即谁做的取数,见 sid_binary_identity 的
            # docstring:两者都叫 commit、都是合法 sha,看数值分辨不出来)。
            "sid_binary_commit": sid_binary_identity(d)[0],
            "sid_binary_sha256": sid_binary_identity(d)[1],
            "cost_usd": ar.get("cost_usd"),
            "cost_source": md.get("sid_cost_source"),
            "tokens": tok,
            "cache_hit_ratio": cache_hit_ratio(tok),
            # 隐含定价倍率:偏离 2/3 ⇒ **那一题 token 低报,但 cost 仍可信**
            # (实测 20 题里抓出 1 题:harbor 的 ATIF 转换漏了一部分 step)。
            "pricing_ratio": pricing_ratio(d, td),
            "token_undercount_suspected": token_undercount_suspected(d, td),
            "cc_ttft_ms": ttft,
            "cc_api_error_status": api_err,
            "started_at": d.get("started_at"),
            "finished_at": d.get("finished_at"),
        })

    scored = [r for r in rows if r["excluded"] is None and r["reward"] is not None]
    excluded = [r for r in rows if r["excluded"] is not None]

    # ⚠️ reward 必须二值,否则 Wilson 的前提不成立 ⇒ fail-closed
    nonbinary = sorted({r["reward"] for r in scored if r["reward"] not in (0.0, 1.0)})

    k = sum(1 for r in scored if r["reward"] == 1.0)
    n = len(scored)
    by_reason: dict[str, int] = {}
    for r in excluded:
        by_reason[r["excluded"]] = by_reason.get(r["excluded"], 0) + 1

    ci: dict = {"n": n, "passed": k}
    if nonbinary:
        ci["error"] = (
            f"reward 非二值 {nonbinary} ⇒ ⛔ 拒绝给区间。Wilson 假设 0/1;"
            "按均值当 p 算出来的区间是错的。"
        )
    elif n > 0:
        lo, hi = wilson(k, n)
        ci.update({
            "method": "wilson-score-95",
            "p": k / n,
            "lo": lo,
            "hi": hi,
            "halfwidth_pp": (hi - lo) / 2 * 100,
            "worst_case_halfwidth_pp_planning_only": worst_case_halfwidth_pp(n),
            "denominator_note": (
                f"分母是 scored={n}(参与计分的题),⛔ 不是 {len(rows)}(全部 trial)"
                f",也不是 72。被排除的是基础设施故障,算进分母等于把它记成答错。"
            ),
        })
    else:
        ci["error"] = "scored=0 ⇒ 没有可计分样本。这**不是** 0 分,是没有分母。"

    # 成本:只对有值的求和,并报缺了几个(⛔ 不把 None 当 0 —— 那会低报)
    costs = [r["cost_usd"] for r in rows if isinstance(r["cost_usd"], (int, float))]

    # token:合计前必须**逐题都拆得出**,否则合计的分母是模糊的
    toks = [r["tokens"] for r in rows if r["tokens"]]
    tok_total: dict | None = None
    if toks:
        sums: dict[str, int] = {
            key: sum(t[key] for t in toks)
            for key in ("fresh", "cache_read", "cache_write", "out", "total_in")
        }
        # ⚠️ 命中率**按合计重算**,⛔ 不是逐题命中率求平均 —— 后者是「比率的平均」,
        # 会给小题目和大题目同样的权重(一道 2 千 token 的题与一道 200 万的题等权)。
        # 我们要的是「这一臂总共有多少 input 命中了缓存」,分母必须是合计总入。
        tok_total = dict(sums)
        tok_total["hit_ratio"] = cache_hit_ratio(sums)
        tok_total["n_with_tokens"] = len(toks)
        tok_total["n_trials"] = len(rows)
        tok_total["source"] = sorted({t["source"] for t in toks})

    # 🔴 成本口径的**混合比**:`session-traj-fallback` 那部分是「比 null 准」,
    # 不是权威值 —— `sid_code_agent.py:810` 注释写明它**仍可能偏低**
    # (最后 ≤30s 的调用没来得及落盘)。⇒ 兜底占比高时这一臂的成本合计是**下界**。
    # ⚠️ 这一格必须落盘:两条臂的兜底占比可能差一个数量级(实测 A2 3/54、A1 4/13),
    # 而「一个下界」与「一个准值」并排比成本时,偏低的那侧会看起来更省 ——
    # 那正是本仓「非能力差异混进能力账」的同型错。
    fallback_cost = [r["task"] for r in rows
                     if r["cost_source"] == "session-traj-fallback"]

    unfinished, n_declared = job_unfinished(run_dir)

    maxed = [r["task"] for r in rows if r["maxed"]]
    selfreps = [r["task"] for r in rows if r["self_reported_success"]]
    ttfts = [r["cc_ttft_ms"] for r in rows if isinstance(r["cc_ttft_ms"], int)]
    undercount = [r["task"] for r in rows if r["token_undercount_suspected"]]
    # 🔴 必控变量:观测到的模型必须**唯一**。多于一个 ⇒ 这一臂内部混了模型,
    # 而那会让整条臂的成本/token 失去共同口径(⛔ 不是"取第一个"能解决的)。
    models = sorted({r["model_observed"] for r in rows if r["model_observed"]})
    providers = sorted({r["provider_observed"] for r in rows if r["provider_observed"]})
    n_model_missing = sum(1 for r in rows if not r["model_observed"])
    # 🔴 harness 版本是「换模型对照」的必控变量 —— 两臂必须是同一个二进制。
    # ⚠️ 多值 ⇒ 这批题不是同一个二进制跑的 ⇒ 整臂不可比,必须显式报出来。
    bin_commits = sorted({r["sid_binary_commit"] for r in rows if r["sid_binary_commit"]})
    bin_shas = sorted({r["sid_binary_sha256"] for r in rows if r["sid_binary_sha256"]})
    n_bin_missing = sum(1 for r in rows if not r["sid_binary_commit"])

    caveats = [
        "分母:引用 pass 率必须带 n=scored,⛔ 别拿 72 当分母。",
        "token:`n_input_tokens` 的成分**三态不同** —— cc 含 cache;"
        "sid+anthropic 不含;sid+openai 族(deepseek 等)**含**(prompt_tokens 口径)。"
        "本文件的 tokens 已按 arm_health.normalized_tokens 按族归一 —— "
        "⛔ 别回去直接比 result.json 里的 n_input_tokens。"
        "⚠️ 第三态是 2026-09-12 才修的:此前 sid 臂无条件按「不含」拆,"
        "A1 首版归档因此把 fresh 虚报 12.8 倍、缓存命中率 92.2% 假报成 48.0%。",
    ]
    if unfinished:
        caveats.insert(
            0,
            f"🔴 **这一轮还没跑完**(harbor 的 `finished_at` 仍为 None,当前 "
            f"{len(rows)} 题落盘)⇒ **此处的 pass@1 不是终值**。⛔ 别把它写进文档或"
            "对照表:先跑完的是**快的那批题**,不是随机子集 —— 实测 A1 跑到 16 题时,"
            "A2 在**同一批**题上是 62.5%、而它的全集只有 46.3%(偏易 +16.2pp)。",
        )

    if fallback_cost:
        caveats.append(
            f"成本口径混合:{len(fallback_cost)}/{len(rows)} 题的 cost 取自 "
            "`session-traj-fallback`(result 事件丢了),它**仍可能偏低** ⇒ "
            "本臂成本合计是**下界**。⛔ 与另一臂比成本前先核两侧的这个占比 —— "
            "占比不同时,兜底多的那侧会看起来更省。"
        )

    if arm == "cc":
        caveats += [
            f"TTFT:{len(rows) - len(ttfts)}/{len(rows)} 题缺失,且缺失**偏在撞满轮数**"
            "那些题上 ⇒ ⛔ 不许与 sid 侧 TTFT 对照,也别按有值样本算均值。",
            "权限:cc 只有自述 permission_denials、**无 allow 计数** ⇒ "
            "denials=0 区分不出「真零拒绝」与「没采到」,弱于 sid 侧。",
            "重试:cc 自带 max_retries=10 而 sid 零重试 ⇒ "
            "两臂「上游打断题数」不可直接并列(08 号 §4.1.1)。",
            "digest:cc 侧无轨迹 digest ⇒ 缓存断裂/空转/工具序列这些指标本臂没有对称源。",
        ]
    # 🔴 「撞满轮数」的分母**不是** len(rows):`maxed` fail-closed 只判 turns 源权威
    # 那些题,其余题一律不判 ⇒ 报「10 题」而不报可判分母,读者会默认分母是 54。
    # ⚠️ 两臂的不可判题数差 4 倍(实测 A1 13 题 / A2 3 题,与 cost 兜底逐题同集),
    # 所以「A1 撞满 10 < A2 撞满 14」这个并列是**假的**:按各自可判分母算是
    # 24.4%(10/41) vs 27.5%(14/51),而在两侧都可判的 39 题交集上是 **A1 9 > A2 7**
    # —— 方向反过来。这正是「分母比分子重要」在本臂的形态。
    n_judgeable_maxed = sum(1 for r in rows if r["maxed"] is not None)
    if len(bin_commits) > 1:
        caveats.append(
            f"🔴 **这批题不是同一个二进制跑的**(观测到 {len(bin_commits)} 个 commit:"
            f"{bin_commits})⇒ ⛔ 整臂不可比,更不能与另一臂做「只换模型」的对照 ——"
            "harness 版本本身就动了。"
        )
    if n_bin_missing:
        caveats.append(
            f"⚠️ {n_bin_missing}/{len(rows)} 题没采到真跑二进制的 commit ⇒ "
            "这些题「同 harness」这句话只有命令行作证。"
            "⛔ 别拿归档顶层的 `sid_code_commit` 顶替 —— 那是跑汇总时的仓库 HEAD。"
        )
    if maxed:
        caveats.append(
            f"撞满 {MAX_TURNS} 轮 {len(maxed)} 题 ⇒ ⛔ 别把这些 0 分读成「能力不行」,"
            "它们是用完预算(#138 轮数预算)。"
            f"⚠️ 分母是**可判的 {n_judgeable_maxed} 题**(其余 "
            f"{len(rows) - n_judgeable_maxed} 题 turns 源不权威、fail-closed 不判),"
            "⛔ 不是 scored ——**两臂这个分母不同时,撞满题数不可直接并列**,"
            "要么各自除以可判分母、要么只在两侧都可判的交集上比。"
        )
    if selfreps:
        caveats.append(
            f"自报成功却 0 分 {len(selfreps)} 题 ⇒ 这些**是**真实能力失败,必须计分(#143)。"
        )
    if undercount:
        caveats.append(
            f"token 低报 {len(undercount)} 题 {undercount}:隐含单价偏离 2/3 ⇒ "
            "**这些题的 token 不可信,但 cost 可信**(cost 有 agent 自报 + 网关账本"
            "两个源,token 只有一条链路)。⛔ 别拿这些题算缓存命中率。"
        )
    if len(models) > 1:
        caveats.append(
            f"🔴 本臂内部观测到**多个模型** {models} ⇒ 这一臂没有共同口径,"
            "成本/token 合计失去意义。先查降级链是否动过。"
        )
    if n_model_missing:
        caveats.append(
            f"模型名未采到 {n_model_missing}/{len(rows)} 题 ⇒ 「同模型」这个必控变量"
            "在这些题上**只有命令行作证**(本仓三个已实测的坑全是「传了但没生效且不报错」)。"
        )

    return {
        "job": os.path.basename(os.path.abspath(run_dir)),
        "arm": arm,
        "n_trials": len(rows),
        "denominators": {
            "scored": n,
            "excluded": len(excluded),
            "pending_or_unjudged": len(rows) - n - len(excluded),
            "by_reason": by_reason,
            "excluded_tasks": sorted(r["task"] for r in excluded),
            # 🔴 见 expected_task_count:题集应有题数,与已落盘 trial 的差 = 还没跑完。
            # 缺这一格时 pass@1 会被当成终值引用,而中途子集**偏易**(实测 +16.2pp)。
            # 🔴 见 job_unfinished:判据是 harbor 的 finished_at,⛔ 不是题数差
            # (题数差在 A2 这种「66 题 job 实跑 54」的 run 上必然假红)。
            "job_unfinished": unfinished,
            "n_total_trials_declared": n_declared,
        },
        "ci": ci,
        "failure_mix": {
            "passed": k,
            "failed_capability": n - k,
            "excluded_non_capability": len(excluded),
            "maxed_turns": len(maxed),
            "maxed_turns_tasks": maxed,
            # 🔴 引用 maxed_turns 必须同时取这个分母(见同名 caveat)。
            "maxed_turns_judgeable_denominator": n_judgeable_maxed,
            "maxed_turns_unjudgeable": len(rows) - n_judgeable_maxed,
            "self_reported_success_but_zero": selfreps,
        },
        "cost_usd": {
            "total": round(sum(costs), 6) if costs else None,
            "n_with_cost": len(costs),
            "n_trials": len(rows),
            "note": "⛔ None 未按 0 计入 —— 那会低报(见 sid_code_agent 的 traj 兜底注释)",
            # 🔴 见 fallback_cost 的注释:这几题的成本是**下界**,不是准值。
            "n_traj_fallback": len(fallback_cost),
            "traj_fallback_tasks": fallback_cost,
        },
        "controlled_variables": {
            "model_observed": models,
            "provider_observed": providers,
            "n_model_missing": n_model_missing,
            # 真跑二进制(必控变量):⛔ 别用归档顶层的 sid_code_commit 代替它。
            "sid_binary_commit_observed": bin_commits,
            "sid_binary_sha256_observed": bin_shas,
            "n_sid_binary_missing": n_bin_missing,
            "note": (
                "观测值:cc 取 result.modelUsage 的键、sid 取容器 settings.json 的"
                " availableModels[0] —— 两侧都**不取** config.agent.model_name(那是意图)。"
                " ⚠️ provider 取值域两侧不同(cc 是 firstParty 这类内部标签、"
                "sid 是族名)⇒ ⛔ 不许比字符串相等。"
            ),
        },
        "token_undercount_tasks": undercount,
        "tokens_normalized": tok_total,
        "caveats": caveats,
        "tasks": sorted(rows, key=lambda r: r["task"]),
    }


def pair(a: dict, b: dict) -> dict:
    """两臂配对对照 —— **只比两侧都干净的公共子集**。

    ⚠️ 口径与 `compare-paired.py` 一致:任一侧被排除就整对退出。
    不这么做的形态是「两个均值并列,而分母装的不是同一批题」——
    那正是 `0.100 → 0.750` 那个假数的成因(05 号 §00 实测)。
    """
    A = {r["task"]: r for r in a["tasks"]}
    B = {r["task"]: r for r in b["tasks"]}
    common = sorted(set(A) & set(B))
    paired, dropped = [], []
    for t in common:
        if A[t]["excluded"] or B[t]["excluded"] or A[t]["reward"] is None or B[t]["reward"] is None:
            dropped.append({"task": t, "a": A[t]["excluded"], "b": B[t]["excluded"]})
        else:
            paired.append(t)

    out: dict = {
        "arm_a": {"job": a["job"], "arm": a["arm"]},
        "arm_b": {"job": b["job"], "arm": b["arm"]},
        "n_paired": len(paired),
        "n_dropped": len(dropped),
        "dropped": dropped,
        "only_in_a": sorted(set(A) - set(B)),
        "only_in_b": sorted(set(B) - set(A)),
    }
    if a["arm"] and a["arm"] == b["arm"]:
        # 🔴 08 号 §9.2-⑦:目录名说 cc、里面是 sid,两侧都不报错。
        out["error"] = (
            f"两侧 arm 都是 {a['arm']} ⇒ 这不是跨 harness 对照。"
            "检查开跑命令是否漏了 SID_W3_ARM=cc。"
        )
        return out
    if not paired:
        out["error"] = "配对可比题数为 0 —— 不是「没有差异」,是没有样本。"
        return out

    ka = sum(1 for t in paired if A[t]["reward"] == 1.0)
    kb = sum(1 for t in paired if B[t]["reward"] == 1.0)
    la, ha = wilson(ka, len(paired))
    lb, hb = wilson(kb, len(paired))
    out.update({
        "a_passed": ka, "b_passed": kb,
        "a_p": ka / len(paired), "b_p": kb / len(paired),
        "a_ci": [la, ha], "b_ci": [lb, hb],
        "ci_overlap": not (ha < lb or hb < la),
        "a_only_solved": [t for t in paired if A[t]["reward"] == 1.0 and B[t]["reward"] == 0.0],
        "b_only_solved": [t for t in paired if B[t]["reward"] == 1.0 and A[t]["reward"] == 0.0],
        "note": (
            f"分母 n={len(paired)}(两侧都干净的公共子集),⛔ 不是各自的原分母。"
            "逐题表才是结论:n 这么小,均值极易被一题带偏。"
        ),
    })
    if out["ci_overlap"]:
        out["verdict"] = (
            "两臂 95% 区间**重叠** ⇒ 统计上区分不了谁更强。"
            "⛔ 别把点估计之差讲成「我们更好」;该讲的是逐题机理差异。"
        )
    else:
        out["verdict"] = (
            "两臂 95% 区间不重叠。⚠️ 但仍**不等于** harness 差异:"
            "cc 自带 max_retries=10 而 sid 零重试(08 号 §4.1.1),"
            "这部分不对称不属于能力。"
        )
    return out


def _git_commit() -> str | None:
    """记下产出这份数据时的仓库 commit —— 归档没有它就不可复算。"""
    try:
        r = subprocess.run(["git", "rev-parse", "HEAD"], cwd=HERE,
                           capture_output=True, text=True, timeout=10)
        return r.stdout.strip() or None if r.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("job_dirs", nargs="+", help="一个或两个 job 目录(两个则顺带配对对照)")
    ap.add_argument("-o", "--out-dir", help="落盘目录(建议 results/ —— 它不在 gitignore 里)")
    args = ap.parse_args()

    for d in args.job_dirs:
        if not os.path.isdir(d):
            print(f"⛔ 不是目录: {d}", file=sys.stderr)
            return 2
    if len(args.job_dirs) > 2:
        print("⛔ 最多两个 job(配对对照是两两的)", file=sys.stderr)
        return 2

    arms = [collect(d) for d in args.job_dirs]
    doc = {
        "schema_version": 1,
        "generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        # ⚠️ 这是**跑汇总脚本时本仓的 HEAD**(谁做的取数),
        # ⛔ **不是**产出这批数据的二进制版本 —— 那个在每臂的
        # `controlled_variables.sid_binary_commit_observed` 里。
        # 实测踩到:A2 归档只因重跑一次汇总,这一格就从 d1f30718 变成 92aca39b,
        # 而 54 份 result.json 一字未动 ⇒ 拿它当「数据是哪个版本跑的」会凭空
        # 得出「A2 换了 sid 版本」。字段名保留是为了不破坏既有引用。
        "sid_code_commit_of_analysis": _git_commit(),
        "sid_code_commit": _git_commit(),
        "max_turns_threshold": MAX_TURNS,
        "arms": arms,
    }
    if len(arms) == 2:
        doc["paired"] = pair(arms[0], arms[1])

    # ── 人读摘要 ────────────────────────────────────────────────────────────
    for a in arms:
        print(f"\n{'=' * 78}\n### {a['job']}  (arm={a['arm']}, {a['n_trials']} trial)\n{'=' * 78}")
        d = a["denominators"]
        print(f"  分母: 计分 {d['scored']} / 排除 {d['excluded']} / 未判 {d['pending_or_unjudged']}")
        if d["by_reason"]:
            print(f"        排除构成 {d['by_reason']}")
        ci = a["ci"]
        if "error" in ci:
            print(f"  ⛔ 置信区间: {ci['error']}")
        else:
            print(f"  pass@1 = {ci['p'] * 100:.1f}%  (n={ci['n']}, {ci['passed']} 解出)")
            print(f"  95% Wilson = [{ci['lo'] * 100:.1f}%, {ci['hi'] * 100:.1f}%]"
                  f"  半宽 ±{ci['halfwidth_pp']:.1f}pp")
            print(f"  ⚠️ {ci['denominator_note']}")
        fm = a["failure_mix"]
        print(f"  失败构成: 能力失败 {fm['failed_capability']} / 非能力排除 "
              f"{fm['excluded_non_capability']} / 撞满轮数 {fm['maxed_turns']} / "
              f"自报喜 {len(fm['self_reported_success_but_zero'])}")
        c = a["cost_usd"]
        print(f"  成本: ${c['total']} ({c['n_with_cost']}/{c['n_trials']} 题有值)")
        cv = a["controlled_variables"]
        print(f"  必控变量(观测): 模型 {cv['model_observed']} / provider "
              f"{cv['provider_observed']}"
              + (f" / ⚠️ 未采到 {cv['n_model_missing']} 题" if cv["n_model_missing"] else ""))
        # 🔴 harness 版本也是必控变量 —— 印出来,否则「同 harness」只有命令行作证。
        _bc = cv["sid_binary_commit_observed"]
        _bs = cv["sid_binary_sha256_observed"]
        print(f"  真跑二进制(观测): commit {[c[:12] for c in _bc]} / "
              f"sha256 {[h[:12] for h in _bs]}"
              + (f" / 🔴 **{len(_bc)} 个 commit ⇒ 整臂不可比**" if len(_bc) > 1 else "")
              + (f" / ⚠️ 未采到 {cv['n_sid_binary_missing']} 题"
                 if cv["n_sid_binary_missing"] else ""))
        t = a["tokens_normalized"]
        if t:
            print(f"  token(归一): fresh {t['fresh']:,} / cache_r {t['cache_read']:,} / "
                  f"cache_w {t['cache_write']:,} / out {t['out']:,}")
            print(f"               缓存命中 {t['hit_ratio'] * 100:.1f}%  "
                  f"({t['n_with_tokens']}/{t['n_trials']} 题可拆, src={t['source']})")
        else:
            print("  ⚠️ token 一题都拆不出 —— 归一化失败,别引用任何 token 数")
        for cv in a["caveats"]:
            print(f"  ⚠️ {cv}")

    if "paired" in doc:
        p = doc["paired"]
        print(f"\n{'=' * 78}\n### 配对对照(公共干净子集)\n{'=' * 78}")
        if "error" in p:
            print(f"  ⛔ {p['error']}")
        else:
            print(f"  n={p['n_paired']}(退出 {p['n_dropped']} 对)")
            print(f"  {p['arm_a']['arm']:<5} {p['a_p'] * 100:>5.1f}%  "
                  f"95% [{p['a_ci'][0] * 100:.1f}, {p['a_ci'][1] * 100:.1f}]")
            print(f"  {p['arm_b']['arm']:<5} {p['b_p'] * 100:>5.1f}%  "
                  f"95% [{p['b_ci'][0] * 100:.1f}, {p['b_ci'][1] * 100:.1f}]")
            print(f"  仅 A 解出: {p['a_only_solved']}")
            print(f"  仅 B 解出: {p['b_only_solved']}")
            print(f"  ⇒ {p['verdict']}")
            print(f"  ⚠️ {p['note']}")

    if args.out_dir:
        os.makedirs(args.out_dir, exist_ok=True)
        name = "__".join(a["job"] for a in arms) + ".json"
        path = os.path.join(args.out_dir, name)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=2, sort_keys=False)
            fh.write("\n")
        size = os.path.getsize(path)
        print(f"\n✅ 已归档 {path} ({size:,} bytes)")
        print("   ⚠️ `runs/` 不入库 ⇒ **这份 JSON 是唯一能进版本库的那一份**,记得 commit。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
