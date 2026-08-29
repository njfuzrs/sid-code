#!/usr/bin/env python3
"""算 §14.7 要的那两个比值：`输入tok/turns` 与 `静态前缀tok/总输入tok`，按 agent 分组。

**为什么不复用 sid-code 的 digest**：digest 的输入是宿主 `~/.sid-code/`，
而每个 trial 的轨迹落在 `runs/<job>/<trial>/agent/sid-home/` 下（bind mount），
是 10 份互不相干的 session。这里只做「读 Harbor 产物 + 读 trial 内轨迹」的汇总，
**不重算任何 sid-code 已有的指标** —— 每个数字都指到一个源字段（见 FIELD_SOURCES）。

分桶规则**三条都机械执行**（§14.7，缺一条分数就失真）：
  1. `reward=0 且 sid_is_error=False` → 判分未发生，不进分母（13.2 铁律）
  2. `verifier/test-stdout.txt` 尾部含 `command not found` 等 → 同样不进分母（14.2）
  3. 不只报 Mean，同时报中位数与逐题明细

用法：
    python3 analyze-prefix.py runs/a11-sid [runs/a11-mswea ...]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

#: 14.2 那条判据的关键词。**必须与 README 里那条 grep 保持一致** ——
#: 两处不一致时，被筛掉的样本集不同，而两边都不会报错。
VERIFIER_BROKEN_PAT = re.compile(
    r"uv: command not found|uvx: command not found|curl: command not found"
    r"|failed to download|Could not resolve host|Temporary failure in name resolution",
)

#: pytest 的收尾行。**这是「判分到底有没有发生」唯一的正面证据。**
#:
#: ⚠️ 为什么必须有这一条（2026-08-29 实测教训，它推翻了 §13.2 那条铁律的写法）：
#: §13.2 写的是「`reward=0` 且 `sid_is_error=False` → 判分未发生，不进分母」。
#: 照字面执行会**把 `configure-git-webserver` 排除掉** —— 而那个样本的 verifier
#: **跑得好好的**（`1 failed in 22.79s`），真实情况是 sid-code 只写了一篇
#: 「怎么配置」的说明文字、没有真的配好服务器，然后 `subtype=success` 收工。
#: **那正是最该计分的一类失败**（「以为自己做完了」），排除它等于给 sid-code
#: 白送一分，而且送的恰好是它最该被扣分的地方。
#:
#: 形态：`reward=0 且 not-error` 这个条件同时覆盖两件语义相反的事 ——
#:   ① verifier 没跑成（判分未发生，该排除）
#:   ② verifier 跑了、判 0，agent 自我报喜（真实失败，该计分）
#: 只有**去看 verifier 自己的输出**才能分开这两者。
#: `sid_is_error` 是 agent 的自述，**拿它推断 verifier 的状态是跨主语推断**。
VERIFIER_RAN_PAT = re.compile(r"\d+ (?:failed|passed|error)", re.I)

FIELD_SOURCES = {
    "reward": "result.json → verifier_result.rewards.reward",
    "total_input": "agent_result.n_input_tokens + n_cache_tokens + metadata.cache_write_tokens",
    "turns": "agent_result.metadata.sid_num_turns（mswea 用 trajectory.json.final_metrics）",
    "static_prefix": "轨迹 events.jsonl 首个 AfterModelRaw 的 "
    "input_tokens + cache_read + cache_creation（首调用的**总** prompt）",
    "per_call_usage": "轨迹 events.jsonl 的 AfterModelRaw.data.usage",
}

#: ⚠️ **静态前缀口径**：必须用首次调用的**总 prompt tokens**，
#: 不能用 `cache_creation`。实测（2026-08-28）同一道 hello-world 跑三次：
#:   总 prompt 恒 22,950，而 cache_creation 是 3,442 / 8,491 / 4,360。
#: 因为 read/write 的切分由**服务端缓存是否还热**决定（跨 run 的 TTL / 路由），
#: 与「前缀有多大」无关。用 cache_creation 会得到一个每跑一次就变 2.5 倍的数，
#: 而它**不会报错**，只会让 A11 的结论随机摆动。
#: 这同时纠正了 §13.1：那里的「静态前缀 11,212」其实是**整个 session 的
#: cache_write 累加**，不是首调用的前缀。真实前缀 ≈ 22.9k（大了一倍）。


def _tail(path: Path, n: int = 4000) -> str:
    if not path.exists():
        return ""
    data = path.read_bytes()
    return data[-n:].decode("utf-8", "replace")


def _per_call_usage(trial: Path) -> list[dict]:
    """读 trial 内 sid-code 轨迹的逐次调用 usage。找不到返回空列表。"""
    hits = sorted(trial.glob("agent/sid-home/trajectories/sessions/*/events.jsonl"))
    out: list[dict] = []
    for f in hits:
        for line in f.read_text("utf-8", "replace").splitlines():
            if '"AfterModelRaw"' not in line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            data = d.get("data") or {}
            usage = data.get("usage") or {}
            if usage:
                out.append({"index": data.get("index"), **usage})
    return out


def _harness_events(trial: Path) -> dict[str, int]:
    """统计几个「会绿着坏掉」的 harness 事件。它们不进分数，只做归因。"""
    counts: dict[str, int] = {}
    for f in sorted(trial.glob("agent/sid-home/trajectories/sessions/*/events.jsonl")):
        for line in f.read_text("utf-8", "replace").splitlines():
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            e = d.get("event")
            if e in {
                "TimeoutFired",
                "WatchdogKill",
                "ModelCallUnpaired",
                "TimeoutRetry",
                "RepeatedReadonlyGuardTriggered",
                "StreamRestart",
            }:
                counts[e] = counts.get(e, 0) + 1
            elif e == "prefix_break" and (d.get("data") or {}).get("broken"):
                counts["prefix_break(broken)"] = counts.get("prefix_break(broken)", 0) + 1
    return counts


def collect(job_dir: Path) -> list[dict]:
    rows: list[dict] = []
    for res in sorted(job_dir.glob("*/result.json")):
        trial = res.parent
        d = json.loads(res.read_text("utf-8"))
        ar = d.get("agent_result") or {}
        md = ar.get("metadata") or {}
        vr = d.get("verifier_result") or {}
        reward = (vr.get("rewards") or {}).get("reward")

        fresh = ar.get("n_input_tokens") or 0
        cache_read = ar.get("n_cache_tokens") or 0
        cache_write = md.get("cache_write_tokens") or 0
        calls = _per_call_usage(trial)

        # 对照 agent（mini-swe-agent）：轮数在它自己的 trajectory.json 里，
        # 且**分母口径与 sid 不同** —— sid 的 `sid_num_turns` vs mswea 的 `total_steps`。
        # §13.6 已点破这一点，跨 agent 比 `输入tok/turns` 时必须标明。
        mswea = trial / "agent" / "trajectory.json"
        mswea_steps = None
        if mswea.exists():
            try:
                fm = json.loads(mswea.read_text("utf-8")).get("final_metrics") or {}
                mswea_steps = fm.get("total_steps")
            except (json.JSONDecodeError, OSError):
                mswea_steps = None
        # 静态前缀 = 首次调用的**总** prompt。首调用之前无任何对话历史，
        # 所以这一整块就是「系统提示 + 工具定义 + 首条用户消息」。
        # 见上方 FIELD_SOURCES 下那段注释：**不要改成 cache_creation。**
        static_prefix = None
        if calls:
            c0 = calls[0]
            static_prefix = (
                (c0.get("input_tokens") or 0)
                + (c0.get("cache_read") or 0)
                + (c0.get("cache_creation") or 0)
            ) or None

        vtail = _tail(trial / "verifier" / "test-stdout.txt")
        broken_hit = VERIFIER_BROKEN_PAT.search(vtail)

        verifier_ran = bool(VERIFIER_RAN_PAT.search(vtail))
        bucket = "counted"
        if reward is None:
            bucket = "excluded:no-reward"
        elif broken_hit and not verifier_ran:  # 规则 2（14.2）
            # ⚠️ `and not verifier_ran`：坏掉的关键词可能只是**某一个**测试里的噪声
            # （比如装 uv 失败但别的测试照样跑完判了分）。有收尾行就说明判分发生了。
            bucket = f"excluded:verifier-broken({broken_hit.group(0)})"
        elif not verifier_ran:  # 规则 1（13.2 的修正版，见 VERIFIER_RAN_PAT 那段）
            bucket = "excluded:unjudged(no-verifier-summary-line)"

        rows.append(
            {
                "task": d.get("task_name"),
                "trial": d.get("trial_name"),
                "reward": reward,
                "bucket": bucket,
                "fresh": fresh,
                "cache_read": cache_read,
                "cache_write": cache_write,
                "total_input": fresh + cache_read + cache_write,
                "output": ar.get("n_output_tokens"),
                "cost_usd": ar.get("cost_usd"),
                "turns": md.get("sid_num_turns") or mswea_steps,
                "turns_kind": "sid_num_turns" if md.get("sid_num_turns") else ("mswea_total_steps" if mswea_steps else None),
                "subtype": md.get("sid_subtype"),
                "is_error": md.get("sid_is_error"),
                "stop_reason": md.get("sid_stop_reason"),
                "n_model_calls": len(calls) or None,
                "static_prefix": static_prefix,
                "harness_events": _harness_events(trial),
                "exception": (d.get("exception_info") or {}).get("exception_type")
                if d.get("exception_info")
                else None,
            }
        )
    return rows


def _med(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def report(job_dir: Path) -> None:
    rows = collect(job_dir)
    print(f"\n{'=' * 78}\n{job_dir}  —  {len(rows)} trials\n{'=' * 78}")
    hdr = f"{'task':<28}{'rw':>5}{'in_tok':>9}{'turns':>7}{'in/turn':>9}{'pfx':>7}{'pfx%':>7}  bucket"
    print(hdr)
    for r in rows:
        ipt = r["total_input"] or 0
        turns = r["turns"] or 0
        ratio1 = ipt / turns if turns else None
        pfx = r["static_prefix"]
        ratio2 = (pfx / ipt * 100) if (pfx and ipt) else None
        print(
            f"{(r['task'] or '?')[:27]:<28}"
            f"{('-' if r['reward'] is None else f'{r["reward"]:.1f}'):>5}"
            f"{ipt:>9}{turns:>7}"
            f"{('-' if ratio1 is None else f'{ratio1:.0f}'):>9}"
            f"{('-' if pfx is None else str(pfx)):>7}"
            f"{('-' if ratio2 is None else f'{ratio2:.1f}'):>7}"
            f"  {r['bucket']}"
        )
        if r["harness_events"]:
            print(f"{'':<28}  ↳ harness: {r['harness_events']}")
        if r["exception"]:
            print(f"{'':<28}  ↳ exception: {r['exception']}")

    counted = [r for r in rows if r["bucket"] == "counted"]
    print(f"\n分母：{len(counted)}/{len(rows)} 计入（其余按 §14.7 三条分桶规则排除）")
    for r in rows:
        if r["bucket"] != "counted":
            print(f"  排除 {r['task']}: {r['bucket']}")
    if counted:
        rewards = [r["reward"] for r in counted if r["reward"] is not None]
        r1 = [
            r["total_input"] / r["turns"] for r in counted if r["turns"] and r["total_input"]
        ]
        r2 = [
            r["static_prefix"] / r["total_input"] * 100
            for r in counted
            if r["static_prefix"] and r["total_input"]
        ]
        print(f"\nreward   mean={sum(rewards) / len(rewards):.3f}  median={_med(rewards)}")
        if r1:
            print(f"in/turn  mean={sum(r1) / len(r1):.0f}  median={_med(r1):.0f}")
        if r2:
            print(
                f"pfx%     mean={sum(r2) / len(r2):.1f}%  median={_med(r2):.1f}%  "
                f"(13.1 在 hello-world 上是 24.5% = 11212/45803)"
            )
        cost = [r["cost_usd"] for r in counted if r["cost_usd"]]
        if cost:
            print(f"cost     sum=${sum(cost):.4f}  mean=${sum(cost) / len(cost):.4f}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    for a in sys.argv[1:]:
        report(Path(a))
    print("\n取数源：")
    for k, v in FIELD_SOURCES.items():
        print(f"  {k:<15} {v}")
