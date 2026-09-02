#!/usr/bin/env python3
"""并发实证：从 result.json 的时间戳算**真实重叠**，不看 `-n` 传了几。

## 为什么必须单独立一个判据

`-n 6` 只是**请求并发**。Harbor 真的并发起容器、还是被某处串行化了，
`-n` 这个入参**一个字都不告诉你**。而两种形态的墙钟差是 6×，
却都以 `n_completed_trials=10 / errored=0` 收尾 —— 绿着串行跑完，
与绿着并发跑完在退出码上**逐字节一样**。

⚠️ 本仓 W0 那次的教训同源：nop 三档 `-n 1/3/6` 墙钟 10.16→4.12→2.44 min，
但那 4.17× **全部来自 verifier**（nop 的 `agent_execution` 恒为 0）——
**「墙钟变短」推不出「agent 真并发」**。所以这里只认区间重叠。

## 判据（三条，各自独立）

1. **峰值并发** = 任一时刻 `agent_execution` 区间重叠的最大条数。
   `>1` 才叫并发；`==1` 即**完全串行**（不管 `-n` 传了多少）。
2. **并发折扣** = Σ各题耗时 ÷ 墙钟。串行时 ≈1.0，理想 6 并发时 →6.0。
3. **加速归因**：分别报 `agent_execution` 与其他阶段的重叠 ——
   只有前者的重叠才是我们要买的那个加速。
"""
import json, glob, os, sys
from datetime import datetime


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def peak_overlap(spans):
    """扫描线：返回 (峰值并发, 峰值时刻)。spans = [(start, end, name)]"""
    events = []
    for a, b, _ in spans:
        events.append((a, 1))
        events.append((b, -1))
    events.sort(key=lambda e: (e[0], -e[1]))  # 同刻先进后出，取上界
    cur = peak = 0
    at = None
    for t, delta in events:
        cur += delta
        if cur > peak:
            peak, at = cur, t
    return peak, at


def collect(run, phase):
    spans = []
    for f in sorted(glob.glob(os.path.join(run, "*", "result.json"))):
        d = json.load(open(f))
        s = d.get(phase) or {}
        a, b = ts(s.get("started_at")), ts(s.get("finished_at"))
        if a and b:
            spans.append((a, b, os.path.basename(os.path.dirname(f)).split("__")[0]))
    return spans


def main(run):
    top = os.path.join(run, "result.json")
    if not os.path.exists(top):
        print(f"⛔ 没有 {top}")
        return 1
    d = json.load(open(top))
    s = d.get("stats", {})
    wall = None
    if d.get("started_at") and d.get("finished_at"):
        wall = (ts(d["finished_at"]) - ts(d["started_at"])).total_seconds()

    print(f"=== 并发实证：{run} ===")
    print(f"  completed={s.get('n_completed_trials')} errored={s.get('n_errored_trials')} "
          f"cost_usd={s.get('cost_usd')}")
    if wall:
        print(f"  墙钟 {wall / 60:.1f} min")

    verdict = 0
    for phase in ("agent_execution", "agent_setup", "verifier"):
        spans = collect(run, phase)
        if not spans:
            print(f"  {phase}: 无数据")
            continue
        total = sum((b - a).total_seconds() for a, b, _ in spans)
        peak, at = peak_overlap(spans)
        disc = (total / wall) if wall else float("nan")
        mark = "✅ 并发" if peak > 1 else "⛔ 完全串行"
        print(f"  {phase:17s} n={len(spans):2d} Σ耗时 {total / 60:6.1f} min  "
              f"峰值并发 {peak}  {mark}"
              + (f"  @ {at.strftime('%H:%M:%S')}" if at else ""))
        if phase == "agent_execution":
            print(f"    并发折扣 Σ耗时÷墙钟 = {disc:.2f}×  （1.0≈串行）")
            # 判据 1 只对 agent_execution 生效：这是我们真正要买的那段。
            verdict = 0 if peak > 1 else 1
    return verdict


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "runs/ccrun-n6"))
