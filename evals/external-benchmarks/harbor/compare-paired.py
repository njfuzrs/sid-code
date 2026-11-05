#!/usr/bin/env python3
"""判据 ②:换档前后的 reward 对照 —— **只比配对可比的题**。

用法:
    python3 compare-paired.py runs/a11-sid runs/permswitch-r2 [补跑run...]
    python3 compare-paired.py base new --allow-extra     # 明知 new 侧有新增题

## ⛔ 为什么不能直接比两个均值(2026-08-30 差点犯)

复算脚本对两轮各自算出:基线 **0.100(分母 10)**、本轮 **0.750(分母 4)**。
把这两个数并列写成「0.100 → 0.750」是**错的**,而且错得好看:

  - 本轮有 4 题因基础设施故障被排除(规则 ④⑤),它们**不在本轮分母里**;
  - 但这 4 题**在基线分母里**,且基线上它们全是 0.0;
  - 于是基线的分母里塞满了本轮不需要面对的 0 分 —— **两个均值的题目集不是同一个**。

**这是「分母比分子重要」在对照场景下的形态**:不是分母口径写错,
而是两侧分母**装的不是同一批题**,而两个数字并列时看不出这一点。

配对后的真实对照(2026-08-30 实测,n=4):基线 **0.000** → 本轮 **0.750** ——
方向一致,但分母从 10 掉到 4,**结论强度完全不同**,而且必须写明 n=4。

## ⚠️ 「尚未跑」与「跑了被排除」绝不能混

跑动中途取数时,本轮还没跑到的题(如 `log-summary-date-ranges`)会缺席。
把它当成「被排除」会**悄悄改变分母**;更坏的是基线唯一那题 1.0 恰好就在里面 ——
少算它会让基线看起来比实际更差,即**朝着有利于我们的方向失真**。
本脚本把两者分开报,且未跑完时明确拒绝给结论。

## 🔴 两个方向都要查(外部评测缺陷 28,2026-11-05 修)

原实现只算 `base − new`(基线有、换档后没跑),于是 **`new − base`(换档后多出来的
题)连一行输出都没有**:它不在配对表、不在 `➖ 不参与配对`、不在 `⚠️ 尚未跑`。
一个读者看到 `n=3` 会以为「两侧都是这 3 题」,而实际是「new 侧有 4 题,第 4 题被吞了」。

为什么它与上面那一节是同一件事:**丢掉分数低的题会让「换档后」看起来更好**,
同样是朝有利方向失真,只是这一侧连「拒绝出结论」那道闸都不经过。

补跑语义下新增题是正常操作(`new` 位置本来就接受多个 run 合并),所以本轮给了
显式开关 `--allow-extra`:**允许,但要打印出来、且不计入配对**。
⛔ `base − new` 没有对应开关 —— 那是「尚未跑」,不存在合法的忽略场景。

## 排除判据不在这里定义

逐题结局(reward + 排除原因)的唯一取数处是 `trial_outcomes.py`;
单条判据(verifier 判分了吗 / agent 跑过吗 / 被外部 kill 了吗)的唯一取数处是
`verifier_health.py`。本脚本只负责**配对与呈现**,不重写任何一条判据 ——
两份判据分叉的形态见 `verifier_health.py` 文件头。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import trial_outcomes as O  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="换档前后的配对对照（只比两侧都可比的题）",
        epilog="⛔ 两侧题集不一致时默认拒绝给结论；见文件头「两个方向都要查」。",
    )
    ap.add_argument("base", help="基线 run 目录")
    ap.add_argument("new", nargs="+", help="换档后 run 目录（多个 = 补跑合并，后者覆盖前者）")
    ap.add_argument(
        "--allow-extra",
        action="store_true",
        help="允许 new 侧存在基线没有的题（它们仍会被打印，只是不计入配对）",
    )
    ap.add_argument("--json", action="store_true", help="额外输出机器可读的配对报告")
    args = ap.parse_args(argv)

    base = O.load_run(args.base)
    new = O.load_runs(args.new)

    print(f"=== 判据 ② 配对对照 ===\n  基线: {args.base}\n  换档后: {' + '.join(args.new)}\n")

    base_only = sorted(set(base) - set(new))  # 尚未跑 —— 不是被排除
    new_only = sorted(set(new) - set(base))  # 题集不一致 —— 也不是被排除

    paired, dropped = [], []
    for t in sorted(set(base) & set(new)):
        if base[t].excluded or new[t].excluded:
            dropped.append((t, base[t].excluded, new[t].excluded))
        else:
            paired.append(t)

    if paired:
        hdr = f'  {"题":<26}{"基线":>7}{"换档后":>8}   变化'
        print(hdr)
        print("  " + "-" * (len(hdr) - 2))
        for t in paired:
            b, n = base[t].reward, new[t].reward
            arrow = "→" if b == n else ("↑ 解出" if n > b else "↓ 退步")
            print(f"  {t:<26}{b:>7}{n:>8}   {arrow}")

    if dropped:
        print(f"\n  ➖ {len(dropped)} 题不参与配对(任一侧被排除就整对退出,否则又变成不同题目集):")
        for t, be, ne in dropped:
            print(f'     {t:<26} 基线={be or "纳入"}  换档后={ne or "纳入"}')

    if base_only:
        print(f"\n  ⚠️ {len(base_only)} 题换档后**尚未跑**(不是被排除): {base_only}")
        print("     它们缺席会改变分母。基线里的高分题若在其中,基线会被低估 ——")
        print("     即**朝着有利于我们的方向**失真。")

    if new_only:
        print(f"\n  ⚠️ {len(new_only)} 题**只在换档后存在**,基线里没有: {new_only}")
        print("     它们无法配对;丢掉它们会让「换档后」只留下跑过的题 ——")
        print("     同样是**朝着有利于我们的方向**失真。")
        if args.allow_extra:
            print("     已按 --allow-extra 显式忽略(不计入配对,但已打印在上述清单里)。")

    report: dict[str, object] = {
        "base_run": args.base,
        "new_runs": list(args.new),
        "paired": paired,
        "dropped": [{"task": t, "base_excluded": be, "new_excluded": ne} for t, be, ne in dropped],
        "base_only": base_only,
        "new_only": new_only,
        "allow_extra": args.allow_extra,
    }

    print("\n=== 结论 ===")
    rc = 0
    if base_only:
        print(f"  ⛔ 换档后还有 {len(base_only)} 题没跑完 —— **本脚本拒绝给结论**。")
        print("     跑完(或按题补跑)后再取数;此刻的任何均值都是中途快照。")
        rc = 2
    elif new_only and not args.allow_extra:
        print(
            f"  ⛔ 换档后有 {len(new_only)} 题不在基线里 —— **两侧题目集不是同一批,拒绝给结论**。"
        )
        print("     补跑基线那一侧,或加 --allow-extra 明确接受忽略这些题。")
        rc = 2
    elif not paired:
        print("  ⛔ 配对可比的题数为 0 —— 这不是「没有变化」,是没有任何样本可比。")
        rc = 2
    else:
        b = sum(base[t].reward for t in paired) / len(paired)
        n = sum(new[t].reward for t in paired) / len(paired)
        up = sum(1 for t in paired if new[t].reward > base[t].reward)
        down = sum(1 for t in paired if new[t].reward < base[t].reward)
        print(f"  配对均值(n={len(paired)}): {b:.3f} → {n:.3f}   (↑{up} 题 / ↓{down} 题)")
        print(f"  ⚠️ 分母是 {len(paired)},不是 10 —— 引用这个数时必须带上 n。")
        print("  ⚠️ 逐题表才是结论(§12.1.1):n 这么小,均值极易被一题带偏。")
        report["means"] = {"base": b, "new": n, "n": len(paired), "up": up, "down": down}

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return rc


if __name__ == "__main__":
    sys.exit(main())
