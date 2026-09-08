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

| agent | 权限档取数源 | 主语 |
| --- | --- | --- |
| sid-code | `agent/sid-home/logs/permissions-audit.log` 的 **deny 实际条数** | **观测**(checker 自己记的) |
| mini-swe-agent | `agent/mini-swe-agent.trajectory.json` 的 `info.config.agent.mode` | 配置 |
| claude-code | `agent/claude-code.txt` 的 `result.permission_denials` 长度 | **agent 自述** |

⚠️ **两侧都要看观测值,不看声明值**。我们这侧尤其如此:命令行传了
`--dangerously-skip-permissions` 只证明"我请求了",三个已实测的坑全是
"请求了但没生效且不报错"(见 sid_code_agent.py 的 CLI_FLAGS 注释)。

## 🔴 cc 侧这一格比 sid 侧**弱**,报的时候必须说清楚(2026-09-08 加)

cc 只有 agent 自述的 `permission_denials`,**没有 allow 计数**。
⇒ sid 侧那条「`allow > 0` 作为反向自证」在 cc 上**做不到**:
sid 的 `deny=0 且 allow>0` 能证明"审计层真的在记、且真的零拒绝",
而 cc 的 `denials=0` **区分不出**「真零拒绝」与「压根没采到」。

⛔ **所以不许把两侧的数字合成一列**假装同源 —— 那正是 05 号那个 61pp 假数的成因
(同题/同模型/同容器/同 verifier 全核过了,唯独漏了权限这一层)。
本脚本对 cc 侧的判定只到「没有反证」,⛔ 不写「已确认同档」。

用法:
    python3 check-comparison-parity.py runs/permswitch-r2 runs/a11-mswea
    python3 check-comparison-parity.py runs/w3-sid-sonnet-72 runs/w3-cc-sonnet-72
                                       └ 对照侧的臂由 config.json 自动判,⛔ 不看目录名
