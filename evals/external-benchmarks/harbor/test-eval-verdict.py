#!/usr/bin/env python3
"""eval-verdict.py 的正向断言 + P2 验收的 6 组人造产物 + 变异自证。

跑法: python3 test-eval-verdict.py

## 本文件的中心判据（方案 T12 的完成判据）

> **P2 验收里的 6 组人造产物全部判对**
> （`REGRESSION` / `WARN` / 两种 `INVALID` / `PASS` / 降级拦截）

⚠️ 只断言「某组数据得到某结论」是不够的：那只能证明有分支会返回这个字符串，
分不清「判据真的按 §5.2 算」与「所有失败都落到同一个分支」。所以每组都同时断言
**中间量**（S′ 的题数、m′、失败题清单、配对翻转数）—— 结论对了但中间量错，
说明它是碰巧对的。

## 变异自证（`evals/CLAUDE.md` §4.3）

最后一组在 **tmpdir 的源码副本**上把判据改坏（不动真源文件），断言判定翻转。
覆盖四类：删掉被测的那一行 / 加一个「下一个」同类项 / 抠出空集 / 语法整体坏掉。

⚠️ 判据是**红的是哪一条**，不是「有东西红了」。
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
import tempfile
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import run_fingerprint as R  # noqa: E402


def _load_module(name: str, path: str):
    """按路径加载模块。`eval-verdict.py` 文件名带连字符，`import` 语句加载不了。"""
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


V = _load_module("eval_verdict", os.path.join(HERE, "eval-verdict.py"))

PASS = FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name}  {detail}")


# ─────────────────────────────────────────────────── fixture：造 Harbor 产物


DECLARED = {"traj_bench_commit": "bench-commit-abc", "network_policy": "allowlist"}


def _write(path: str, doc: object) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False)


def make_run(
    root: str,
    rewards: dict[str, float | None],
    *,
    model: str = "anthropic/claude-sonnet-5",
    sha: str = "a" * 64,
    commit: str = "c" * 40,
    harbor: str = "0.22.0",
    arch: str = "arm64",
    max_turns: int = 120,
    budget: str = "1.8",
    perm: str = "dangerously-skip-permissions",
    stall: str = "off",
    cost: float | None = 0.5,
    digests: dict[str, str] | None = None,
    no_startup: set[str] | None = None,
    cache: bool = False,
) -> str:
    """造一个结构上等同 Harbor job 目录的 fixture。

    `rewards=None` 表示这一题有 reward 但没值（→ `无reward`）。
    `no_startup` 里的题不写 `[PERF] startup`（→ `启动未完成`）。
    `cache=True` 时给每题补上 sid 臂拆 token 所需的三处落点。
    """
    os.makedirs(root, exist_ok=True)
    tasks = sorted(rewards)
    _write(
        os.path.join(root, "config.json"),
        {
            # detect_arm 只信这一格（⛔ 不看目录名）
            "agent": {"name": "sid_code_agent:SidCodeAgent"},
            "agents": [{"model_name": model}],
        },
    )
    _write(
        os.path.join(root, "lock.json"),
        {
            "harbor": {"version": harbor, "is_editable": False},
            "trials": [
                {"task": {"name": t, "digest": (digests or {}).get(t, f"sha256:{t}")}}
                for t in tasks
            ],
        },
    )
    no_startup = no_startup or set()
    for i, task in enumerate(tasks):
        td = os.path.join(root, f"{task}__abc{i}")
        reward = rewards[task]
        # ⚠️ trial 级也要一份：arm_health.detect_arm() 判臂读的是 <trial>/config.json，
        # 不是 run 根那份。缺了它 normalized_tokens 直接返回 None（缓存判据会静默失效）。
        _write(
            os.path.join(td, "config.json"),
            {"agent": {"name": "sid_code_agent:SidCodeAgent"}},
        )
        _write(
            os.path.join(td, "result.json"),
            {
                "verifier_result": {"rewards": {"reward": reward}},
                "agent_result": {
                    "n_input_tokens": 1000,
                    "n_output_tokens": 100,
                    "cost_usd": cost,
                    "metadata": {
                        "sid_binary_sha256": sha,
                        "sid_commit": commit,
                        "sid_permission_mode_requested": perm,
                        "sid_stall_escalation": stall,
                        "sid_max_turns": max_turns,
                        "sid_max_budget_usd": budget,
                        "sid_max_duration_ms": "7290000",
                    },
                },
                "started_at": "2026-11-05T00:00:00Z",
                "finished_at": "2026-11-05T00:10:00Z",
            },
        )
        # verifier_ran 的判据：stdout 里有 pytest 结论行
        _write_text(os.path.join(td, "verifier", "stdout.txt"), "1 passed in 0.10s\n")
        # ⚠️ 必须写这个文件：不写时 agent_started 返回 **None**（不可判），
        # 而不是 False（启动未完成）—— 两者在排除判据里处置完全不同。
        _write_text(
            os.path.join(td, "agent", "sid-home", "debug.log"),
            "[PERF] startup\n[APP] 开始初始化\n"
            if task not in no_startup
            else "[SKILL] 加载了 8 个 Skill\n",
        )
        _write(os.path.join(td, "agent", "sid-code-build.json"), {"arch_actual": arch})
        if cache:
            # sid 臂拆 token 的三处落点（缺一处 normalized_tokens 就返回 None）
            _write(
                os.path.join(td, "agent", "sid-home", "settings.json"),
                {"availableModels": [{"modelId": "claude-sonnet-5", "provider": "anthropic"}]},
            )
            result_path = os.path.join(td, "result.json")
            doc = json.load(open(result_path, encoding="utf-8"))
            doc["agent_result"]["n_cache_tokens"] = 800
            doc["agent_result"]["metadata"]["cache_write_tokens"] = 100
            _write(result_path, doc)
    return root


def _write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def make_baseline(
    root: str,
    per_task: dict[str, list[float]],
    *,
    infra: dict[str, str] | None = None,
    epsilon: float | None = 0.10,
    m: int | None = None,
    cost_usd: float | None = None,
    cost_per_run: float | None = None,
    cache_by_family: dict[str, float] | None = None,
    declare_s: list[str] | None = None,
    **run_kwargs,
) -> dict:
    """造一份基线文档。指纹由一个结构相同的 run 采集（含 infra 题，与真实 k=3 一致）。

    ⚠️ 基线指纹的题集必须**含 infra 故障题**：真实基线是一整次运行，
    那些题跑了但被排除，它们仍在 `lock.json` 里。少了它们，current 的
    `taskset_digest` 会与基线不同，指纹先判 INVALID —— 那是另一条路径，
    会把要测的判据挡在后面。
    """
    base_tasks = sorted(set(per_task) | set(infra or {}))
    fp_run = make_run(
        os.path.join(root, "baseline-run"),
        {t: 1.0 for t in base_tasks},
        **run_kwargs,
    )
    fp = R.collect(fp_run, DECLARED)
    doc: dict = {
        "schema_version": 1,
        "fingerprint": fp,
        "per_task": per_task,
        "infra_fault": dict(infra or {}),
        "noise": {},
        "cost": {},
        "cache": {},
    }
    if epsilon is not None:
        doc["noise"]["epsilon"] = epsilon
    if m is not None:
        doc["noise"]["m"] = m
    doc["noise"]["stable_set"] = (
        declare_s if declare_s is not None else V.stable_set(per_task)
    )
    if cost_per_run is not None:
        doc["cost"]["per_run_usd"] = cost_per_run
    if cost_usd is not None:
        doc["cost"]["total_usd"] = cost_usd
    if cache_by_family is not None:
        doc["cache"]["hit_rate_by_family"] = cache_by_family
    return doc


def make_current(
    root: str,
    rewards: dict[str, float | None],
    *,
    name: str = "current",
    **run_kwargs,
) -> str:
    return make_run(os.path.join(root, name), rewards, **run_kwargs)


def _verdict(baseline: dict, run_dirs: list[str], **kwargs) -> dict:
    # 真实调用方（T20 的 release-gate.sh）会传 declared；测试也传同一份，
    # 否则 network_policy / traj_bench_commit 会单边缺失 → 指纹 INVALID，
    # 把要测的判据挡在后面。
    kwargs.setdefault("declared", DECLARED)
    return V.evaluate(baseline, run_dirs, **kwargs)


# ───────────────────────────────────────────────── ① m 表与 McNemar 对账


def test_m_table() -> None:
    """§5.2 的 m 表 15 格 + 5 个检出概率，逐格对账。

    这张表由 T13 的 `eval-stats.py` 生成（agent-traj-bench PR #10），
    此处是 sid-code 侧的第二份实现 —— 两份实现靠同一张文档表对账。
    """
    print("\n=== ① m 表与 McNemar 对账（§5.2 / T13 冻结值）===")
    doc_m = {
        (6, "0.05"): 2,
        (6, "0.10"): 3,
        (6, "0.15"): 3,
        (8, "0.05"): 3,
        (8, "0.10"): 3,
        (8, "0.15"): 4,
        (10, "0.05"): 3,
        (10, "0.10"): 4,
        (10, "0.15"): 4,
        (12, "0.05"): 3,
        (12, "0.10"): 4,
        (12, "0.15"): 5,
        (14, "0.05"): 3,
        (14, "0.10"): 4,
        (14, "0.15"): 5,
    }
    for (size, eps), expected in sorted(doc_m.items()):
        got = V.min_m(size, Fraction(eps))
        check(f"|S|={size} ε={eps} → m={expected}", got == expected, f"得到 {got}")

    # 检出概率：ε=0.10，退化后单题失败率 0.5
    doc_power = {6: 0.66, 8: 0.86, 10: 0.83, 12: 0.93, 14: 0.97}
    for size, expected in sorted(doc_power.items()):
        m = V.min_m(size, Fraction("0.10"))
        power = float(V.binomial_tail(size, m, Fraction(1, 2)))
        check(
            f"|S|={size} 检出概率 ≈{expected:.0%}",
            abs(power - expected) < 0.01,
            f"得到 {power:.4f}",
        )

    # 边界：|S|=10 ε=0.15 的 P(X≥4)=0.04997，离 5% 只有 3e-5
    p = V.binomial_tail(10, 4, Fraction("0.15"))
    check(
        "边界 P(X≥4 | n=10, ε=0.15) = 0.04997 且 ≤ 0.05",
        Fraction("0.0499") < p < Fraction("0.05"),
        f"得到 {float(p):.8f}",
    )
    # 空集与超额
    check("|S|=0 → min_m 返回 None（不是 0）", V.min_m(0, Fraction("0.1")) is None)
    check("P(X≥0)=1", V.binomial_tail(10, 0, Fraction("0.1")) == 1)
    check("P(X≥n+1)=0", V.binomial_tail(10, 11, Fraction("0.1")) == 0)


def test_mcnemar() -> None:
    print("\n=== ①b McNemar 单侧 p ===")
    # 单侧只问「回退是否显著多于进步」⇒ 进步多时 p 接近 1（不是 1/2^n）。
    check("无翻转 → p=1", V.mcnemar_one_sided_p(0, 0) == 1)
    check("up=5 down=0（全是进步）→ p=1", V.mcnemar_one_sided_p(5, 0) == 1)
    check("up=0 down=5（全是回退）→ p=1/32", V.mcnemar_one_sided_p(0, 5) == Fraction(1, 32))
    check("up=0 down=6 → p=1/64 < 0.05", V.mcnemar_one_sided_p(0, 6) < V.ALPHA)
    check("up=6 down=0（全是进步）→ p=1，不显著",
          V.mcnemar_one_sided_p(6, 0) == 1)
    check("up=5 down=1 → p>0.05", V.mcnemar_one_sided_p(5, 1) > V.ALPHA)


# ───────────────────────────────────────────── ② P2 验收的 6 组人造产物


def _s8_baseline(root: str, **kwargs) -> dict:
    """|S|=8 的基线：T01–T08 全过，T09/T10 全 0。m=3（ε=0.10）。"""
    per_task = {f"T{i:02d}": [1.0, 1.0, 1.0] for i in range(1, 9)}
    per_task.update({f"T{i:02d}": [0.0, 0.0, 0.0] for i in range(9, 11)})
    return make_baseline(root, per_task, **kwargs)


def test_six_acceptance_cases() -> None:
    """P2 验收里写死的 6 组人造产物。"""
    print("\n=== ② P2 验收 6 组人造产物 ===")
    with tempfile.TemporaryDirectory() as tmp:
        # ① S 中 m=3 题失败 → REGRESSION
        base = _s8_baseline(os.path.join(tmp, "a"))
        rewards = {f"T{i:02d}": (0.0 if i in (1, 2, 3) else 1.0) for i in range(1, 9)}
        rewards.update({f"T{i:02d}": 0.0 for i in range(9, 11)})
        cur = make_current(os.path.join(tmp, "a"), rewards)
        doc = _verdict(base, [cur])
        check("① m 题失败 → REGRESSION", doc["verdict"] == "REGRESSION", doc["verdict"])
        check("  |S′|=8、m′=3、失败 3 题", doc["stable_set"]["n_prime"] == 8
              and doc["noise"]["m_prime"] == 3
              and len(doc["stable_set"]["failed"]) == 3,
              str(doc["stable_set"]))

        # ② S 中 m−1=2 题失败 → WARN
        with tempfile.TemporaryDirectory() as t2:
            base = _s8_baseline(t2)
            rewards = {f"T{i:02d}": (0.0 if i in (1, 2) else 1.0) for i in range(1, 9)}
            rewards.update({f"T{i:02d}": 0.0 for i in range(9, 11)})
            cur = make_current(t2, rewards)
            doc = _verdict(base, [cur])
            check("② m−1 题失败 → WARN", doc["verdict"] == "WARN", doc["verdict"])
            check("  失败 2 题 < m′=3", len(doc["stable_set"]["failed"]) == 2)
            check(
                "  WARN 理由同时含「S′ 失败」与「净回退」",
                any("S′" in w for w in doc["warn_signals"])
                and any("净回退" in w for w in doc["warn_signals"]),
                str(doc["warn_signals"]),
            )

        # ③ 指纹不同 → INVALID
        with tempfile.TemporaryDirectory() as t3:
            base = _s8_baseline(t3)
            rewards = {f"T{i:02d}": 1.0 for i in range(1, 11)}
            cur = make_current(t3, rewards, sha="b" * 64)
            doc = _verdict(base, [cur])
            check("③ 指纹不同 → INVALID", doc["verdict"] == "INVALID", doc["verdict"])
            check(
                "  点名 sid_binary_sha256", "sid_binary_sha256" in doc["fingerprint"]["differing_fields"],
                str(doc["fingerprint"]),
            )
            check(
                "  invalid_reasons 提到指纹",
                any("指纹" in r for r in doc["invalid_reasons"]),
                str(doc["invalid_reasons"]),
            )

        # ④ 一题尚未跑 → INVALID
        with tempfile.TemporaryDirectory() as t4:
            base = _s8_baseline(t4)
            rewards = {f"T{i:02d}": 1.0 for i in range(1, 9)}  # 少了 T09/T10
            cur = make_current(t4, rewards)
            doc = _verdict(base, [cur])
            check("④ 一题未跑 → INVALID", doc["verdict"] == "INVALID", doc["verdict"])
            check(
                "  invalid_reasons 点名「尚未跑」",
                any("尚未跑" in r for r in doc["invalid_reasons"]),
                str(doc["invalid_reasons"]),
            )

        # ⑤ 与基线完全相同 → PASS
        with tempfile.TemporaryDirectory() as t5:
            base = _s8_baseline(t5)
            rewards = {f"T{i:02d}": 1.0 for i in range(1, 9)}
            rewards.update({f"T{i:02d}": 0.0 for i in range(9, 11)})
            cur = make_current(t5, rewards)
            doc = _verdict(base, [cur])
            check("⑤ 与基线完全相同 → PASS", doc["verdict"] == "PASS", doc["verdict"])
            check("  无失败、无翻转", not doc["stable_set"]["failed"]
                  and doc["paired"]["up"] == 0 and doc["paired"]["down"] == 0)

        # ⑥ |S|=5 的基线 + S 全部失败 → 降级拦截
        with tempfile.TemporaryDirectory() as t6:
            per_task = {f"T{i:02d}": [1.0, 1.0, 1.0] for i in range(1, 6)}
            per_task.update({f"T{i:02d}": [0.0, 0.0, 0.0] for i in range(6, 9)})
            base = make_baseline(t6, per_task)
            rewards = {f"T{i:02d}": 0.0 for i in range(1, 9)}
            cur = make_current(t6, rewards)
            doc = _verdict(base, [cur])
            check("⑥ |S|=5 + 全失败 → 降级拦截（REGRESSION）",
                  doc["verdict"] == "REGRESSION", doc["verdict"])
            check("  degraded=True", doc["degraded"] is True)
            check("  通过率 0/5 = 0% < 50%",
                  any("降级兜底" in r for r in doc["reasons"]), str(doc["reasons"]))


def test_degraded_not_blocking() -> None:
    """降级模式下通过率 ≥ 50% → 不阻断（但 S′ 有失败仍需 WARN）。"""
    print("\n=== ②b 降级模式：通过率 ≥ 50% 不拦截 ===")
    with tempfile.TemporaryDirectory() as tmp:
        per_task = {f"T{i:02d}": [1.0, 1.0, 1.0] for i in range(1, 6)}
        per_task.update({f"T{i:02d}": [0.0, 0.0, 0.0] for i in range(6, 9)})
        base = make_baseline(tmp, per_task)
        # S 的 5 题：3 过 2 败 → 60%
        rewards = {f"T{i:02d}": (0.0 if i in (1, 2) else 1.0) for i in range(1, 6)}
        rewards.update({f"T{i:02d}": 0.0 for i in range(6, 9)})
        cur = make_current(tmp, rewards)
        doc = _verdict(base, [cur])
        check("通过率 3/5=60% → 不阻断", doc["verdict"] == "WARN", doc["verdict"])
        check("degraded=True 仍标出", doc["degraded"] is True)
        check("S′ 失败 2 题", len(doc["stable_set"]["failed"]) == 2)


# ───────────────────────────────────────────── ③ 双向缺题与 infra 故障率


def test_bidirectional_task_set() -> None:
    """外部评测缺陷 28 的同一条纪律：new 独有题不许静默丢弃。"""
    print("\n=== ③ 双向题集检查 ===")
    with tempfile.TemporaryDirectory() as tmp:
        base = _s8_baseline(tmp)
        rewards = {f"T{i:02d}": 1.0 for i in range(1, 11)}
        rewards["T99"] = 0.0  # 只在 current 侧
        cur = make_current(tmp, rewards)
        doc = _verdict(base, [cur])
        check("current 多出题 → INVALID", doc["verdict"] == "INVALID", doc["verdict"])
        check(
            "  点名「不在基线题集里」且列出 T99",
            any("不在基线题集里" in r and "T99" in r for r in doc["invalid_reasons"]),
            str(doc["invalid_reasons"]),
        )


def test_infra_ratio() -> None:
    print("\n=== ③b infra 故障率 > 10% → INVALID ===")
    with tempfile.TemporaryDirectory() as tmp:
        per_task = {f"T{i:02d}": [1.0, 1.0, 1.0] for i in range(1, 33)}
        base = make_baseline(tmp, per_task)
        # 32 题里 4 题 verifier 未判分 = 12.5% > 10%
        rewards = {f"T{i:02d}": 1.0 for i in range(1, 33)}
        cur = make_current(tmp, rewards, no_startup={f"T{i:02d}" for i in range(1, 5)})
        # no_startup 造的是「启动未完成」；用 verifier 侧再验一遍更贴 infra 定义
        doc = _verdict(base, [cur])
        check("4/32 故障 → INVALID", doc["verdict"] == "INVALID", doc["verdict"])
        check(
            "  infra.ratio ≈ 0.125",
            abs(doc["infra"]["ratio"] - 0.125) < 1e-9,
            str(doc["infra"]["ratio"]),
        )
        check(
            "  invalid_reasons 提到故障率",
            any("故障率" in r for r in doc["invalid_reasons"]),
            str(doc["invalid_reasons"]),
        )


def test_infra_exactly_ten_percent_is_ok() -> None:
    """阈值是严格大于：10.0% 不判 INVALID（边界必须精确，浮点比较不能想当然）。"""
    print("\n=== ③c 故障率恰好 10% 不判 INVALID ===")
    with tempfile.TemporaryDirectory() as tmp:
        per_task = {f"T{i:02d}": [1.0, 1.0, 1.0] for i in range(1, 31)}  # 30 题
        base = make_baseline(tmp, per_task)
        rewards = {f"T{i:02d}": 1.0 for i in range(1, 31)}
        cur = make_current(tmp, rewards, no_startup={f"T{i:02d}" for i in range(1, 4)})
        doc = _verdict(base, [cur])
        check("3/30 = 10% → 不是 INVALID", doc["verdict"] != "INVALID", doc["verdict"])
        check("ratio == 0.1", doc["infra"]["ratio"] == 0.1, str(doc["infra"]["ratio"]))


def test_external_block() -> None:
    print("\n=== ③d 外部阻断（预算 / 预检）→ INVALID ===")
    with tempfile.TemporaryDirectory() as tmp:
        base = _s8_baseline(tmp)
        rewards = {f"T{i:02d}": 1.0 for i in range(1, 11)}
        cur = make_current(tmp, rewards)
        doc = _verdict(base, [cur], blocks=["预算账本拒绝：本月已花 $149 + 上限 $40 > $150"])
        check("有 --block → INVALID", doc["verdict"] == "INVALID", doc["verdict"])
        check(
            "  原样保留阻断原因",
            any("预算账本拒绝" in r for r in doc["invalid_reasons"]),
            str(doc["invalid_reasons"]),
        )


# ───────────────────────────────────────────────── ④ 基线自洽性与降级边界


def test_baseline_self_consistency() -> None:
    print("\n=== ④ 基线自洽性 ===")
    with tempfile.TemporaryDirectory() as tmp:
        base = _s8_baseline(tmp)
        # 声明一个比实际小的 S：把 T08 从声明里去掉（实际它是 3/3 全过）
        bad = json.loads(json.dumps(base))
        bad["noise"]["stable_set"] = [t for t in bad["noise"]["stable_set"] if t != "T08"]
        rewards = {f"T{i:02d}": 1.0 for i in range(1, 9)}
        rewards.update({f"T{i:02d}": 0.0 for i in range(9, 11)})
        cur = make_current(tmp, rewards)
        doc = _verdict(bad, [cur])
        check("声明 S 与复算不一致 → INVALID", doc["verdict"] == "INVALID", doc["verdict"])
        check(
            "  点名只在一侧出现的题",
            any("T08" in r and "不一致" in r for r in doc["invalid_reasons"]),
            str(doc["invalid_reasons"]),
        )

    with tempfile.TemporaryDirectory() as tmp:
        base = _s8_baseline(tmp)
        bad = json.loads(json.dumps(base))
        bad["per_task"]["T01"] = [1.0, 0.5, 1.0]  # 非二值
        rewards = {f"T{i:02d}": 1.0 for i in range(1, 11)}
        cur = make_current(tmp, rewards)
        doc = _verdict(bad, [cur])
        check("reward 非二值 → INVALID", doc["verdict"] == "INVALID", doc["verdict"])
        check(
            "  点名非二值题",
            any("非二值" in r and "T01" in r for r in doc["invalid_reasons"]),
            str(doc["invalid_reasons"]),
        )

    with tempfile.TemporaryDirectory() as tmp:
        base = _s8_baseline(tmp)
        bad = json.loads(json.dumps(base))
        bad["schema_version"] = 99
        rewards = {f"T{i:02d}": 1.0 for i in range(1, 11)}
        cur = make_current(tmp, rewards)
        doc = _verdict(bad, [cur])
        check("schema_version 不匹配 → INVALID", doc["verdict"] == "INVALID", doc["verdict"])

    with tempfile.TemporaryDirectory() as tmp:
        base = _s8_baseline(tmp)
        bad = json.loads(json.dumps(base))
        bad["noise"]["m"] = 2  # 真实 m=3
        rewards = {f"T{i:02d}": 1.0 for i in range(1, 11)}
        cur = make_current(tmp, rewards)
        doc = _verdict(bad, [cur])
        check("冻结的 m 与现算不一致 → INVALID", doc["verdict"] == "INVALID", doc["verdict"])
        check(
            "  点名 m 的差",
            any("m=" in r and "不一致" in r for r in doc["invalid_reasons"]),
            str(doc["invalid_reasons"]),
        )


def test_epsilon_default() -> None:
    """基线没给 ε 时按 0.10 取，并且**必须留 caveat**（不能静默用默认值）。"""
    print("\n=== ④b ε 缺省 = 0.10 且留痕 ===")
    with tempfile.TemporaryDirectory() as tmp:
        base = _s8_baseline(tmp, epsilon=None)
        rewards = {f"T{i:02d}": 1.0 for i in range(1, 11)}
        cur = make_current(tmp, rewards)
        doc = _verdict(base, [cur])
        check("缺省 ε 取 0.10", doc["noise"]["epsilon"] == "1/10", doc["noise"])
        check("epsilon_source=defaulted", doc["noise"]["epsilon_source"] == "defaulted")
        check(
            "  有「按 0.10 取」的 caveat",
            any("0.10" in c and "epsilon" in c.lower() for c in doc["caveats"]),
            str(doc["caveats"]),
        )


# ───────────────────────────────────────────── ⑤ WARN 的另外两条信号


def test_cache_and_cost_warn() -> None:
    print("\n=== ⑤ 缓存下降 / 成本上涨 → WARN ===")
    with tempfile.TemporaryDirectory() as tmp:
        base = _s8_baseline(
            tmp,
            cache_by_family={"anthropic": 0.90},
            cost_per_run=10.0,
            cache=True,
        )
        rewards = {f"T{i:02d}": 1.0 for i in range(1, 11)}
        # 当前命中率：cache_read=800 / total_in=(1000+800+100)=1900 ≈ 42.1%
        cur = make_current(tmp, rewards, cache=True, cost=0.5)
        doc = _verdict(base, [cur])
        check("缓存下降 >10pp → WARN", doc["verdict"] == "WARN", doc["verdict"])
        check(
            "  drops 里有 anthropic",
            bool(doc["cache"]["drops"]) and doc["cache"]["drops"][0]["family"] == "anthropic",
            str(doc["cache"]),
        )
        check(
            "  告警含「缓存命中率下降」",
            any("缓存命中率下降" in w for w in doc["warn_signals"]),
            str(doc["warn_signals"]),
        )

    with tempfile.TemporaryDirectory() as tmp:
        base = _s8_baseline(tmp, cost_per_run=1.0)
        rewards = {f"T{i:02d}": 1.0 for i in range(1, 11)}
        # 10 题 × $0.5 = $5.0，基线 $1.0 → 上涨 400%
        cur = make_current(tmp, rewards, cost=0.5)
        doc = _verdict(base, [cur])
        check("成本上涨 >30% → WARN", doc["verdict"] == "WARN", doc["verdict"])
        check(
            "  告警含「总成本上涨」",
            any("总成本上涨" in w for w in doc["warn_signals"]),
            str(doc["warn_signals"]),
        )

    with tempfile.TemporaryDirectory() as tmp:
        base = _s8_baseline(tmp, cost_usd=78.0)  # k=3，只有 total_usd
        rewards = {f"T{i:02d}": 1.0 for i in range(1, 11)}
        cur = make_current(tmp, rewards, cost=0.5)
        doc = _verdict(base, [cur])
        # 78/3 = 26/轮；current=$5 → -80.8%，不触发
        check(
            "total_usd 按 k 折算成单轮（不拿三轮合计比一轮）",
            doc["cost"]["baseline_usd"] == 26.0 and doc["cost"]["baseline_source"] == "total_usd/3",
            str(doc["cost"]),
        )
        check("折算后不误报成本上涨", doc["verdict"] == "PASS", doc["verdict"])


def test_missing_cost_is_not_zero() -> None:
    """成本采不到时**不参与判定**且留 caveat，⛔ 不当 0（那会静默低报）。"""
    print("\n=== ⑤b 成本缺失不按 0 记账 ===")
    with tempfile.TemporaryDirectory() as tmp:
        base = _s8_baseline(tmp, cost_per_run=1.0)
        rewards = {f"T{i:02d}": 1.0 for i in range(1, 11)}
        cur = make_current(tmp, rewards, cost=None)
        doc = _verdict(base, [cur])
        check(
            "全部无成本 → unavailable",
            doc["cost"].get("unavailable") == "当前 run 没有任何一题带成本",
            str(doc["cost"]),
        )
        check(
            "  有 caveat 说明不是 0 元",
            any("0 元" in c or "没有任何一题带成本" in c for c in doc["caveats"]),
            str(doc["caveats"]),
        )


# ───────────────────────────────────────────────────────────── ⑥ 变异自证


def _copy_sources(dest: str) -> None:
    for name in (
        "eval-verdict.py",
        "run_fingerprint.py",
        "trial_outcomes.py",
        "verifier_health.py",
        "taskset_fp.py",
        "arm_health.py",
    ):
        shutil.copyfile(os.path.join(HERE, name), os.path.join(dest, name))


def _load_from(dest: str):
    path = os.path.join(dest, "eval-verdict.py")
    spec = importlib.util.spec_from_file_location("eval_verdict_mut", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _mutate(dest: str, old: str, new: str) -> None:
    path = os.path.join(dest, "eval-verdict.py")
    text = open(path, encoding="utf-8").read()
    assert old in text, f"变异锚点不存在: {old!r}"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text.replace(old, new, 1))


def test_mutations() -> None:
    """四类变异：删一行 / 加一个同类项 / 抠成空集 / 语法坏掉。

    判据是**红的是哪一条**（`evals/CLAUDE.md` §4.3），所以每个变异都断言
    「原本通过的那个场景翻转」，而不是「有异常」。
    """
    print("\n=== ⑥ 变异自证（tmpdir 源码副本，不动真源文件）===")
    rewards_pass = {f"T{i:02d}": 1.0 for i in range(1, 9)}
    rewards_pass.update({f"T{i:02d}": 0.0 for i in range(9, 11)})

    # 基线 fixture 与 run 只需造一次，变异只改判据
    with tempfile.TemporaryDirectory() as tmp:
        base = _s8_baseline(os.path.join(tmp, "fx"))
        cur = make_current(os.path.join(tmp, "fx"), rewards_pass)
        ref = _verdict(base, [cur])
        check("未变异：与基线相同 → PASS", ref["verdict"] == "PASS", ref["verdict"])

        # 变异 1：删掉被测的那一行 —— 把 REGRESSION 分支的条件改成恒假
        d1 = os.path.join(tmp, "m1")
        os.makedirs(d1)
        _copy_sources(d1)
        _mutate(d1, "if n_fail >= m:", "if False:  # 删掉被测的那一行")
        m1 = _load_from(d1)
        r1 = m1.evaluate(base, [cur])
        check("变异 1（删 REGRESSION 判据）→ 不再是 PASS", r1["verdict"] != "PASS", r1["verdict"])

        # 变异 2：加一个「下一个」同类项 —— 把 |S′| 下限从 6 改到 5
        d2 = os.path.join(tmp, "m2")
        os.makedirs(d2)
        _copy_sources(d2)
        _mutate(d2, "MIN_STABLE_FOR_BLOCKING = 6", "MIN_STABLE_FOR_BLOCKING = 5")
        m2 = _load_from(d2)
        with tempfile.TemporaryDirectory() as t2:
            per_task = {f"T{i:02d}": [1.0, 1.0, 1.0] for i in range(1, 6)}
            per_task.update({f"T{i:02d}": [0.0, 0.0, 0.0] for i in range(6, 9)})
            base5 = make_baseline(t2, per_task)
            r2 = m2.evaluate(base5, [make_current(t2, {f"T{i:02d}": 0.0 for i in range(1, 9)})])
            check(
                "变异 2（|S| 下限 6→5）→ 降级标记消失",
                r2["degraded"] is False,
                f"degraded={r2['degraded']} verdict={r2['verdict']}",
            )

        # 变异 3：抠成空集 —— stable_set 恒返回 []
        d3 = os.path.join(tmp, "m3")
        os.makedirs(d3)
        _copy_sources(d3)
        _mutate(
            d3,
            'return sorted(t for t, rewards in per_task.items() if rewards and all(r == 1.0 for r in rewards))',
            "return []  # 抠成空集",
        )
        m3 = _load_from(d3)
        r3 = m3.evaluate(base, [cur])
        check("变异 3（S 恒空）→ PASS 翻转", r3["verdict"] != "PASS", r3["verdict"])

        # 变异 4：语法整体坏掉 —— checker 必须非 0 退出，而不是静默返回空事实
        d4 = os.path.join(tmp, "m4")
        os.makedirs(d4)
        _copy_sources(d4)
        path4 = os.path.join(d4, "eval-verdict.py")
        with open(path4, "a", encoding="utf-8") as fh:
            fh.write("\ndef broken(:\n")
        raised = False
        try:
            _load_from(d4)
        except SyntaxError:
            raised = True
        check("变异 4（语法坏掉）→ import 抛 SyntaxError", raised)


def main() -> int:
    print("=" * 64)
    print("  eval-verdict.py 正向断言 + P2 验收 6 组 + 变异自证")
    print("=" * 64)
    test_m_table()
    test_mcnemar()
    test_six_acceptance_cases()
    test_degraded_not_blocking()
    test_bidirectional_task_set()
    test_infra_ratio()
    test_infra_exactly_ten_percent_is_ok()
    test_external_block()
    test_baseline_self_consistency()
    test_epsilon_default()
    test_cache_and_cost_warn()
    test_missing_cost_is_not_zero()
    test_mutations()
    print("\n" + "=" * 64)
    print(f"  通过 {PASS} / 失败 {FAIL}")
    print("=" * 64)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
