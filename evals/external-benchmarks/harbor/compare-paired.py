#!/usr/bin/env python3
"""判据 ②:换档前后的 reward 对照 —— **只比配对可比的题**。

用法:
    python3 compare-paired.py runs/a11-sid runs/permswitch-r2

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
"""
import json, glob, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verifier_health import agent_ran, llm_fatal, verifier_ran  # noqa: E402


def load(run):
    """→ {题: (reward, 排除原因 or None)}。判据全部复用共享模块,不在此重写。"""
    out = {}
    for f in sorted(glob.glob(os.path.join(run, "*", "result.json"))):
        d = json.load(open(f))
        td = os.path.dirname(f)
        task = os.path.basename(td).split("__")[0]
        rew = ((d.get("verifier_result") or {}).get("rewards") or {}).get("reward")
        if not verifier_ran(td):
            excl = "verifier未判分"
        elif rew is None:
            excl = "无reward"
        elif agent_ran(d) is False:
            excl = "零调用"
        elif llm_fatal(d, td):
            excl = "上游打断"
        else:
            excl = None
        out[task] = (rew, excl)
    return out


if len(sys.argv) < 3:
    sys.exit("用法: compare-paired.py <基线run> <换档后run> [换档后补跑run...]")

base = load(sys.argv[1])
new = {}
for r in sys.argv[2:]:            # 后者补前者(补跑语义,与复算脚本一致)
    new.update(load(r))

print(f"=== 判据 ② 配对对照 ===\n  基线: {sys.argv[1]}\n  换档后: {' + '.join(sys.argv[2:])}\n")

missing = sorted(set(base) - set(new))     # 尚未跑 —— 不是被排除
paired, dropped = [], []
for t in sorted(set(base) & set(new)):
    if base[t][1] or new[t][1]:
        dropped.append((t, base[t][1], new[t][1]))
    else:
        paired.append(t)

if paired:
    hdr = f'  {"题":<26}{"基线":>7}{"换档后":>8}   变化'
    print(hdr); print("  " + "-" * (len(hdr) - 2))
    for t in paired:
        b, n = base[t][0], new[t][0]
        arrow = "→" if b == n else ("↑ 解出" if n > b else "↓ 退步")
        print(f'  {t:<26}{b:>7}{n:>8}   {arrow}')

if dropped:
    print(f"\n  ➖ {len(dropped)} 题不参与配对(任一侧被排除就整对退出,否则又变成不同题目集):")
    for t, be, ne in dropped:
        print(f'     {t:<26} 基线={be or "纳入"}  换档后={ne or "纳入"}')

if missing:
    print(f"\n  ⚠️ {len(missing)} 题换档后**尚未跑**(不是被排除): {missing}")
    print("     它们缺席会改变分母。基线里的高分题若在其中,基线会被低估 ——")
    print("     即**朝着有利于我们的方向**失真。")

print("\n=== 结论 ===")
if missing:
    print(f"  ⛔ 换档后还有 {len(missing)} 题没跑完 —— **本脚本拒绝给结论**。")
    print("     跑完(或按题补跑)后再取数;此刻的任何均值都是中途快照。")
elif not paired:
    print("  ⛔ 配对可比的题数为 0 —— 这不是「没有变化」,是没有任何样本可比。")
else:
    b = sum(base[t][0] for t in paired) / len(paired)
    n = sum(new[t][0] for t in paired) / len(paired)
    up = sum(1 for t in paired if new[t][0] > base[t][0])
    down = sum(1 for t in paired if new[t][0] < base[t][0])
    print(f"  配对均值(n={len(paired)}): {b:.3f} → {n:.3f}   (↑{up} 题 / ↓{down} 题)")
    print(f"  ⚠️ 分母是 {len(paired)},不是 10 —— 引用这个数时必须带上 n。")
    print("  ⚠️ 逐题表才是结论(§12.1.1):n 这么小,均值极易被一题带偏。")
