#!/usr/bin/env python3
r"""把一次 k 轮基线（逐轮逐档的 harbor run 目录）冻结成 `eval-verdict.py --baseline` 要的文档。

用法（入库的 `baselines/traj-bench-v0.2.1.json` 由这条命令生成，完整参数见该文件 provenance）:

    python3 build-l2-baseline.py \
        --round <第 1 轮 t1800 run> <第 1 轮 t2700 run> \
        --round <第 2 轮两档> --round <第 3 轮两档> \
        --declare traj_bench_commit=<基线跑时 traj-bench 的 commit> \
        --declare network_policy=allowlist \
        --relative-to ~/Code/person/agent-traj-bench \
        --expect-stable T0040,T0050,T0059 --expect-m 2 --epsilon 0.10 \
        --frozen-by "T17 2026-11-06" \
        --out baselines/traj-bench-v0.2.1.json

## 为什么要有这个脚本（而不是手拼一份 JSON）

T20 之前判定器只在 `/tmp/l2-dry/` 里吃过一份手拼的基线（Q-H dry-run），
那份文档没有入库、也说不出是怎么来的。发版闸要拿它拦 promote，
它就必须满足 §5.3「结论由脚本从产物复算，不手写数字」。

## 每个量都和当前 run 一侧走同一个函数（这是本文件存在的全部理由）

| 量 | 基线侧（本文件） | 当前侧（`eval-verdict.evaluate`） |
| --- | --- | --- |
| 逐题 reward / 排除 | `trial_outcomes.load_runs` | 同 |
| S / m | `eval_verdict.stable_set` / `min_m` | 同 |
| 单轮成本 | `eval_verdict._current_cost`（逐轮算再取均值） | 同一个函数 |
| 缓存命中率 | `eval_verdict._current_cache`（全部轮次 token 加权） | 同一个函数 |
| 指纹 | `run_fingerprint.collect` | 同 |

⚠️ 两侧口径只要差一点，「成本上涨 > 30%」「缓存下降 > 10pp」两条 WARN
就会整体平移 —— 那不是回归，是尺子换了。所以这里刻意 import
`eval-verdict.py` 的私有函数，而不是自己再写一份。

## 三道自证（任一不过就拒绝写出，退出码 2）

1. 同一档跨轮的指纹必须 `VALID`（不豁免任何字段：基线内部连二进制都必须相同）。
2. 复算出的 S / m 必须与 `--expect-stable` / `--expect-m` 一致（冻结值在方案 §5.2）。
3. 写出的文档必须过 `eval_verdict.validate_baseline`（判定器自己的入口校验）。

⛔ `--expect-*` 只用来对账，不是参数。想换 S 就是重建基线。
⛔ 不读 `trials.json`：当前侧读的是 run 目录，基线侧也只读 run 目录（同源）。
   代价是生成时 run 目录必须在本机（T15 约 1.2G，未入库）。
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys
from fractions import Fraction
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import run_fingerprint  # noqa: E402
import trial_outcomes as O  # noqa: E402


def _load_verdict_module():
    """`eval-verdict.py` 文件名带连字符，只能按路径加载。"""
    path = os.path.join(HERE, "eval-verdict.py")
    spec = importlib.util.spec_from_file_location("eval_verdict", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


V = _load_verdict_module()

#: 文档格式版本：与判定器的 `BASELINE_SCHEMA_VERSION` 同源，不另立。
SCHEMA_VERSION = V.BASELINE_SCHEMA_VERSION


def _rel(path: str, root: str | None) -> str:
    """run_dir 去掉本机前缀（与 traj-bench 入库 trials.json 的做法一致）。"""
    ap = os.path.abspath(path)
    if root:
        r = os.path.abspath(os.path.expanduser(root))
        if ap == r or ap.startswith(r + os.sep):
            return os.path.relpath(ap, r)
    return ap


def _tier_key(fp: dict[str, Any]) -> str:
    """分档 = `max_duration_ms`（t15-baseline.py 的 DURATION_BY_TIMEOUT 取值）。"""
    fields = fp.get("fields") or {}
    return str(fields.get("max_duration_ms"))


def _fingerprints(rounds: list[list[str]], declared: dict[str, str]) -> tuple[list[dict[str, Any]], list[str]]:
    """逐轮逐档采指纹；同档跨轮必须 VALID（**不豁免任何字段**）。→ (第 1 轮各档, 问题)。"""
    problems: list[str] = []
    per_round: list[list[dict[str, Any]]] = []
    for r, dirs in enumerate(rounds, 1):
        fps = []
        for d in dirs:
            fp = run_fingerprint.collect(d, declared)
            if fp.get("n_trials") == 0:
                problems.append(f"第 {r} 轮 {d} 下没有 trial")
            fps.append(fp)
        per_round.append(fps)
    tiers0 = sorted(per_round[0], key=_tier_key) if per_round else []
    keys0 = [_tier_key(f) for f in tiers0]
    if len(set(keys0)) != len(keys0):
        problems.append(f"第 1 轮内有两个 run 的 max_duration_ms 相同 {keys0} —— 分不出档")
    for r, fps in enumerate(per_round[1:], 2):
        by_key = {_tier_key(f): f for f in fps}
        if sorted(by_key) != sorted(keys0):
            problems.append(f"第 {r} 轮的分档 {sorted(by_key)} 与第 1 轮 {sorted(keys0)} 不一致")
            continue
        for base in tiers0:
            cmp = run_fingerprint.compare(base, by_key[_tier_key(base)])
            if cmp["verdict"] != "VALID":
                problems.append(
                    f"第 {r} 轮 max_duration_ms={_tier_key(base)} 档与第 1 轮指纹 {cmp['verdict']}："
                    f"字段 {cmp['differing_fields']}；两边都没采到 {cmp['both_missing']}"
                )
    return tiers0, problems


def _per_task(rounds: list[list[str]]) -> tuple[dict[str, list[float]], dict[str, list[str]], list[str]]:
    """逐题逐轮 reward（与当前侧同一个取数函数）。→ (per_task, 被排除的样本, 问题)。"""
    per_task: dict[str, list[float]] = {}
    excluded: dict[str, list[str]] = {}
    problems: list[str] = []
    round_tasks: list[set[str]] = []
    for r, dirs in enumerate(rounds, 1):
        outcomes = O.load_runs(dirs)
        round_tasks.append(set(outcomes))
        for task, o in sorted(outcomes.items()):
            if o.excluded or o.reward is None:
                # 排除样本不进分母（与当前侧一致），但留痕：哪一轮、什么原因
                excluded.setdefault(task, []).append(f"R{r}:{o.excluded or '无reward'}")
                continue
            per_task.setdefault(task, []).append(float(o.reward))
    all_tasks: set[str] = set().union(*round_tasks) if round_tasks else set()
    for r, ts in enumerate(round_tasks, 1):
        if ts != all_tasks:
            problems.append(f"第 {r} 轮少了 {sorted(all_tasks - ts)} —— 各轮题集必须相同")
    return per_task, excluded, problems


def build(
    rounds: list[list[str]],
    declared: dict[str, str],
    *,
    epsilon: str,
    relative_to: str | None = None,
    frozen_by: str = "",
) -> tuple[dict[str, Any], list[str]]:
    """→ (基线文档, 问题清单)。问题非空时调用方必须拒绝写出。"""
    problems: list[str] = []
    if len(rounds) < 2:
        problems.append(f"只有 {len(rounds)} 轮 —— 至少两轮才谈得上「k 次全过」（§5.2）")

    tiers0, fp_problems = _fingerprints(rounds, declared)
    problems.extend(fp_problems)
    per_task, excluded, task_problems = _per_task(rounds)
    problems.extend(task_problems)
    # 每一轮都被排除的题进 infra_fault（不进 per_task：判定器要求两者互斥）
    infra_fault = {t: "; ".join(v) for t, v in sorted(excluded.items()) if t not in per_task}

    s = V.stable_set(per_task)
    eps = Fraction(str(epsilon))
    m = V.min_m(len(s), eps)

    # 成本逐轮算（判定器比的是「单轮」），缓存全部轮次 token 加权
    per_round_usd: list[float] = []
    missing_cost = 0
    all_dirs: list[str] = []
    for dirs in rounds:
        total, _with, without = V._current_cost(O.load_runs(dirs), dirs)
        per_round_usd.append(round(total, 6))
        missing_cost += without
        all_dirs.extend(dirs)
    if missing_cost:
        # 缺成本的题当 0 会让基线偏低 ⇒ 之后每个当前 run 都像「涨价」。宁可拒绝。
        problems.append(f"有 {missing_cost} 个 trial 缺 cost_usd —— 基线成本会被低估，拒绝冻结")
    # ⚠️ 合并多轮时 load_runs 是「后者覆盖前者」，排除状态只认最后一轮：
    # 只在某一轮被排除的题，它在其余轮里的 token 会跟着最后一轮的状态一起算或一起丢。
    # T15 三轮 trial_outcomes 排除数都是 0（2026-11-07 实测），这条在 T15 上不影响取值。
    cache = V._current_cache(O.load_runs(all_dirs), all_dirs)

    tier_docs = []
    for fp in tiers0:
        tier = dict(fp)
        tier["run_dir"] = _rel(fp["run_dir"], relative_to)
        tier_docs.append(tier)

    per_run = round(sum(per_round_usd) / len(per_round_usd), 6) if per_round_usd else None
    doc: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "fingerprints": tier_docs,
        "per_task": dict(sorted(per_task.items())),
        "infra_fault": infra_fault,
        "noise": {"stable_set": s, "epsilon": float(eps), "m": m},
        "cost": {
            "per_run_usd": per_run,
            "total_usd": round(sum(per_round_usd), 6),
            "per_round_usd": per_round_usd,
        },
        "cache": {"hit_rate_by_family": cache} if cache else dict(),
        "provenance": {
            "built_by": "evals/external-benchmarks/harbor/build-l2-baseline.py",
            "frozen_by": frozen_by,
            "k": len(rounds),
            "rounds": [[_rel(d, relative_to) for d in dirs] for dirs in rounds],
            "excluded_samples": dict(sorted(excluded.items())),
            "declared": dict(sorted(declared.items())),
        },
    }
    problems.extend(f"判定器拒收：{p}" for p in V.validate_baseline(doc))
    return doc, problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="把 k 轮基线 run 冻结成 L2 判定器的基线文档")
    ap.add_argument(
        "--round",
        action="append",
        nargs="+",
        required=True,
        metavar="RUN_DIR",
        help="一轮的全部档 run 目录（可重复，一次一轮）",
    )
    ap.add_argument("--declare", action="append", default=[], metavar="KEY=VALUE")
    ap.add_argument("--epsilon", default="0.10", help="§5.2：max(样本外实测, 0.10)")
    ap.add_argument("--expect-stable", required=True, help="冻结的 S（逗号分隔），只用于对账")
    ap.add_argument("--expect-m", required=True, type=int, help="冻结的 m，只用于对账")
    ap.add_argument("--relative-to", default=None, help="run_dir 去掉这个前缀后入库")
    ap.add_argument("--frozen-by", default="", help="冻结出处（例如「T17 2026-11-06」）")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)

    declared = run_fingerprint._parse_declared(a.declare)
    doc, problems = build(
        a.round, declared, epsilon=a.epsilon, relative_to=a.relative_to, frozen_by=a.frozen_by
    )
    want_s = sorted(x for x in a.expect_stable.split(",") if x)
    if doc["noise"]["stable_set"] != want_s:
        problems.append(f"复算 S={doc['noise']['stable_set']}，冻结值 {want_s} —— 对不上")
    if doc["noise"]["m"] != a.expect_m:
        problems.append(f"复算 m={doc['noise']['m']}，冻结值 {a.expect_m} —— 对不上")
    if problems:
        print("⛔ 拒绝冻结：", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 2
    text = json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write(text)
    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    print(
        f"✅ 基线已写出 {a.out}（sha256 {sha[:12]}…）："
        f"{len(doc['per_task'])} 题 × k={doc['provenance']['k']}，S={doc['noise']['stable_set']}，"
        f"m={doc['noise']['m']}，单轮成本 ${doc['cost']['per_run_usd']}，缓存 {doc['cache']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
