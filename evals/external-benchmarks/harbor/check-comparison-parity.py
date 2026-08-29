#!/usr/bin/env python3
"""对照实验的**口径核验**:两侧的权限/确认层是不是同一档。

## 它为什么必须存在(§17.5 第二优先的教训)

A10 那次三 agent 对照(sid-code 0.100 vs mini-swe-agent 0.714)**不是单变量**:
mswea 跑在 `mode: yolo`(零确认),我们跑在 `acceptEdits`(144 次拒绝)。
**同题、同模型、同容器、同 verifier 全都核过了 —— 唯独没核这一层**,
于是那 61pp 的差距里混着一个我们自己配上去的变量。

> **教训的形态**:变量控制清单漏一项,漏的那项就会被整体记进"能力差异"。
> 清单本身必须是可执行的判据,不是"我记得核过了"。

## 判据(两侧取数源不同,这是必须的)

| agent | 权限档取数源 |
| --- | --- |
| sid-code | `agent/sid-home/logs/permissions-audit.log` 的 **deny 实际条数**(观测) |
| mini-swe-agent | `agent/mini-swe-agent.trajectory.json` 的 `info.config.agent.mode` |

⚠️ **两侧都要看观测值,不看声明值**。我们这侧尤其如此:命令行传了
`--dangerously-skip-permissions` 只证明"我请求了",三个已实测的坑全是
"请求了但没生效且不报错"(见 sid_code_agent.py 的 CLI_FLAGS 注释)。

用法:
    python3 check-comparison-parity.py runs/permswitch-r2 runs/a11-mswea
"""
import json, glob, os, sys, collections


def sid_side(run):
    """sid-code 侧:每题的 deny/allow 实际条数 + metadata 里的请求值。"""
    out = {}
    for f in sorted(glob.glob(os.path.join(run, "*", "result.json"))):
        tdir = os.path.dirname(f)
        task = os.path.basename(tdir).split("__")[0]
        c = collections.Counter()
        a = os.path.join(tdir, "agent", "sid-home", "logs", "permissions-audit.log")
        if os.path.isfile(a):
            for l in open(a, errors="replace"):
                try:
                    c[json.loads(l).get("decision")] += 1
                except Exception:
                    pass
        req = None
        try:
            md = ((json.load(open(f)).get("agent_result") or {}).get("metadata")) or {}
            req = md.get("sid_permission_mode_requested")
        except Exception:
            pass
        out[task] = {"deny": c.get("deny", 0), "allow": c.get("allow", 0),
                     "have_log": os.path.isfile(a), "requested": req}
    return out


def mswea_side(run):
    """mswea 侧:info.config.agent.mode(yolo = 零确认)。"""
    out = {}
    for f in sorted(glob.glob(os.path.join(run, "*", "agent", "mini-swe-agent.trajectory.json"))):
        task = os.path.basename(os.path.dirname(os.path.dirname(f))).split("__")[0]
        mode = None
        try:
            d = json.load(open(f))
            mode = (((d.get("info") or {}).get("config") or {}).get("agent") or {}).get("mode")
        except Exception:
            pass
        out[task] = {"mode": mode}
    return out


sid_run, mswea_run = sys.argv[1], sys.argv[2]
S, M = sid_side(sid_run), mswea_side(mswea_run)

print(f"=== 对照口径核验 ===\n  sid-code : {sid_run}\n  mswea    : {mswea_run}\n")
common = sorted(set(S) & set(M))
if not common:
    print("  ⛔ 两侧没有同名题目 —— 对照本身不成立(先核 -d 数据集与题目子集)")
    raise SystemExit(1)

hdr = f'  {"题":<26}{"sid deny":>9}{"sid allow":>10}  {"mswea mode":<12}  判定'
print(hdr); print("  " + "-" * (len(hdr) - 2))
bad = []
for t in common:
    s, m = S[t], M[t]
    if not s["have_log"]:
        verdict = "⚠️ 无审计日志(未采到,≠零拒绝)"; bad.append(t)
    elif s["deny"] > 0 and m["mode"] == "yolo":
        verdict = "⛔ 不可比:我们有拒绝、对方零确认"; bad.append(t)
    elif s["deny"] == 0 and m["mode"] == "yolo":
        verdict = "✅ 同档(双方均零拦阻)"
    else:
        verdict = f"⚠️ 需人工判:mode={m['mode']}"; bad.append(t)
    print(f'  {t:<26}{s["deny"]:>9}{s["allow"]:>10}  {str(m["mode"]):<12}  {verdict}')

only_s, only_m = sorted(set(S) - set(M)), sorted(set(M) - set(S))
if only_s or only_m:
    print(f"\n  ⚠️ 题目不对齐:仅 sid 有 {only_s}；仅 mswea 有 {only_m}")

print(f"\n=== 结论 ===")
if bad:
    print(f"  ⛔ {len(bad)}/{len(common)} 题的权限档不同源 —— **这两轮的分数不可互比**")
    print(f"     涉及: {bad}")
else:
    print(f"  ✅ {len(common)}/{len(common)} 题双方均零拦阻 —— 权限层已不再是混入的变量")
    print(f"     (⚠️ 这只解决了权限这一个变量,同题/同模型/同容器/同 verifier 仍需各自核)")

# 请求值只作参考:它证明不了生效,所以单独一行、且明确标注
reqs = {v["requested"] for v in S.values() if v["requested"]}
if reqs:
    print(f"\n  参考(非判据):sid 侧命令行请求的档位 = {reqs}")
    print(f"  ⚠️ 请求值不能当判据 —— 上面的 deny 条数才是观测值。")