"""
import json, glob, os, sys, collections

# ⚠️ 「agent 到底跑过没有」只在 verifier_health 里定义一处 —— 本文件不重复实现。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verifier_health import agent_ran  # noqa: E402

# cc 侧取数同理:唯一定义处在 arm_health,⛔ 不在本文件解析 claude-code.txt。
from arm_health import cc_denials, cc_turns, detect_arm  # noqa: E402


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
        ran = None
        try:
            ran = agent_ran(json.load(open(f)))
        except Exception:
            pass
        out[task] = {"deny": c.get("deny", 0), "allow": c.get("allow", 0),
                     "have_log": os.path.isfile(a), "requested": req, "agent_ran": ran}
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


def cc_side(run):
    """cc 侧:`result.permission_denials` 的长度(**自述**)+ 零调用判据。

    ⚠️ 取数一律走 `arm_health`,⛔ 不在这里自己解析 `claude-code.txt` ——
    「同一判据两份拷贝」是这个目录已经踩过的错。
    """
    out = {}
    for f in sorted(glob.glob(os.path.join(run, "*", "result.json"))):
        tdir = os.path.dirname(f)
        task = os.path.basename(tdir).split("__")[0]
        ran = None
        try:
            ran = agent_ran(json.load(open(f)))
        except Exception:
            pass
        out[task] = {
            "deny": cc_denials(tdir),   # None = 没采到,⛔ 不是 0
            "turns": cc_turns(tdir),
            "agent_ran": ran,
        }
    return out


def detect_side(run):
    """这个 run 是哪条臂 —— 取第一个 trial 的 `config.json`,⛔ 不看目录名。

    🔴 这一条本身就是 08 号 §9.2-⑦ 那个真错的检测器:漏 `SID_W3_ARM=cc` 时
    driver 默认跑 sid,却产出一个名叫 `w3-cc-sonnet-72` 的 job ——
    **目录名说 cc、里面是 sid,两侧都不报错**,到汇总才发现"对照"两边是同一个 harness。
    """
    for d in sorted(glob.glob(os.path.join(run, "*__*"))):
        arm = detect_arm(d)
        if arm:
            return arm
    return None


sid_run, other_run = sys.argv[1], sys.argv[2]
S = sid_side(sid_run)

# 对照侧的臂**按内容判**,而不是让调用方在参数里声明。
other_arm = detect_side(other_run)
if other_arm == "cc":
    M, other_label = cc_side(other_run), "claude-code"
elif other_arm == "mswea":
    M, other_label = mswea_side(other_run), "mini-swe-agent"
elif other_arm == "sid":
    # 🔴 两侧都是 sid ⇒ 这不是跨 harness 对照。必须显式拦住,否则会产出一份
    # 看起来完好的「对照报告」,而它比较的是同一个 harness 的两次运行。
    print(f"=== 对照口径核验 ===\n  ⛔ 对照侧 {other_run} 的 agent 也是 **sid-code**")
    print("     ⇒ 这不是跨 harness 对照。若本意是 cc 臂,检查开跑命令是否漏了")
    print("        `SID_W3_ARM=cc`(08 号 §9.2-⑦:目录名说 cc、里面是 sid,两侧都不报错)。")
    print("     若本意就是「同 harness 换模型」,请用 analyze-model-switch.py。")
    raise SystemExit(2)
else:
    print(f"=== 对照口径核验 ===\n  ⛔ 判不出 {other_run} 是哪条臂"
          f"(config.json 的 agent.name 缺失或是新 agent)")
    print("     ⛔ 不猜 —— 猜错会把两侧口径对错,而报告照样长得很整齐。")
    raise SystemExit(2)

print(f"=== 对照口径核验 ===\n  sid-code : {sid_run}\n  {other_label:<9}: {other_run}"
      f"  (臂由 config.json 判定)\n")
common = sorted(set(S) & set(M))
if not common:
    print("  ⛔ 两侧没有同名题目 —— 对照本身不成立(先核 -d 数据集与题目子集)")
    raise SystemExit(1)

_other_col = "cc denials" if other_arm == "cc" else "mswea mode"
hdr = f'  {"题":<26}{"sid deny":>9}{"sid allow":>10}  {_other_col:<12}  判定'
print(hdr); print("  " + "-" * (len(hdr) - 2))
bad = []
skipped = []   # 零调用:不参与对照,也**不算**档位不一致
weak = []      # cc 侧:没有反证,但也拿不到 sid 那种反向自证 ⇒ 单独一档
for t in common:
    s, m = S[t], M[t]
    # ⚠️ 这一条必须排在「无审计日志」**之前**。零调用的题**必然**没有审计日志
    # (agent 压根没起来),于是会被上一版误判成「⚠️ 无审计日志」并计入 bad ——
    # 结论行就会写成「N/M 题的权限档不同源，两轮分数不可互比」。
    # 那是**归因错误**:这题的问题不是权限档,是它压根没跑过(网关 502 / 上游额度耗尽)。
    # 实测:polyglot-c-py 曾让结论报「1/3 题权限档不同源」,而它的真实状态是零调用。
    # 权限档对照**排除**这种样本,而不是把它算成一次档位不一致。
    if s["agent_ran"] is False:
        verdict = "➖ 不参与对照:agent 零 API 调用(基础设施故障)"; skipped.append(t)
        other_cell = "—"
    elif not s["have_log"]:
        verdict = "⚠️ 无审计日志(未采到,≠零拒绝)"; bad.append(t)
        other_cell = "—"
    elif other_arm == "cc":
        # 🔴 cc 侧只有**自述**的 denials,没有 allow ⇒ 判定强度天生弱于 sid 侧。
        # 三态必须分开报:None(没采到)/ >0(真有拒绝)/ 0(没有反证,但证不了"审计层在记")。
        other_cell = "None(未采到)" if m["deny"] is None else str(m["deny"])
        if m["deny"] is None:
            # ⛔ 不许当成 0 —— 「看着像 0 denials」正是 08 号 §4.1.1 警告的形态。
            verdict = "⚠️ cc 侧未采到 denials(≠零拒绝)"; bad.append(t)
        elif m["deny"] > 0:
            verdict = f"⛔ 不可比:cc 侧有 {m['deny']} 次拒绝"; bad.append(t)
        elif s["deny"] > 0:
            verdict = f"⛔ 不可比:sid 有 {s['deny']} 次拒绝、cc 侧 0"; bad.append(t)
        else:
            # 两侧都是 0。sid 侧有 allow>0 作反向自证,cc 侧**没有** ⇒ 只能说"无反证"。
            verdict = ("✅ 无反证(sid 有 allow 自证;cc 侧无 allow 计数,仅自述)"
                       if s["allow"] > 0 else
                       "⚠️ 双 0 但 sid allow 也是 0 —— 审计层可能没记")
            (weak if s["allow"] > 0 else bad).append(t)
    elif s["deny"] > 0 and m["mode"] == "yolo":
        verdict = "⛔ 不可比:我们有拒绝、对方零确认"; bad.append(t)
        other_cell = str(m["mode"])
    elif s["deny"] == 0 and m["mode"] == "yolo":
        verdict = "✅ 同档(双方均零拦阻)"
        other_cell = str(m["mode"])
    else:
        verdict = f"⚠️ 需人工判:mode={m['mode']}"; bad.append(t)
        other_cell = str(m["mode"])
    print(f'  {t:<26}{s["deny"]:>9}{s["allow"]:>10}  {other_cell:<12}  {verdict}')

only_s, only_m = sorted(set(S) - set(M)), sorted(set(M) - set(S))
if only_s or only_m:
    print(f"\n  ⚠️ 题目不对齐:仅 sid 有 {only_s}；仅 {other_label} 有 {only_m}")

print(f"\n=== 结论 ===")
# ⚠️ 分母必须是「参与对照的题数」,不是 len(common)。零调用的题被排除在对照之外,
# 留在分母里会把比例稀释 —— 而「分母比分子重要」是本仓的通用铁律。
judged = len(common) - len(skipped)
if skipped:
    print(f"  ➖ {len(skipped)} 题不参与对照(agent 零 API 调用,基础设施故障): {skipped}")
    print(f"     它们**不算**档位不一致 —— 归因是网关/上游,不是权限档。要补跑见 run-permission-switch.sh。")
if judged <= 0:
    print(f"  ⛔ 参与对照的题数为 0 —— 这不是「✅ 全部同档」,是没有任何样本可比。")
    print(f"     (空集上 all() 恒真:这一条专防「零样本报全绿」。)")
elif bad:
    print(f"  ⛔ {len(bad)}/{judged} 题的权限档不同源 —— **这两轮的分数不可互比**")
    print(f"     涉及: {bad}")
elif other_arm == "cc":
    # 🔴 cc 侧刻意**不写「已确认同档」**。它拿不到 allow 计数 ⇒ 证不出
    # 「审计层真的在记」,只能说「没有反证」。把这两件事写成同一句话,
    # 就是 05 号那个 61pp 假数的形态(核过了四项,漏的那项被记进了能力差异)。
    print(f"  ✅ {len(weak)}/{judged} 题**无反证**:sid 侧 deny=0 且 allow>0(观测自证),"
          f"cc 侧自述 denials=0")
    print("     🔴 但这**弱于** mswea 那种同档判定:cc **没有 allow 计数** ⇒")
    print("        它的 `denials=0` 区分不出「真零拒绝」与「压根没采到」。")
    print("     ⇒ 报告里写「两侧权限层均无拦阻记录」,⛔ 别写「已确认同档」。")
    print("     (⚠️ 仍只覆盖权限这一个变量;同题/同模型/同容器/同 verifier 各自核)")
else:
    print(f"  ✅ {judged}/{judged} 题双方均零拦阻 —— 权限层已不再是混入的变量")
    print(f"     (⚠️ 这只解决了权限这一个变量,同题/同模型/同容器/同 verifier 仍需各自核)")

# 请求值只作参考:它证明不了生效,所以单独一行、且明确标注
reqs = {v["requested"] for v in S.values() if v["requested"]}
if reqs:
    print(f"\n  参考(非判据):sid 侧命令行请求的档位 = {reqs}")
    print(f"  ⚠️ 请求值不能当判据 —— 上面的 deny 条数才是观测值。")
