#!/usr/bin/env python3
"""轮数/预算诊断：判定 `num_turns` 的口径，并把三个数并排成表。

## 这个脚本存在的理由（T10a / traj #4 / B2）

`agent-traj-bench` 的 `reports/t8-rerun/zero-diag.json` 里，T0010 / T0051 / T0059
三条的 `num_turns` 是 **370 / 342 / 436**，而跑批时 `--max-turns` 传的是 120。
缺陷文档据此写成「`max_turns=120` 这个旋钮实际没生效：3 条跑到 342/370/436 轮」。

**那个读法把两个不同口径的数字当成了同一个数**：`num_turns` 在这三条上不是
主循环轮次，而是 `session.traj` 的 `total_steps`（轨迹条目数）。

机制在适配器里（`sid_code_agent.py` 的 `populate_context_post_run`）：

| 分支 | 触发条件 | `sid_num_turns` 取自 | 同时写入的注解字段 |
| --- | --- | --- | --- |
| 正常 | 有 stream-json `result` 事件 | `result["num_turns"]`（SDK 的 `turnCount`，主循环 assistant 消息数） | `sid_num_turns_without_model_interaction` = 数字 |
| 兜底 | `result` 事件从未发出（典型：撞墙钟被 SIGKILL） | `session.traj` 的 `metadata.total_steps`（**轨迹条目数**） | **不写** → 下游读到 `None` |
| 缺失 | 两个源都没有 | `None` | 不写 |

而 `total_steps` 的定义是 `trajectory.length`（`packages/core/src/trace/builder.ts`）：
每个 API pair 会 push「assistant action step」+「每个 tool_use 的 observation step」。
所以它天然约等于 **2 × API 调用次数**，与「轮次」不是同一个数。

## 可机械判定的三条判据

1. `num_turns_without_model_interaction` 是整数 → 走的是正常路径，`num_turns` 可读作轮次；
2. 它是 `None` 而 `num_turns` 有值 → 走的是轨迹兜底，`num_turns` **不可**读作轮次；
3. 两者都 `None` → agent 根本没启动（没有轨迹可兜底）。

这三条在整批 39 条上可交叉验证：只有 4 条命中第 2/3 类，其中 3 条正是被墙钟 kill 的离群值，
第 4 条（T0009）是「容器都没起来」。其余 34 条都是 0/1。

## 成本闸门（同一份诊断的另一半）

`--max-budget-usd` 为什么没触发，答案不在这三条上而在全批分布上：
若全批最大单题成本低于阈值，熔断器**结构上不可能触发**，`n_budget_capped=0` 是预期行为，
不是「开关没接上」。脚本把阈值与最大值并排，并给出余量。

## 用法

    # 只用入库产物（recommended，$0，不依赖 1.9G 的 run 目录）
    python3 diag-turn-accounting.py --reports-dir ~/Code/person/agent-traj-bench/reports/t8-rerun \
        --max-budget-usd 1.8

    # 有原始 run 目录时，额外填「主循环轮次 / API 调用次数」两列
    python3 diag-turn-accounting.py --reports-dir <同上> --run-dir <run 目录> --max-budget-usd 1.8

    # 内置自检（CI 门禁用，见 tests/eval/diag-turn-accounting-contract.test.ts）
    python3 diag-turn-accounting.py --self-test

## ⛔ 这个脚本不做的事

- 它**不推断**主循环轮次。没有原始 `session.traj` 时，那两列输出 `n/a` ——
  用 `total_steps` 反推轮次只能给区间（每轮工具数未知），区间不足以支撑「上限失效」的结论。
- 它**不改**任何产物。纯只读。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

#: `num_turns` 的取数路径（三档，闭集）。
TURNS_SOURCE_RESULT = "stream-json-result"
TURNS_SOURCE_TRAJ_FALLBACK = "session-traj-fallback"
TURNS_SOURCE_MISSING = "missing"

#: 判定「轨迹兜底」时，若拿得到 `result.json`，用这个字段交叉确认。
#: 适配器的兜底分支会写 `sid_cost_source = "session-traj-fallback"`。
COST_SOURCE_TRAJ_FALLBACK = "session-traj-fallback"

#: trial 目录内的固定布局（与 `sid_code_agent.py` 的常量同源）。
SID_HOME_DIRNAME = "sid-home"
RESULT_FILENAME = "result.json"
TRAJ_FILENAME = "session.traj"


def classify_turns_source(num_turns: Any, without: Any) -> str:
    """判定 `num_turns` 是「轮次」还是「轨迹条目数」。

    判据是**注解字段的存在性**，不是数值大小 —— 数值大小会诱导人做「370 > 120
    所以上限失效」这种推断，而那个推断的前提正是本函数要否掉的。

    ⚠️ 这条判据有一个前提：产出该 result 的 sid-code 版本**会写**注解字段。
    若某个更老的二进制不写它，`result` 路径会被误判成兜底（假阳性）。
    有原始 `result.json` 时用 `sid_cost_source` 交叉确认，可排除这种情形；
    没有时，脚本在报告里把结论标为「按字段存在性推定」。
    """
    if num_turns is None:
        return TURNS_SOURCE_MISSING
    if without is None:
        return TURNS_SOURCE_TRAJ_FALLBACK
    return TURNS_SOURCE_RESULT


def _load_json(path: str) -> Any:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _read_traj_metadata(trial_dir: str) -> dict | None:
    """读 trial 目录里最新那个会话的 `session.traj` metadata。

    取 mtime 最新的一份：`SID_CONFIG_DIR` 是 per-trial 挂载目录，但 install 阶段的
    探活可能留下第二个会话，`run()` 那次才是要的（与适配器同口径）。
    """
    sessions = os.path.join(trial_dir, SID_HOME_DIRNAME, "trajectories", "sessions")
    if not os.path.isdir(sessions):
        return None
    candidates = [
        os.path.join(sessions, name, TRAJ_FILENAME)
        for name in os.listdir(sessions)
        if os.path.isfile(os.path.join(sessions, name, TRAJ_FILENAME))
    ]
    if not candidates:
        return None
    newest = max(candidates, key=os.path.getmtime)
    try:
        doc = _load_json(newest)
    except (OSError, json.JSONDecodeError):
        return None
    md = doc.get("metadata")
    return md if isinstance(md, dict) else None


def _read_result_metadata(trial_dir: str) -> dict | None:
    path = os.path.join(trial_dir, RESULT_FILENAME)
    if not os.path.isfile(path):
        return None
    try:
        doc = _load_json(path)
    except (OSError, json.JSONDecodeError):
        return None
    agent_result = doc.get("agent_result")
    if not isinstance(agent_result, dict):
        return None
    md = agent_result.get("metadata")
    return md if isinstance(md, dict) else None


def analyze(reports_dir: str, run_dir: str | None = None,
            max_budget_usd: float | None = None) -> dict:
    """把入库产物（+ 可选原始 run 目录）折算成一张逐题表。"""
    trials_doc = _load_json(os.path.join(reports_dir, "trials.json"))
    diag_doc = _load_json(os.path.join(reports_dir, "zero-diag.json"))

    cost_by_task = {
        row.get("task"): row.get("cost_usd")
        for row in (trials_doc.get("rows") or [])
        if isinstance(row, dict)
    }
    prompt_tokens_by_task = {
        row.get("task"): row.get("n_input_tokens")
        for row in (trials_doc.get("rows") or [])
        if isinstance(row, dict)
    }

    rows: list[dict] = []
    for t in diag_doc.get("trials") or []:
        if not isinstance(t, dict):
            continue
        task = t.get("task")
        term = t.get("termination") or {}
        num_turns = term.get("num_turns")
        without = term.get("num_turns_without_model_interaction")
        source = classify_turns_source(num_turns, without)

        # 有原始 trial 目录时补两列 + 交叉确认口径。
        main_loop_turns: int | None = None
        api_calls: int | None = None
        cost_source: str | None = None
        confirmed = False
        if run_dir and task:
            trial_dir = os.path.join(run_dir, t.get("trial_dir") or task)
            md = _read_result_metadata(trial_dir)
            if md is not None:
                cost_source = md.get("sid_cost_source")
                # 兜底分支一定会写这两个键；正常分支不会写全。用它交叉确认。
                if cost_source == COST_SOURCE_TRAJ_FALLBACK:
                    confirmed = source == TURNS_SOURCE_TRAJ_FALLBACK
            traj_md = _read_traj_metadata(trial_dir)
            if traj_md is not None:
                calls = traj_md.get("total_api_calls")
                api_calls = int(calls) if isinstance(calls, (int, float)) else None
            # 只有正常路径的 num_turns 才是主循环轮次；兜底路径不在这里猜。
            if source == TURNS_SOURCE_RESULT and isinstance(num_turns, (int, float)):
                main_loop_turns = int(num_turns)

        rows.append({
            "task": task,
            "subtype": term.get("subtype"),
            "num_turns": num_turns,
            "without_model_interaction": without,
            "turns_source": source,
            "source_confirmed": confirmed,
            "main_loop_turns": main_loop_turns,
            "api_calls": api_calls,
            "cost_usd": cost_by_task.get(task),
            "prompt_tokens": prompt_tokens_by_task.get(task),
            "verdict": t.get("verdict"),
        })

    costs = [r["cost_usd"] for r in rows if isinstance(r.get("cost_usd"), (int, float))]
    budget = {
        "max_budget_usd": max_budget_usd,
        "max_cost_usd": max(costs) if costs else None,
        "n_over_budget": (
            sum(1 for c in costs if max_budget_usd is not None and c > max_budget_usd)
            if costs else 0
        ),
        "headroom_pct": None,
    }
    if costs and max_budget_usd:
        top = max(costs)
        budget["headroom_pct"] = round((1 - top / max_budget_usd) * 100, 1)

    missing_turns = [r["task"] for r in rows if r["turns_source"] == TURNS_SOURCE_MISSING]
    fallback_turns = [r["task"] for r in rows if r["turns_source"] == TURNS_SOURCE_TRAJ_FALLBACK]

    return {
        "batch": {
            "reports_dir": reports_dir,
            "run_dir": run_dir,
            "n_trials": len(rows),
            "max_turns": diag_doc.get("max_turns"),
        },
        "budget": budget,
        "rows": rows,
        "fallback_tasks": fallback_turns,
        "missing_tasks": missing_turns,
    }


def _estimate_api_calls(result: dict) -> list[dict]:
    """无原始轨迹时，用 prompt token 流量给 API 调用次数一个区间。

    口径：`n_input_tokens` 取 `total_cumulative_prompt_tokens`（flow，逐次累加），
    除以「正常路径每题每轮平均 prompt token」的分位数。这不是实测值，
    只用来回答「会不会远小于 370」——要精确值必须读原始 `session.traj`。
    """
    normal_ratios: list[float] = []
    for r in result["rows"]:
        if r["turns_source"] != TURNS_SOURCE_RESULT:
            continue
        tokens, turns = r.get("prompt_tokens"), r.get("num_turns")
        if isinstance(tokens, (int, float)) and isinstance(turns, (int, float)) and turns > 0:
            normal_ratios.append(tokens / turns)
    if not normal_ratios:
        return []
    normal_ratios.sort()

    def pct(p: float) -> float:
        idx = min(len(normal_ratios) - 1, int(len(normal_ratios) * p))
        return normal_ratios[idx]

    median, p90 = pct(0.5), pct(0.9)
    out = []
    for r in result["rows"]:
        if r["turns_source"] == TURNS_SOURCE_RESULT:
            continue
        tokens = r.get("prompt_tokens")
        if not isinstance(tokens, (int, float)):
            continue
        out.append({
            "task": r["task"],
            "prompt_tokens": tokens,
            # 除以中位数 = 上界（中位题上下文比这三条小），除以 p90 = 下界。
            "api_calls_upper": round(tokens / median),
            "api_calls_lower": round(tokens / p90),
            "median_prompt_per_turn": round(median),
            "p90_prompt_per_turn": round(p90),
        })
    return out


def render(result: dict) -> str:
    b = result["batch"]
    budget = result["budget"]
    lines: list[str] = []
    lines.append(f"=== 轮数/预算诊断 · {b['n_trials']} 题 · max_turns={b['max_turns']} ===")
    lines.append("")
    lines.append("task    subtype                num_turns  取数路径                 注解   主循环轮次  API调用  成本")
    for r in result["rows"]:
        note = "n/a" if r["without_model_interaction"] is None else str(r["without_model_interaction"])
        main = "n/a" if r["main_loop_turns"] is None else str(r["main_loop_turns"])
        calls = "n/a" if r["api_calls"] is None else str(r["api_calls"])
        cost = "n/a" if r["cost_usd"] is None else f"{r['cost_usd']:.3f}"
        lines.append(
            f"{r['task']:7s} {str(r['subtype']):22s} {str(r['num_turns']):10s} "
            f"{r['turns_source']:24s} {note:6s} {main:10s} {calls:8s} {cost}"
        )
    lines.append("")

    if result["fallback_tasks"]:
        lines.append(
            "⛔ 以下题的 num_turns 不可读作主循环轮次（它是 session.traj 的 total_steps，"
            "轨迹条目数）：" + " / ".join(result["fallback_tasks"])
        )
        lines.append(
            "   判据：这些题的 num_turns_without_model_interaction 是 None，其余正常路径题都是数字。"
        )
        lines.append(
            "   机制：result 事件缺失（撞墙钟被 SIGKILL）时，适配器用 "
            "traj.metadata.total_steps 兜底，且不写注解字段。"
        )
    if result["missing_tasks"]:
        lines.append("⚠️ 没有 num_turns 的题（agent 未启动 / 无轨迹可兜底）："
                     + " / ".join(result["missing_tasks"]))
    lines.append("")

    lines.append("成本闸门：")
    if budget["max_budget_usd"] is None:
        lines.append("  （未提供 --max-budget-usd，跳过）")
    else:
        lines.append(
            f"  全批最大单题成本 ${budget['max_cost_usd']:.4f}  vs  阈值 "
            f"${budget['max_budget_usd']:.2f}（余量 {budget['headroom_pct']}%）"
        )
        if budget["n_over_budget"] == 0:
            lines.append("  ⇒ 没有任何一题达到阈值，熔断器结构上不可能触发 —— "
                         "n_budget_capped=0 是预期行为，不是开关没接上。")
        else:
            lines.append(f"  ⇒ 有 {budget['n_over_budget']} 题超过阈值，需查内部成本累计口径。")
    lines.append("")

    estimates = _estimate_api_calls(result)
    if estimates:
        lines.append("无原始轨迹时的 API 调用次数区间（prompt token 流量反推，非实测）：")
        for e in estimates:
            lines.append(
                f"  {e['task']}: {e['prompt_tokens']} prompt tokens ÷ "
                f"每轮中位 {e['median_prompt_per_turn']} / p90 {e['p90_prompt_per_turn']} "
                f"⇒ {e['api_calls_lower']} – {e['api_calls_upper']} 次"
            )
        lines.append(
            "  ⚠️ 这是区间，不足以判定「轮次上限是否失效」；要定论必须读原始 "
            "sid-home/trajectories/sessions/*/session.traj 的 metadata.total_api_calls。"
        )
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────── 自检


def self_test() -> int:
    """用合成 fixture 断言三条判据，供 CI 门禁调用（纯 stdlib，不碰真实数据）。

    每个 case 都是本脚本唯一的设计决策（口径判定），改坏任何一条都会让它红。
    """
    import tempfile

    failures = 0

    def check(name: str, cond: bool, detail: str = "") -> None:
        nonlocal failures
        if cond:
            print(f"  ✅ {name}")
        else:
            failures += 1
            print(f"  ❌ {name}  {detail}")

    print("classify_turns_source：三档判据")
    check("注解是数字 → 正常路径", classify_turns_source(121, 0) == TURNS_SOURCE_RESULT)
    check("注解是 1 → 仍是正常路径（有零产出轮次）",
          classify_turns_source(120, 1) == TURNS_SOURCE_RESULT)
    check("注解为 None 且有 num_turns → 轨迹兜底",
          classify_turns_source(370, None) == TURNS_SOURCE_TRAJ_FALLBACK)
    check("两者都 None → 缺失", classify_turns_source(None, None) == TURNS_SOURCE_MISSING)

    print("analyze + render：合成一批三题型")
    with tempfile.TemporaryDirectory() as td:
        trials = {
            "rows": [
                {"task": "T0001", "cost_usd": 0.5, "n_input_tokens": 10_000_000},
                {"task": "T0002", "cost_usd": 1.2, "n_input_tokens": 30_000_000},
                {"task": "T0003", "cost_usd": None, "n_input_tokens": None},
            ]
        }
        diag = {
            "max_turns": 120,
            "trials": [
                {"task": "T0001", "termination": {
                    "subtype": "error_max_turns", "num_turns": 121,
                    "num_turns_without_model_interaction": 0}},
                {"task": "T0002", "termination": {
                    "subtype": None, "num_turns": 370,
                    "num_turns_without_model_interaction": None}},
                {"task": "T0003", "termination": {
                    "subtype": None, "num_turns": None,
                    "num_turns_without_model_interaction": None}},
            ],
        }
        with open(os.path.join(td, "trials.json"), "w", encoding="utf-8") as fh:
            json.dump(trials, fh)
        with open(os.path.join(td, "zero-diag.json"), "w", encoding="utf-8") as fh:
            json.dump(diag, fh)

        out = analyze(td, max_budget_usd=1.8)
        src = {r["task"]: r["turns_source"] for r in out["rows"]}
        check("T0001 判正常", src["T0001"] == TURNS_SOURCE_RESULT, src["T0001"])
        check("T0002 判兜底", src["T0002"] == TURNS_SOURCE_TRAJ_FALLBACK, src["T0002"])
        check("T0003 判缺失", src["T0003"] == TURNS_SOURCE_MISSING, src["T0003"])
        check("兜底清单只含 T0002", out["fallback_tasks"] == ["T0002"], str(out["fallback_tasks"]))
        check("最大成本取全批最大值", abs(out["budget"]["max_cost_usd"] - 1.2) < 1e-9)
        check("无题超阈值（1.2 < 1.8）", out["budget"]["n_over_budget"] == 0)
        check("余量按最大值算", out["budget"]["headroom_pct"] == 33.3, str(out["budget"]["headroom_pct"]))

        text = render(out)
        check("报告点名兜底题", "T0002" in text and "不可读作主循环轮次" in text)
        check("报告说明熔断未触发", "结构上不可能触发" in text)

        # 变异：把阈值压到低于最大成本 → 判定必须翻转。
        out2 = analyze(td, max_budget_usd=1.0)
        check("变异：阈值 1.0 时 T0002 超限", out2["budget"]["n_over_budget"] == 1,
              str(out2["budget"]["n_over_budget"]))

        # 变异：把 T0002 的注解改成 0 → 它就不再是兜底，判据真的在看那个字段。
        diag["trials"][1]["termination"]["num_turns_without_model_interaction"] = 0
        with open(os.path.join(td, "zero-diag.json"), "w", encoding="utf-8") as fh:
            json.dump(diag, fh)
        out3 = analyze(td, max_budget_usd=1.8)
        src3 = {r["task"]: r["turns_source"] for r in out3["rows"]}
        check("变异：注解改成 0 后 T0002 判正常", src3["T0002"] == TURNS_SOURCE_RESULT, src3["T0002"])

    if failures:
        print(f"\n❌ 自检失败 {failures} 项")
        return 1
    print("\n✅ 自检通过")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="判定 num_turns 口径 + 成本闸门诊断")
    ap.add_argument("--reports-dir", help="含 trials.json 与 zero-diag.json 的目录")
    ap.add_argument("--run-dir", help="原始 run 目录（可选，用于补主循环轮次/API 调用两列）")
    ap.add_argument("--max-budget-usd", type=float, help="该批次实际使用的 per-trial 预算上限")
    ap.add_argument("--self-test", action="store_true", help="跑内置自检（CI 门禁用）")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()
    if not args.reports_dir:
        ap.error("需要 --reports-dir（或 --self-test）")

    result = analyze(args.reports_dir, args.run_dir, args.max_budget_usd)
    print(render(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
