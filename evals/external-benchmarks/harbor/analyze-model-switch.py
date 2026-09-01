#!/usr/bin/env python3
"""W2② 换模型验证的判据分析 —— **机理，不是分数**。

    python3 analyze-model-switch.py runs/<deepseek job> [runs/<sonnet 同档基线 job>]

## ⛔ 这个脚本刻意**不报「谁更准」**

换模型同时换掉了「模型能力」这个我们控制不了的变量，所以两侧 reward 之差
**不归因于 harness**。n=10 时 SE≈15pp，9 与 8 统计上区分不开 —— 拿它比大小
就从「harness 验证」跑偏成「模型横评」了。

reward 仍然打印，但打在「仅供参考」区，且**不做差值判定**。

## 判据（全部是机理型，期望「与模型无关」）

| # | 判据 | 期望 | 修复来源 |
| ① | 权限 deny 数 | **0**（与 sonnet 同） | #141 权限档。若 deepseek 侧 >0，说明那条 144→0 是**模型相关**的 |
| ② | 撞满轮数上限的题数 | 与 sonnet 同量级 | #138 轮数预算 |
| ③ | 降级链是否再次打空 | 无 `llm_fatal` | #142 fallback / #119 429 重试 |
| ④ | exit_status / subtype 可读 | 非 unknown | #126 |
| ⑤ | 仪器字段是否都落到了 | 无 None | #143 |

⚠️ **判据 ①-⑤ 的取数一律复用 `verifier_health.py`**，不在本文件另写一份 ——
「同一判据两份拷贝」是这个目录已经踩过的错（`analyze-prefix.py` 的注释记着）。

## ⚠️ 两侧比对的前提：必须是**同档**

`-n` 是第 8 个必控变量（W0 把它从 1 改到 6）。本脚本会**主动核对两侧的 `-n`**，
不一致就拒绝并排 —— 不核对的形态是「表格看起来很整齐，但两列不可比」。
"""

from __future__ import annotations

import collections
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# ⚠️ import 在 sys.path 之后，是刻意的（要先把本目录加进去）。
from verifier_health import (
    agent_ran,
    llm_fatal,
    self_reported_success,
    verifier_ran,
)

#: 轮数上限。与 `sid_code_agent.py` 的默认预算一致；写死在这里是为了让
#: 「撞满」这个判据有明确阈值。⚠️ 若哪天改了 agent 的默认值，这里必须同步 ——
#: 不同步的形态是「撞满题数恒为 0」，一个静默失效的判据。
MAX_TURNS = int(os.environ.get("SID_MODELSWITCH_MAX_TURNS", "40"))


def _settings_of(trial_dir: str) -> dict:
    """读容器内那份 settings.json（agent 真正用的配置）。

    ⚠️ 取它而不取我们传进去的环境变量：环境变量是**意图**，这份文件是
    **落到容器里的事实**。两者不一致过（`_render_settings` 的回落值是硬编码的
    "openai"），而那种不一致只有对比事实侧才发现得了。
    """
    f = os.path.join(trial_dir, "agent", "sid-home", "settings.json")
    if not os.path.isfile(f):
        return {}
    try:
        return json.load(open(f, encoding="utf-8"))
    except Exception:
        return {}


def _model_of(trial_dir: str) -> str | None:
    """本轮真正发给厂商的 wire model（`availableModels[0].modelId`）。

    ⚠️ 不取顶层 `model` —— 那是**本地别名**（实测恒为 "harbor-gateway"），
    对「跑的是哪个模型」这个问题恒答错。别名 vs 真名的区分见
    `packages/core/src/llm/wire-model.ts` 的表。
    """
    am = (_settings_of(trial_dir).get("availableModels") or [{}])[0]
    return am.get("modelId") or None


def _provider_of(trial_dir: str) -> str | None:
    am = (_settings_of(trial_dir).get("availableModels") or [{}])[0]
    return am.get("provider") or None


