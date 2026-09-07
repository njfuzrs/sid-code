#!/usr/bin/env python3
"""W3 续跑判据：把一个 job 目录里的 trial 分成「计分」与「非能力失败」两类。

## 为什么需要它 —— harbor 判不出来

上游抖动报废的题，形态是 `reward=0.0` + **`exception_info=None`** +
`metadata` 整份缺失（实测 `runs/modelswitch-base-fill` 两题）。于是：

  - `harbor job resume --filter-error-type` 按 `exception_type` 匹配 ⇒ **没有 type 可匹配**
  - `harbor run -r N` 按抛出的异常重试 ⇒ **没有异常抛出**

⇒ 它与「能力不行」在 harbor 眼里**完全一样**。判据必须走本仓的
`verifier_health`，这是本脚本存在的全部理由。

## ⛔ 三条自我约束（这个脚本会删目录，是 CLAUDE.md §0 铁律最警惕的动作）

  1. **dry-run 默认**。只有显式 `--apply` 才真删。
  2. **只删判过的**：必须先读出 `result.json` 且四条判据跑通，才允许删。
     判据本身抛异常 ⇒ **fail-closed 停手**，⛔ 不许"判不出来就删"。
  3. **只删形态匹配的**：`<job>/<task>__<hash>/`，且必须在传入 job 目录之下。

## ⛔ 什么绝不删

**有合法 reward 且四条判据全过的，一律不动 —— 含 `reward=0.0`。**
那是真实的 0 分（模型没解出来），删它就是伪造成绩，且失真方向对我们有利
（本仓 §1.2 纪律：两个方向的偏倚都是造假）。

用法：
    python3 w3-classify.py runs/w3-sid-ds-72              # 只看（默认）
    python3 w3-classify.py runs/w3-sid-ds-72 --apply      # 真删
    python3 w3-classify.py runs/w3-sid-ds-72 --json       # 给 bash 循环消费
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verifier_health import (
    agent_ran,
    agent_started,
    llm_fatal,
    verifier_ran,
)

#: 判为「非能力失败」的四类。⚠️ 顺序与 `compare-paired.py:load()` **逐字一致** ——
#: 两处判据分叉的形态是「同一个 run 在两个脚本里分母不同」，而那种错不会报错。
DROP_REASONS = (
    "verifier未判分",
    "无reward",
    "零调用",
    "启动未完成",
    "上游打断",
)


def classify(trial_dir: str) -> tuple[float | None, str | None]:
    """→ `(reward, 排除原因 or None)`。判据全部复用共享模块，不在此重写。

    ⚠️ 任何判据抛异常都**向上传播**，由调用方 fail-closed 处理 ——
    刻意不 try/except 兜住：兜住就退化成"判不出来 ⇒ 当成健康 ⇒ 不删"或者
    更坏的"当成坏 ⇒ 删掉"，两个方向都是静默错判。
    """
    with open(os.path.join(trial_dir, "result.json"), encoding="utf-8") as fh:
        d = json.load(fh)
    rew = ((d.get("verifier_result") or {}).get("rewards") or {}).get("reward")

    if not verifier_ran(trial_dir):
        return rew, "verifier未判分"
    if rew is None:
        return rew, "无reward"
    if agent_ran(d) is False:
        return rew, "零调用"
    # ⚠️ 这一条必须在 llm_fatal **之前**，且不能与「零调用」合并：
    # metadata 整份缺失时 agent_ran 返回 None(不是 False)，上一条判不出来，
    # 而 llm_fatal 读的是同一份缺失的 metadata ⇒ 两条都放行。
    # `is False` 而不是 `not`：没有 debug.log 的题（cc 侧）返回 None。
    if agent_started(trial_dir) is False:
        return rew, "启动未完成"
    if llm_fatal(d, trial_dir):
        return rew, "上游打断"
    return rew, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("job_dir")
    ap.add_argument("--apply", action="store_true",
                    help="真删（默认只打印）。破坏性操作不许默认执行。")
    ap.add_argument("--json", action="store_true", help="末行输出 JSON 摘要")
    args = ap.parse_args()

    job = os.path.abspath(args.job_dir)
    if not os.path.isdir(job):
        print(f"⛔ 不是目录: {job}", file=sys.stderr)
        return 2

    keep: list[tuple[str, float | None]] = []
    drop: list[tuple[str, str, float | None]] = []
    pending: list[str] = []

    for td in sorted(glob.glob(os.path.join(job, "*"))):
        if not os.path.isdir(td) or os.path.basename(td).startswith("_"):
            continue
        name = os.path.basename(td)
        task = name.split("__")[0]
        if not os.path.exists(os.path.join(td, "result.json")):
            # 「还没跑完」≠「跑了被排除」。混为一谈会悄悄改变分母。
            pending.append(task)
            continue
        try:
            rew, reason = classify(td)
        except Exception as exc:  # noqa: BLE001
            # 🔴 fail-closed：判据本身坏了就整个停手，⛔ 不删任何东西。
            print(f"⛔ 判据在 {name} 上抛异常，**停手不删**: "
                  f"{type(exc).__name__}: {exc}", file=sys.stderr)
            return 3
        if reason:
            drop.append((name, reason, rew))
        else:
            keep.append((name, rew))

    print(f"=== W3 续跑判据 · {os.path.basename(job)} ===")
    print(f"  计分（可入分母）: {len(keep)} 题")
    print(f"  非能力失败      : {len(drop)} 题")
    if pending:
        print(f"  ⏳ 尚未跑完      : {len(pending)} 题（**不是**被排除，不参与删除）")

    if drop:
        print("\n  待重跑（删目录后由 harbor 重新入队）：")
        for name, reason, rew in drop:
            print(f"    {name[:44]:<46} {reason:<12} reward={rew}")

    if keep:
        zeros = [n for n, r in keep if r == 0.0]
        if zeros:
            print(f"\n  ⚠️ 其中 {len(zeros)} 题 reward=0.0 但四条判据全过 ⇒ "
                  f"**真实 0 分，绝不重跑**（重跑它就是伪造成绩）")

    deleted = 0
    if args.apply:
        for name, reason, _rew in drop:
            td = os.path.join(job, name)
            # 三重形态校验：在 job 目录下 + 是目录 + 名字含 `__`
            if (os.path.dirname(os.path.abspath(td)) == job
                    and os.path.isdir(td) and "__" in name):
                shutil.rmtree(td)
                deleted += 1
                print(f"  🗑  已删 {name}（{reason}）")
            else:
                print(f"  ⛔ 形态校验未过，跳过 {name}")
    elif drop:
        print("\n  ℹ️ dry-run：未删任何目录。要真删加 --apply "
              "（或 w3-run.sh 里 SID_W3_APPLY=1）")

    if args.json:
        print("JSON:" + json.dumps({
            "keep": len(keep), "drop": len(drop), "pending": len(pending),
            "deleted": deleted,
            "drop_tasks": sorted(n.split("__")[0] for n, _, _ in drop),
        }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
