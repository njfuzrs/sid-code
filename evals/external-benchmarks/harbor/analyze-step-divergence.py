#!/usr/bin/env python3
"""把 sid-code 与 mini-swe-agent 的轨迹拉平成「第 N 步 → 做了什么」，找第一个分叉点。

## 它回答的问题（§16.4 第一优先）

同题、同模型、同容器：mswea **10 步**解出，sid-code **33 次工具调用仍未解出**。
方向不是「加循环检测」（两边都不在原地打转），是**「为什么要走这么多步」**。

## ⚠️ 两个口径陷阱（本仓有教训，都会让人下错结论）

1. **`33 次工具调用` 与 `19 条 messages` 不是同口径**。mswea 的一「步」= 一次
   assistant 回复 + 一次 tool 结果（一问一答），sid-code 的一次工具调用是**半步**。
   拉平后要比的是**动作序列**，不是这两个数。
2. **mswea 只有 bash 一个工具**，所以「大量用 bash」是两边共性、不是差异。
   差异必须落在**同一步在做什么**上。

用法：
    python3 analyze-step-divergence.py                # 两题全跑
    python3 analyze-step-divergence.py --task regex-log
    python3 analyze-step-divergence.py --dump-steps   # 逐步打全（读原文用）
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

RUNS = Path(__file__).resolve().parent / "runs"

# ⚠️ 两题都取 `-r2`：`polyglot-c-py` 在 `a11-mswea` 与 `-r2` 里各有一份，
# `regex-log` 只在 `-r2` 里有。混用两次 run 就是「拿两个变量的对照下单变量的结论」
# （§14.4 那条教训），所以这里写死 `-r2`，不做自动搜索。
TASKS = {
    "polyglot-c-py": {
        "sid": "a11-sid/polyglot-c-py__VbCuFjK/agent/sid-home/trajectories/sessions/20260828-124538-6ca0792a/session.traj",
        "mswea": "a11-mswea-r2/polyglot-c-py__AJ37jhG/agent/mini-swe-agent.trajectory.json",
    },
    "regex-log": {
        "sid": "a11-sid/regex-log__ZEvBxMY/agent/sid-home/trajectories/sessions/20260828-140050-2f37d033/session.traj",
        "mswea": "a11-mswea-r2/regex-log__CqoEvNE/agent/mini-swe-agent.trajectory.json",
    },
}


def _squash(text: str, limit: int = 110) -> str:
    """压成一行。多行命令在表格里会把对齐彻底毁掉。"""
    s = re.sub(r"\s+", " ", (text or "").strip())
    return s if len(s) <= limit else s[: limit - 1] + "…"


# ── sid-code 侧 ────────────────────────────────────────────────────────────────


def load_sid(path: Path) -> list[dict[str, Any]]:
    """从 `session.traj` 抽出 assistant 的工具调用序列。

    判据同 §16.4 那张取数表：`role == "assistant"` 且有 `tool_name`。
    """
    traj = json.loads(path.read_text(encoding="utf-8"))["trajectory"]
    steps: list[dict[str, Any]] = []
    for e in traj:
        if e.get("role") != "assistant" or not e.get("tool_name"):
            continue
        tool = e["tool_name"]
        ti = e.get("tool_input") or {}
        # 摘要取「这一步实际动了什么」：bash 取命令，write/edit 取路径，其余取首个标量参数。
        if tool == "bash":
            arg = ti.get("command", "")
        elif tool in ("write", "edit", "read"):
            arg = str(ti.get("file_path") or ti.get("path") or "")
        elif tool == "think":
            arg = ti.get("thought", "")
        else:
            arg = next((str(v) for v in ti.values() if isinstance(v, (str, int, float))), "")
        steps.append({"tool": tool, "arg": _squash(str(arg)), "thought": _squash(e.get("thought") or "", 80)})
    return steps


# ── mini-swe-agent 侧 ─────────────────────────────────────────────────────────


def load_mswea(path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """从 `mini-swe-agent.trajectory.json` 抽出每步执行的命令。

    mswea 只有一个「bash」通道：命令在 assistant 的 `tool_calls` 里。
    一步 = 一条 assistant + 一条 tool 结果，所以步数 = assistant 条数。
    """
    d = json.loads(path.read_text(encoding="utf-8"))
    steps: list[dict[str, Any]] = []
    for m in d["messages"]:
        if m.get("role") != "assistant":
            continue
        cmd = ""
        for tc in m.get("tool_calls") or []:
            fn = tc.get("function") or {}
            raw = fn.get("arguments") or "{}"
            try:
                args = json.loads(raw) if isinstance(raw, str) else raw
            except json.JSONDecodeError:
                args = {}
            cmd = args.get("command") or args.get("cmd") or raw
            break
        steps.append({"tool": "bash", "arg": _squash(str(cmd)), "thought": _squash(m.get("content") or "", 80)})
    return steps, d.get("info", {})


# ── 分析 ──────────────────────────────────────────────────────────────────────

# 动作分类。**刻意粗粒度**：目的是看「这一步属于哪一类活动」，
# 细到命令级别就又变成两条不可对齐的长列表了。
CATEGORIES: list[tuple[str, str]] = [
    # ⚠️ 这条的第一版写成 `\b(...|<<\s*'?EOF)`，**恒不匹配** —— `\b` 落在
    # 空格与 `<` 之间，两侧都是非单词字符，边界不成立。于是所有 heredoc 写文件
    # 都掉到下面的 `inspect`（被 `cat\b` 接住），**把「在写解法」误报成「在看文件」**。
    # 形态：分类器不报错、占比表照出，只是语义整体错位。
    ("write_file", r"(?:cat\s*>|\btee\b|<<\s*'?EOF)"),
    ("run_test", r"\b(pytest|python3?\s+-m\s+pytest|make\s+test|\./run_tests|bash\s+.*test)"),
    ("compile", r"\b(gcc|clang|cc\s|make\b|g\+\+)"),
    ("run_program", r"\b(python3?\s+\w|\./a\.out|node\s)"),
    ("inspect", r"\b(cat\b|head\b|tail\b|less\b|sed\s+-n|grep\b|rg\b|find\b|wc\b|file\b|xxd|od\b)"),
    ("navigate", r"\b(ls\b|pwd\b|cd\b|tree\b)"),
]


def categorize(step: dict[str, Any]) -> str:
    if step["tool"] in ("write", "edit"):
        return "write_file"
    if step["tool"] == "read":
        return "inspect"
    if step["tool"] == "think":
        return "think"
    arg = step["arg"]
    for name, pat in CATEGORIES:
        if re.search(pat, arg):
            return name
    return "other"


def first_divergence(a: list[str], b: list[str]) -> int:
    """两条分类序列第一次不同的下标（0-based）。全同则返回较短者长度。"""
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return i
    return min(len(a), len(b))


def report(task: str, dump: bool) -> None:
    paths = TASKS[task]
    sid = load_sid(RUNS / paths["sid"])
    mswea, info = load_mswea(RUNS / paths["mswea"])

    print("=" * 78)
    print(f"■ {task}")
    print("=" * 78)

    sid_cat = [categorize(s) for s in sid]
    mswea_cat = [categorize(s) for s in mswea]

    print(f"\n[规模] sid-code {len(sid)} 次工具调用  vs  mswea {len(mswea)} 步"
          f"（比 {len(sid) / max(len(mswea), 1):.1f}×）")
    print(f"        mswea exit_status = {info.get('exit_status')!r}")
    print(f"[工具构成] sid = {dict(Counter(s['tool'] for s in sid))}")
    print(f"           ⚠️ mswea 只有 bash 一个工具，工具构成本身不可比")

    print(f"\n[活动分布] （同一分类下的占比才是可比口径）")
    cs, cm = Counter(sid_cat), Counter(mswea_cat)
    for k in sorted(set(cs) | set(cm), key=lambda k: -(cs[k] + cm[k])):
        print(f"   {k:<12} sid {cs[k]:>3} ({cs[k] / len(sid):>5.1%})   "
              f"mswea {cm[k]:>3} ({cm[k] / len(mswea):>5.1%})")

    d = first_divergence(sid_cat, mswea_cat)
    print(f"\n[第一个分叉点] 第 {d + 1} 步（前 {d} 步的活动类别完全一致）")
    for i in range(min(d + 3, max(len(sid), len(mswea)))):
        mark = "→" if i == d else " "
        s = f"{sid_cat[i]}: {sid[i]['arg']}" if i < len(sid) else "（已结束）"
        m = f"{mswea_cat[i]}: {mswea[i]['arg']}" if i < len(mswea) else "（已结束）"
        print(f"  {mark} #{i + 1:<2} sid   {s[:100]}")
        print(f"    {'':<3} mswea {m[:100]}")

    if dump:
        print(f"\n[sid-code 全部 {len(sid)} 步]")
        for i, s in enumerate(sid, 1):
            print(f"  {i:>2}. [{categorize(s):<11}] {s['tool']:<6} {s['arg'][:100]}")
        print(f"\n[mswea 全部 {len(mswea)} 步]")
        for i, s in enumerate(mswea, 1):
            print(f"  {i:>2}. [{categorize(s):<11}] {s['arg'][:100]}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--task", choices=sorted(TASKS), help="只跑一题（缺省两题都跑）")
    ap.add_argument("--dump-steps", action="store_true", help="逐步打全")
    args = ap.parse_args()
    for t in [args.task] if args.task else sorted(TASKS):
        report(t, args.dump_steps)
        print()


if __name__ == "__main__":
    main()