def load_run(run_dir: str) -> tuple[list[dict], dict]:
    """读一个 job 目录 → (逐题行, job 级信息)。"""
    rows = []
    for f in sorted(glob.glob(os.path.join(run_dir, "*", "result.json"))):
        tdir = os.path.dirname(f)
        task = os.path.basename(tdir).split("__")[0]
        d = json.load(open(f))
        ar = d.get("agent_result") or {}
        md = ar.get("metadata") or {}
        reward = ((d.get("verifier_result") or {}).get("rewards") or {}).get("reward")

        # 权限 deny：**数审计日志的观测值**，不信 metadata 自述。
        # 两者都取是刻意的：不一致本身就是一个发现（仪器 vs 事实）。
        deny = allow = None
        a = os.path.join(tdir, "agent", "sid-home", "logs", "permissions-audit.log")
        if os.path.isfile(a):
            c = collections.Counter()
            for line in open(a, errors="replace"):
                try:
                    c[json.loads(line).get("decision")] += 1
                except Exception:
                    pass
            deny, allow = c.get("deny", 0), c.get("allow", 0)

        rows.append(
            dict(
                task=task,
                reward=reward,
                deny=deny,
                allow=allow,
                md_deny=md.get("sid_permission_denials"),
                req_mode=md.get("sid_permission_mode_requested"),
                turns=md.get("sid_num_turns"),
                stolen=md.get("sid_num_turns_without_model_interaction"),
                subtype=md.get("sid_subtype"),
                # ⚠️ 键名是 `sid_stop_reason`，**不是** `sid_exit_status`。
                # 我第一版写后者，结果「缺 10/10」被打成 🔴 仪器缺失 —— 而真相是
                # 字段名猜错了。**结论与预期矛盾时先怀疑仪器（含读取仪器的这段代码）**，
                # 判据必须指到源字段：`jq '.agent_result.metadata|keys'`。
                stop_reason=md.get("sid_stop_reason"),
                is_error=md.get("sid_is_error"),
                # 模型名**不在 metadata 里**（实测 19 个键里没有），唯一可靠源是
                # 容器 settings.json 的 availableModels[0]。这一层很重要：它是
                # 「这一轮到底跑的是哪个模型」的**观测证据**，不是我们自己传了什么。
                model=_model_of(tdir),
                provider=_provider_of(tdir),
                commit=(md.get("sid_commit") or "")[:12],
                cost=ar.get("cost_usd"),
                cost_src=md.get("sid_cost_source"),
                tok_in=ar.get("n_input_tokens"),
                tok_out=ar.get("n_output_tokens"),
                verifier_broken=not verifier_ran(tdir),
                agent_ran=agent_ran(d),
                llm_fatal=llm_fatal(d, tdir),
                self_reported=self_reported_success(d),
            )
        )

    job = {}
    jf = os.path.join(run_dir, "result.json")
    if os.path.isfile(jf):
        jd = json.load(open(jf))
        job = {
            "started_at": jd.get("started_at"),
            "finished_at": jd.get("finished_at"),
            "n_errored_trials": jd.get("n_errored_trials"),
        }
    return rows, job


def concurrency_of(run_dir: str) -> int | None:
    """从 job 目录里读出这一轮用的 `-n`。

    ⚠️ 为什么必须读到它：`-n` 是第 8 个必控变量（W0 把它从 1 改到 6），
    两侧 `-n` 不同就不可并排。读不到时返回 None，**由调用方拒绝并排**
    —— 不是默认「大概一样吧」放行，那正是「假绿」。

    判据：job 级 result.json 若有 `n_concurrent` 直接用；否则退化到
    **实测重叠数**（同一时刻有几个 trial 在跑），这比猜一个默认值强。
    """
    jf = os.path.join(run_dir, "result.json")
    if os.path.isfile(jf):
        jd = json.load(open(jf))
        for k in ("n_concurrent", "n_concurrent_trials", "concurrency"):
            if isinstance(jd.get(k), int):
                return jd[k]
    # 退化判据：按 trial 的起止时间算最大重叠。同级字段配对，**不跨级**
    # （job 级是本地裸值、trial 级带 Z，混用会得到负数耗时 —— W0 踩过）。
    events = []
    for f in glob.glob(os.path.join(run_dir, "*", "result.json")):
        d = json.load(open(f))
        s, e = d.get("started_at"), d.get("finished_at")
        if s and e:
            events += [(s, 1), (e, -1)]
    if not events:
        return None
    cur = peak = 0
    for _, delta in sorted(events, key=lambda x: (x[0], -x[1])):
        cur += delta
        peak = max(peak, cur)
    return peak


