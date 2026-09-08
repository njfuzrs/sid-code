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
            "maxed": (turns is not None and turns >= MAX_TURNS),
            "subtype": subtype,
            "self_reported_success": selfrep,
            "permission_denials": deny,
            "permission_allows": allow,
            # 🔴 必控变量的**观测证据**:两侧都不取 config.agent.model_name(意图)。
            # 没有这一格,「A2 vs A3 同模型」就只有命令行作证 —— 而本仓三个已实测
            # 的坑全是「传了但没生效且不报错」。
            "model_observed": model,
            "provider_observed": provider,
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

    maxed = [r["task"] for r in rows if r["maxed"]]
    selfreps = [r["task"] for r in rows if r["self_reported_success"]]
    ttfts = [r["cc_ttft_ms"] for r in rows if isinstance(r["cc_ttft_ms"], int)]
    undercount = [r["task"] for r in rows if r["token_undercount_suspected"]]
    # 🔴 必控变量:观测到的模型必须**唯一**。多于一个 ⇒ 这一臂内部混了模型,
    # 而那会让整条臂的成本/token 失去共同口径(⛔ 不是"取第一个"能解决的)。
    models = sorted({r["model_observed"] for r in rows if r["model_observed"]})
    providers = sorted({r["provider_observed"] for r in rows if r["provider_observed"]})
    n_model_missing = sum(1 for r in rows if not r["model_observed"])

    caveats = [
        "分母:引用 pass 率必须带 n=scored,⛔ 别拿 72 当分母。",
        "token:两臂 n_input_tokens 语义相反(cc 含 cache、sid 不含),"
        "本文件的 tokens 已按 arm_health.normalized_tokens 归一 —— "
        "⛔ 别回去直接比 result.json 里的 n_input_tokens。",
    ]
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
    if maxed:
        caveats.append(
            f"撞满 {MAX_TURNS} 轮 {len(maxed)} 题 ⇒ ⛔ 别把这些 0 分读成「能力不行」,"
            "它们是用完预算(#138 轮数预算)。"
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
        },
        "ci": ci,
        "failure_mix": {
            "passed": k,
            "failed_capability": n - k,
            "excluded_non_capability": len(excluded),
            "maxed_turns": len(maxed),
            "maxed_turns_tasks": maxed,
            "self_reported_success_but_zero": selfreps,
        },
        "cost_usd": {
            "total": round(sum(costs), 6) if costs else None,
            "n_with_cost": len(costs),
            "n_trials": len(rows),
            "note": "⛔ None 未按 0 计入 —— 那会低报(见 sid_code_agent 的 traj 兜底注释)",
        },
        "controlled_variables": {
            "model_observed": models,
            "provider_observed": providers,
            "n_model_missing": n_model_missing,
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