def summarize(label: str, rows: list[dict], job: dict, run_dir: str) -> dict:
    n = len(rows)
    print(f"\n{'=' * 78}\n### {label}  ({run_dir}, {n} 题)\n{'=' * 78}")
    if not n:
        print("  ⛔ 目录里没有 trial —— 不是「全对」，是**没跑**。")
        return {}

    hdr = (f'{"题":<26}{"rew":>5}{"deny":>6}{"allow":>6}{"turns":>6}'
           f'{"stolen":>7}  {"subtype":<22}{"stop":<12}{"$":>8}')
    print(hdr)
    print("-" * len(hdr))
    for r in sorted(rows, key=lambda x: x["task"]):
        cost = f'{r["cost"]:.4f}' if isinstance(r["cost"], (int, float)) else "-"
        flags = ""
        if r["verifier_broken"]:
            flags += " ⚠verifier未判分"
        if r["agent_ran"] is False:
            flags += " ⚠零调用"
        if r["llm_fatal"]:
            flags += " ⚠上游打断"
        if r["self_reported"]:
            flags += " ⚠自报成功却0分"
        if isinstance(r["turns"], int) and r["turns"] >= MAX_TURNS:
            flags += f" ⚠撞满{MAX_TURNS}轮"
        print(f'{r["task"]:<26}{str(r["reward"]):>5}{str(r["deny"]):>6}{str(r["allow"]):>6}'
              f'{str(r["turns"]):>6}{str(r["stolen"]):>7}  {str(r["subtype"]):<22}'
              f'{str(r["stop_reason"]):<12}{cost:>8}{flags}')

    # ── 判据 ①：权限 deny（#141 那条 144→0 的因果链，期望与模型无关）──────────
    have = [r for r in rows if r["deny"] is not None]
    d_tot = sum(r["deny"] for r in have)
    a_tot = sum(r["allow"] for r in have)
    print(f"\n=== 判据 ①：权限 deny（期望 0；换档前基线是 144 deny / 178 allow）===")
    if not have:
        print(f"  ⚠️ **10/10 题都没有审计日志 —— 本判据未生效**，不是「0 deny」。")
        print(f"     ⛔ 这两种情况在表格里长得一样（都显示 None），但结论完全相反。")
    else:
        print(f"  {d_tot} deny / {a_tot} allow（{len(have)}/{n} 题有审计日志）")
        if d_tot == 0 and a_tot > 0:
            print(f"  ✅ deny=0 且 allow>0 —— allow>0 是**反向自证**：证明审计层真的在记，"
                  f"而不是「日志为空所以数出来是 0」")
        elif d_tot == 0 and a_tot == 0:
            print(f"  ⚠️ deny=0 但 allow 也是 0 —— **这不能算通过**：审计层可能压根没记。")
        else:
            print(f"  🔴 deny={d_tot} > 0 —— 若 sonnet 侧是 0，说明 #141 那条修复**与模型有关**，"
                  f"这才是本轮要找的真发现（很可能在方言层）")
    # metadata 自述 vs 审计实数：不一致本身是发现（仪器 vs 事实）
    cmp_ = [(r["task"], r["md_deny"], r["deny"]) for r in rows
            if r["md_deny"] is not None and r["deny"] is not None]
    if cmp_:
        bad = [c for c in cmp_ if c[1] != c[2]]
        print(f"  仪器自证：metadata deny 与审计实数比对 {len(cmp_)}/{n} 题，"
              f"不一致 {len(bad)} 处 {bad if bad else ''}")
    else:
        print(f"  ⚠️ 无法比对 metadata deny 与审计实数（至少一侧全缺）")

    # ── 判据 ②：轮数（#138）────────────────────────────────────────────────
    maxed = [r["task"] for r in rows if isinstance(r["turns"], int) and r["turns"] >= MAX_TURNS]
    turns = [r["turns"] for r in rows if isinstance(r["turns"], int)]
    print(f"\n=== 判据 ②：轮数预算（上限 {MAX_TURNS}）===")
    print(f"  撞满 {len(maxed)}/{n} 题 {maxed if maxed else ''}"
          + (f"；轮数 {sorted(turns)}" if turns else "；⚠️ 一题都读不到轮数（仪器缺失）"))

    # ── 判据 ③：上游打断（#142 降级链 / #119 429）───────────────────────────
    fatal = [r["task"] for r in rows if r["llm_fatal"]]
    zero = [r["task"] for r in rows if r["agent_ran"] is False]
    unknown_ran = [r["task"] for r in rows if r["agent_ran"] is None]
    print(f"\n=== 判据 ③：上游打断 / 零调用（**这些不是能力失败**）===")
    print(f"  重试链打空 {len(fatal)}/{n} {fatal if fatal else ''}")
    print(f"  一次调用都没发生 {len(zero)}/{n} {zero if zero else ''}")
    if unknown_ran:
        print(f"  ⚠️ {len(unknown_ran)} 题 token 字段缺失、**不可判**（三态的 None，"
              f"不要当成「跑过了」）: {unknown_ran}")

    # ── 判据 ④/⑤：仪器（#126 exit_status / #143）────────────────────────────
    print(f"\n=== 判据 ④/⑤：仪器字段落盘 ===")
    for key, label2 in (("stop_reason", "stop_reason(#126)"), ("subtype", "subtype"),
                        ("stolen", "被偷轮数(#138)"), ("cost", "cost"),
                        ("model", "wire model(容器实测)"), ("provider", "provider(容器实测)")):
        vals = [r[key] for r in rows]
        miss = sum(1 for v in vals if v is None)
        uniq = sorted({str(v) for v in vals if v is not None})
        mark = "🔴" if miss == n else ("⚠️" if miss else "✅")
        print(f"  {mark} {label2:<20} 缺 {miss}/{n}"
              + (f"；取值 {uniq[:6]}" if uniq else ""))

    # ── 仅供参考：reward（**刻意不做两侧差值判定**）──────────────────────────
    rw = [r["reward"] for r in rows if isinstance(r["reward"], (int, float))]
    broken = [r["task"] for r in rows if r["verifier_broken"]]
    sr = [r["task"] for r in rows if r["self_reported"]]
    print(f"\n=== 仅供参考：reward（⛔ 不许拿它与另一模型比大小，见文件头）===")
    print(f"  有分 {len(rw)}/{n}；均值 {sum(rw) / len(rw):.3f}" if rw else "  ⚠️ 一题都没判分")
    if rw:
        print(f"  分布 {collections.Counter(rw)}")
    if broken:
        print(f"  ⚠️ verifier 未判分 {len(broken)} 题 {broken} —— 这些**不进能力账**")
    if sr:
        print(f"  ⚠️ 自报成功却 0 分 {len(sr)} 题 {sr} —— 这些**是**真实能力失败，必须计分")

    tc = [r["cost"] for r in rows if isinstance(r["cost"], (int, float))]
    print(f"\n=== 成本 / 一致性 ===")
    print(f"  合计 ${sum(tc):.4f}（{len(tc)}/{n} 题有值）；"
          f"cost_source {dict(collections.Counter(r['cost_src'] for r in rows))}")
    print(f"  模型 {sorted({str(r['model']) for r in rows})}；"
          f"commit {sorted({r['commit'] for r in rows if r['commit']})}")
    print(f"  权限档 requested {sorted({str(r['req_mode']) for r in rows})}")
    conc = concurrency_of(run_dir)
    print(f"  并发 -n = {conc if conc is not None else '⚠️ 读不到'}"
          f"（W0 定档 6；⚠️ 与 -n 1 的旧 run 不可并排）")
    if job:
        print(f"  job: {job.get('started_at')} → {job.get('finished_at')}；"
              f"errored_trials={job.get('n_errored_trials')}")
    return dict(n=n, deny=d_tot if have else None, allow=a_tot if have else None,
                maxed=len(maxed), fatal=len(fatal), zero=len(zero),
                # ⚠️ **题名**必须带出来，不能只带计数 —— 见并排处那段注释：
                # 两侧各排除 1 题但**排除的是不同的题**时，只比数量会报"对称"。
                excluded=sorted(set(fatal) | set(zero)),
                reward_mean=(sum(rw) / len(rw)) if rw else None,
                cost=sum(tc), conc=conc,
                models=sorted({str(r["model"]) for r in rows}),
                providers=sorted({str(r["provider"]) for r in rows}))


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    if not args:
        sys.exit(__doc__)
    for d in args:
        if not os.path.isdir(d):
            sys.exit(f"⛔ 目录不存在：{d}")

    treat_dir = args[0]
    base_dir = args[1] if len(args) > 1 else None

    t_rows, t_job = load_run(treat_dir)
    t = summarize("换模型侧（treat）", t_rows, t_job, treat_dir)
    if base_dir is None:
        print(f"\n{'=' * 78}")
        print("⚠️ 只给了一个 job —— **没有对照，判据 ①②③ 只能看绝对值**。")
        print("   同档 sonnet 基线：SID_MODELSWITCH_FAMILY=anthropic bash run-model-switch.sh <job>")
        return 0

    b_rows, b_job = load_run(base_dir)
    b = summarize("同档基线（control, sonnet）", b_rows, b_job, base_dir)

    print(f"\n{'=' * 78}\n### 并排：机理判据（⛔ 不含 reward 差值）\n{'=' * 78}")

    # ⚠️ 并排前先核**同档**。不核的形态是「表格很整齐但两列不可比」。
    blockers = []
    if t.get("conc") != b.get("conc"):
        blockers.append(f"并发档不同：treat -n={t.get('conc')} vs control -n={b.get('conc')}")
    if t.get("conc") is None or b.get("conc") is None:
        blockers.append("至少一侧读不到 -n —— **不放行**（读不到 ≠ 一样）")
    # 🔴 **模型没换成 = 本轮什么都没验到**，必须当 blocker 拦掉。
    # 变异自证揪出的真 bug：第一版只在"仅供参考"区打一行提醒，而下面的
    # 「一句话结论」照样打 ✅「修复在另一族成立」—— 一个**自相矛盾的假绿**，
    # 且恰好出现在最该拦的场景（两侧其实是同一个模型）。
    # ⚠️ 判据取**容器 settings.json 的 modelId**（观测事实），不取我们传的环境变量（意图）。
    if t.get("models") == b.get("models"):
        blockers.append(
            f"两侧 wire model 相同（都是 {t.get('models')}）—— **模型压根没换成**，"
            f"本轮什么都没验到。检查 -m 的 provider/model 段与 shim 的 --model-name"
        )
    for lbl, side in (("control", b), ("treat", t)):
        if len(side.get("models") or []) != 1:
            blockers.append(f"{lbl} 侧出现多个 wire model {side.get('models')} —— 该侧整轮不可比")
    t_tasks = {r["task"] for r in t_rows}
    b_tasks = {r["task"] for r in b_rows}
    if t_tasks != b_tasks:
        only_t, only_b = sorted(t_tasks - b_tasks), sorted(b_tasks - t_tasks)
        blockers.append(f"题目集不同（分母装的不是同一批题）：仅 treat {only_t}；仅 control {only_b}")
    if blockers:
        print("🔴 **拒绝并排**，理由：")
        for x in blockers:
            print(f"   - {x}")
        print("   ⚠️ 这正是「0.100→0.750 是假数」那条教训的成因：两侧分母装的不是同一批题。")
        return 1

    def cell(v):
        return "None(未采到)" if v is None else str(v)

    print(f'{"判据":<28}{"control(sonnet)":>18}{"treat(deepseek)":>18}   结论')
    print("-" * 92)
    rows_out = [
        ("① 权限 deny 总数", b.get("deny"), t.get("deny"),
         "期望两侧同为 0；treat>0 ⇒ #141 与模型有关"),
        ("① allow 总数（反向自证）", b.get("allow"), t.get("allow"),
         "必须 >0，否则「deny=0」可能是审计层没记"),
        (f"② 撞满 {MAX_TURNS} 轮题数", b.get("maxed"), t.get("maxed"),
         "同量级即 #138 与模型无关"),
        ("③ 重试链打空题数", b.get("fatal"), t.get("fatal"),
         "期望两侧皆 0；仅一侧有 ⇒ 该侧被系统性压低"),
        ("③ 零调用题数", b.get("zero"), t.get("zero"),
         "非能力失败，不进能力账"),
    ]
    for name, bv, tv, note in rows_out:
        print(f"{name:<28}{cell(bv):>18}{cell(tv):>18}   {note}")

    # ── 🔴 非能力失败的**不对称分布**：必须显式告警，不能只印一行注释 ──────────
    #
    # `verifier_health.llm_fatal` 的 docstring 记着这条：基线 0/10、另一轮 3/7 时，
    # 若把这些样本留在分母里，**带故障的那一轮被系统性压低** —— 而压低的方向
    # 恰好会让结论看起来更弱（排除得太宽则更强）。**两个方向都是造假。**
    #
    # 2026-09-01 实测就撞上了：deepseek 侧 `qemu-alpine-ssh` 被 402（余额耗尽）
    # 打断，而 sonnet 侧无此样本。此时两侧的**有效分母不同**（9 vs 10），
    # 任何按 10 算的比较都掺了一次账户故障。
    ex_t, ex_b = set(t.get("excluded") or []), set(b.get("excluded") or [])
    print()
    # ⚠️ 判据是**题名集合**，不是计数。2026-09-01 实测踩到：deepseek 侧排除
    # `qemu-alpine-ssh`（402 余额耗尽）、sonnet 侧排除 `regex-log`（40 次 502
    # 零调用成功）—— **1 vs 1**，只比数量会报"对称，不构成偏倚"，
    # 而真相是**两侧分母装的不是同一批题**。那正是 `0.100 → 0.750` 那个假数的成因。
    if ex_t != ex_b:
        print(f"🔴 **非能力失败的分布不对称** —— 判据是题名集合，不是数量：")
        print(f"   control 排除 {len(ex_b)} 题 {sorted(ex_b) if ex_b else '（无）'}")
        print(f"   treat   排除 {len(ex_t)} 题 {sorted(ex_t) if ex_t else '（无）'}")
        if len(ex_t) == len(ex_b):
            print("   ⚠️ **数量相同但题目不同** —— 这比数量不同更危险：只比计数会报「对称」放行，")
            print(f"      而两侧分母装的其实不是同一批题（`0.100 → 0.750` 假数的成因）。")
        only = sorted((ex_t | ex_b) - (ex_t & ex_b))
        print(f"   ⇒ **可比的公共分母只有 {t['n'] - len(ex_t | ex_b)} 题**"
              f"（两侧都干净的那些）；{len(only)} 题只在一侧被排除：{only}")
        print(f"   ⚠️ 机理判据（deny/轮数/仪器）**不受影响** —— 它们逐题看，不吃分母。")
        print(f"   ⛔ 但**任何按各自原分母算的比较都掺了基础设施故障**。要比就比那"
              f"{t['n'] - len(ex_t | ex_b)} 题的公共子集。")
    elif ex_t:
        print(f"⚠️ 两侧排除的是**同一批** {len(ex_t)} 题 {sorted(ex_t)}（真对称，不构成偏倚），"
              f"有效分母各 {t['n'] - len(ex_t)}")
    else:
        print(f"✅ 两侧都没有非能力失败样本，分母干净（各 {t['n']} 题）")

    print(f"\n=== 仅供参考（⛔ 不作判据）===")
    print(f"  reward 均值  control {b.get('reward_mean')}  treat {t.get('reward_mean')}")
    print(f"  ⛔ **不许把这两个数讲成「谁更准」**：换模型同时换掉了「模型能力」这个")
    print(f"     我们控制不了的变量，且 n={t.get('n')}（SE≈15pp）。这不是 harness 的成绩。")
    print(f"  成本  control ${b.get('cost'):.4f}   treat ${t.get('cost'):.4f}")
    print(f"  ⛔ 成本也不可直接比：两家定价不同（deepseek 有峰谷价），差额里混着单价差。")
    print(f"  模型  control {b.get('models')}/{b.get('providers')}"
          f"   treat {t.get('models')}/{t.get('providers')}")
    # ⚠️ 「两侧模型必须不同、且各自唯一」这两条判据在上面的 blockers 里
    # （走到这里就已经过了）。**刻意不在这里重复检查** —— 同一判据两份拷贝
    # 是这个目录踩过的错，两份会漂移，而漂移后没人知道该信哪份。

    print(f"\n=== 一句话结论该怎么写 ===")
    # ⚠️ `deny is None` 表示**审计日志一题都没有**（判据未生效），
    # 而 `deny == 0` 是「真的一次拒绝都没有」。两者在表格里都显示得像"没问题"，
    # 但结论完全相反 —— 所以这里必须先排除 None，再谈 0。
    if b.get("deny") is None or t.get("deny") is None:
        print("  ⚠️ 至少一侧**没有审计日志**（deny=None）—— 判据 ① 未生效，")
        print("     **不能写「修复成立」** ：那会把「没测到」讲成「测过且通过」。")
        return 1
    same_deny = b.get("deny") == t.get("deny") == 0
    if same_deny:
        print("  ✅ 「#141 那条 144 deny → 0 的修复在另一族协议上同样成立」——")
        print("     这是本轮买到的东西：它证明修复不是给某个模型调出来的。")
    else:
        print("  🔴 两侧 deny 不同 ⇒ **这才是真发现**，先别写结论，去读 deny 的具体条目：")
        print("     runs/<job>/*/agent/sid-home/logs/permissions-audit.log")
    return 0


if __name__ == "__main__":
    sys.exit(main())
