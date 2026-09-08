#!/usr/bin/env python3
"""`arm_health.py` 的变异自证。**每条断言都配一条能让它红的变异**(§9.3)。

    python3 test-arm-health.py

## 为什么不是「跑一遍看看输出对不对」

本仓两次踩到同一件事:24/24 全绿的测试里藏着**假绿断言** —— 一条在 bug 存在时
照样绿的断言,等于「多了一行看着安心的字」。所以这份测试的结构是:

  ① 正向:健康形态下判据给出正确答案;
  ② 三态边界:`None` 与 `0` / `False` 严格分开(每一种缺失形态都造一个 fixture);
  ③ **反向变异**:把判据改坏,断言必须红 —— 由 `--self-check` 子命令跑,
     它会真的改写源码副本,而不是「相信它会红」。

## fixture 的形态必须回源码核,⛔ 不许照 metadata 里看到的键名猜

08 号 §4.2 记着这个坑:造假数据时把 token 写进 `metadata.total_*`,
而判据读的是 `agent_result.n_*` —— 于是 fixture 形态与真实数据不一致,
测试测的是一个不存在的形态。所以下面 `_assert_fixture_shape()` 用**真判据回读
自己造的 fixture**,形态不符当场报错并指名是哪个字段。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import arm_health as AH

# 🔴 本 import 是被 CI 门禁**拦出来**的,而它拦得对(2026-09-08)。
#
# `harbor-agent-contract.test.ts` 的「不许自己数 token」发现本文件写了
# `n_input_tokens` / `n_output_tokens`(造 fixture 用)却没 import `agent_ran`
# —— 等于对「这些字段意味着什么」另存了一份理解。
#
# ⚠️ 修法不是放宽门禁,而是让 fixture **用真判据回读自己** ——
# 这与 08 号 §4.2 记的上一次同型裁决逐字一致(那次是 `test-w3-classify.py`)。
# 下面 `_fixture_shape_error()` 因此多了一条:造出来的 token 形态必须让
# `agent_ran` 判成我期望的那一态。它当场就能抓住「token 写错了位置」
# (写进 metadata.total_* 而判据读 agent_result.n_*)这类 fixture 失真。
from verifier_health import agent_ran

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "arm_health.py")

_passed = 0
_failed = 0


def ok(cond: bool, label: str) -> None:
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  ✅ {label}")
    else:
        _failed += 1
        print(f"  ❌ {label}")


# ── fixture 构造 ────────────────────────────────────────────────────────────


def _trial(
    root: str,
    task: str,
    *,
    agent_name: str,
    reward: float | None = 0.0,
    cc_events: list[dict] | None = None,
    cc_traj_extra: dict | None = None,
    n_in: int | None = None,
    n_out: int | None = None,
    n_cache: int | None = None,
    cache_write: int | None = None,
    sid_meta: dict | None = None,
) -> str:
    """造一个 trial 目录。返回它的路径。

    ⚠️ 字段位置逐字对齐真实数据(2026-09-08 实测核过):
      - `agent.name` 在 **config.json** 的 `agent.name`(不是 result.json)
      - token 在 **`agent_result.n_*`**(不是 metadata.total_*)
      - reward 在 **`verifier_result.rewards.reward`**(rewards 是复数)
      - sid 的 metadata 在 **`agent_result.metadata`**(不是顶层)
    """
    td = os.path.join(root, f"{task}__fixture")
    os.makedirs(os.path.join(td, "agent"), exist_ok=True)
    with open(os.path.join(td, "config.json"), "w", encoding="utf-8") as fh:
        json.dump({"agent": {"name": agent_name}}, fh)

    ar: dict = {}
    if n_in is not None:
        ar["n_input_tokens"] = n_in
    if n_out is not None:
        ar["n_output_tokens"] = n_out
    if n_cache is not None:
        ar["n_cache_tokens"] = n_cache
    md = dict(sid_meta or {})
    if cache_write is not None:
        md["cache_write_tokens"] = cache_write
    if md:
        ar["metadata"] = md
    res: dict = {"agent_result": ar}
    if reward is not None:
        res["verifier_result"] = {"rewards": {"reward": reward}}
    else:
        res["verifier_result"] = {"rewards": {}}
    with open(os.path.join(td, "result.json"), "w", encoding="utf-8") as fh:
        json.dump(res, fh)

    if cc_events is not None:
        with open(
            os.path.join(td, "agent", AH.CC_OUTPUT_FILENAME), "w", encoding="utf-8"
        ) as fh:
            for ev in cc_events:
                fh.write(json.dumps(ev) + "\n")
    if cc_traj_extra is not None:
        with open(
            os.path.join(td, "agent", AH.CC_TRAJECTORY_FILENAME), "w", encoding="utf-8"
        ) as fh:
            json.dump({"final_metrics": {"extra": cc_traj_extra}}, fh)
    return td


def _cc_result(**kw) -> dict:
    ev = {"type": "result", "subtype": "success", "num_turns": 7}
    ev.update(kw)
    return ev


def _fixture_shape_error(root: str) -> str | None:
    """🔴 用**真判据**回读自己造的 fixture。返回 `None` = 形态自洽,否则返回哪里不符。

    这一层是 08 号 §4.2 那条教训的落地:不做的话,fixture 字段名写错时
    测试会以「判据返回 None」的形式**绿着失效** —— 它测的是一个不存在的形态。

    ## ⚠️ 为什么**返回错误**而不是 `raise`(初版是 raise,被变异自证抓出来了)

    raise 会让整个进程在 ① 组之前挂掉 ⇒ **零条断言翻红**。于是 M1(把 detect_arm
    改坏)在自证里的表现是「rc≠0 但没有任何 ❌」—— 那不叫「这条防线承重」,
    只叫「程序崩了」,而两者在 rc 上**长得一模一样**。
    ⇒ 现在它是一条正常断言(会翻红、计入失败),**同时仍然让后续测试停手**
    (fixture 不可信时继续跑出来的绿灯没有意义)。两个目的都要,缺一不可。
    """
    td = _trial(
        root,
        "shapecheck",
        agent_name="claude_code_agent:ClaudeCodeNpm",
        cc_events=[_cc_result(num_turns=13, permission_denials=[{"x": 1}])],
        cc_traj_extra={
            "total_cache_read_input_tokens": 100,
            "total_cache_creation_input_tokens": 50,
        },
        n_in=200,
        n_out=9,
    )
    try:
        if AH.detect_arm(td) != "cc":
            return (
                "detect_arm 读的是 config.json 的 agent.name,"
                f"实得 {AH.detect_arm(td)!r}"
            )
        if AH.cc_turns(td) != 13:
            return (
                "cc_turns 读的是 claude-code.txt 里 type=result 事件的 num_turns,"
                f"实得 {AH.cc_turns(td)!r}"
            )
        res = json.load(open(os.path.join(td, "result.json")))
        # 🔴 用**真判据**核 fixture 的 token 形态(门禁要求的那一条,见文件头 import)。
        # 我造的是「跑过」的形态(两个 token 键都有值)⇒ agent_ran 必须判 True。
        # 判成 None 意味着 token 写错了位置(如写进 metadata.total_* 而判据读
        # agent_result.n_*)—— 那正是 08 号 §4.2 记的那个 fixture 失真。
        if agent_ran(res) is not True:
            return (
                "fixture 的 token 形态不符:agent_ran 读的是 "
                "result.agent_result.n_input_tokens / n_output_tokens(Harbor 侧观测),"
                "不是 metadata.total_*。"
                f"tokens=(200, 9) 期望 agent_ran=True,实得 {agent_ran(res)!r}"
            )
        tok = AH.normalized_tokens(res, td)
        if not tok or tok["fresh"] != 50:
            return (
                "normalized_tokens 读的是 agent_result.n_input_tokens(Harbor 侧观测)"
                "减 trajectory.json 的两格 cache,"
                f"期望 fresh=200-100-50=50,实得 {tok and tok.get('fresh')!r}"
            )
    finally:
        shutil.rmtree(td, ignore_errors=True)
    return None


# ── 正向 + 三态边界 ─────────────────────────────────────────────────────────


def run_tests(root: str) -> None:
    # 形态守卫是**一条正常断言**(会翻红、计入失败),而不是一个 raise ——
    # 理由见 `_fixture_shape_error` 的 docstring(初版 raise 让 M1 变成「崩」不是「红」)。
    shape_err = _fixture_shape_error(root)
    ok(shape_err is None, f"fixture 形态自洽{'' if shape_err is None else ':' + shape_err}")
    if shape_err is not None:
        # fixture 不可信 ⇒ 后面的绿灯没有意义,停手。但上面那条已经红了。
        print("  ⛔ fixture 形态不符 —— 停止后续断言(继续跑出来的绿灯不可信)")
        return

    print("\n① detect_arm —— ⛔ 只信 config.json,不看目录名")
    cc = _trial(root, "t1", agent_name="claude_code_agent:ClaudeCodeNpm")
    sid = _trial(root, "t2", agent_name="sid_code_agent:SidCodeAgent")
    mswea = _trial(root, "t3", agent_name="mini-swe-agent")
    ok(AH.detect_arm(cc) == "cc", "cc 臂识别")
    ok(AH.detect_arm(sid) == "sid", "sid 臂识别")
    ok(AH.detect_arm(mswea) == "mswea", "mswea 臂识别")
    # 🔴 08 号 §9.2-⑦ 那个真错:目录名说 cc、里面是 sid。判据必须按内容判。
    mislabeled = _trial(
        root, "w3-cc-sonnet-72-lookalike", agent_name="sid_code_agent:SidCodeAgent"
    )
    ok(
        AH.detect_arm(mislabeled) == "sid",
        "🔴 目录名像 cc 但 agent 是 sid ⇒ 判 sid(这正是漏 SID_W3_ARM=cc 的形态)",
    )
    nocfg = os.path.join(root, "nocfg__fixture")
    os.makedirs(nocfg, exist_ok=True)
    ok(AH.detect_arm(nocfg) is None, "缺 config.json ⇒ None(不可判,⛔ 不是某个默认臂)")

    print("\n② cc 侧字段 —— 三态:None ≠ 0")
    full = _trial(
        root,
        "full",
        agent_name="claude_code_agent:ClaudeCodeNpm",
        cc_events=[
            _cc_result(
                num_turns=41,
                subtype="error_max_turns",
                permission_denials=[],
                ttft_ms=None,
                api_error_status=None,
            )
        ],
    )
    ok(AH.cc_turns(full) == 41, "turns=41 取到")
    ok(AH.cc_subtype(full) == "error_max_turns", "subtype 取到")
    ok(AH.cc_denials(full) == 0, "空数组 ⇒ 0 denials(真的零拒绝)")
    ok(AH.cc_ttft_ms(full) is None, "ttft 为 null ⇒ None")

    deny3 = _trial(
        root,
        "deny3",
        agent_name="claude_code_agent:ClaudeCodeNpm",
        cc_events=[_cc_result(permission_denials=[1, 2, 3])],
    )
    ok(AH.cc_denials(deny3) == 3, "3 条拒绝 ⇒ 3")

    # 边界 A:压根没有 claude-code.txt(实测 ccrun-smoke / a10-smoke-cc)
    notxt = _trial(root, "notxt", agent_name="claude_code_agent:ClaudeCodeNpm")
    ok(AH.cc_turns(notxt) is None, "无 txt ⇒ turns=None")
    ok(
        AH.cc_denials(notxt) is None,
        "🔴 无 txt ⇒ denials=None 而**不是 0** —— 「看着像 0 denials」正是要防的形态",
    )

    # 边界 B:有 txt 但无 result 事件(实测 ccrun-n6-503-aborted)
    noresult = _trial(
        root,
        "noresult",
        agent_name="claude_code_agent:ClaudeCodeNpm",
        cc_events=[{"type": "system", "subtype": "init"}, {"type": "assistant"}],
    )
    ok(AH.cc_turns(noresult) is None, "有 txt 无 result 事件 ⇒ None")
    ok(AH.cc_denials(noresult) is None, "同上 ⇒ denials=None,不是 0")

    # 边界 C:最后一行是半截 JSON(被 SIGKILL 的真实形态)
    trunc = _trial(
        root,
        "trunc",
        agent_name="claude_code_agent:ClaudeCodeNpm",
        cc_events=[_cc_result(num_turns=9)],
    )
    with open(os.path.join(trunc, "agent", AH.CC_OUTPUT_FILENAME), "a") as fh:
        fh.write('{"type":"result","num_tur')
    ok(
        AH.cc_turns(trunc) == 9,
        "🔴 半截行被跳过而不是让整份取数失败(否则 30 个好事件 + 1 截断行 ⇒ 全丢)",
    )

    print("\n③ self_reported_success_cc —— 冲突信号,⛔ 不是排除规则")
    sr = _trial(
        root,
        "sr",
        agent_name="claude_code_agent:ClaudeCodeNpm",
        reward=0.0,
        cc_events=[_cc_result(subtype="success")],
    )
    ok(
        AH.self_reported_success_cc(
            json.load(open(os.path.join(sr, "result.json"))), sr
        ),
        "自报 success + reward=0.0 ⇒ True(真实能力失败,必须计分)",
    )
    notjudged = _trial(
        root,
        "notjudged",
        agent_name="claude_code_agent:ClaudeCodeNpm",
        reward=None,
        cc_events=[_cc_result(subtype="success")],
    )
    ok(
        not AH.self_reported_success_cc(
            json.load(open(os.path.join(notjudged, "result.json"))), notjudged
        ),
        "🔴 reward=None(未判分)⇒ False —— 严格判 ==0.0,否则「仪器坏了」会伪装成「自报喜」",
    )
    maxturns = _trial(
        root,
        "mt",
        agent_name="claude_code_agent:ClaudeCodeNpm",
        reward=0.0,
        cc_events=[_cc_result(subtype="error_max_turns")],
    )
    ok(
        not AH.self_reported_success_cc(
            json.load(open(os.path.join(maxturns, "result.json"))), maxturns
        ),
        "撞满轮数 + 0 分 ⇒ False(不是自报喜,是用完预算没做出来)",
    )

    print("\n④ normalized_tokens —— 🔴 两臂口径相反,这是本模块存在的理由")
    # 实测数(polyglot-c-py):cc n_input 内含 cache,sid 不含
    ccj = _trial(
        root,
        "cctok",
        agent_name="claude_code_agent:ClaudeCodeNpm",
        n_in=139541,
        n_out=439,
        cc_traj_extra={
            "total_cache_read_input_tokens": 102559,
            "total_cache_creation_input_tokens": 34084,
        },
    )
    t = AH.normalized_tokens(json.load(open(os.path.join(ccj, "result.json"))), ccj)
    ok(t is not None and t["fresh"] == 2898, "cc: fresh = 139541-102559-34084 = 2898")
    ok(t is not None and t["total_in"] == 139541, "cc: total_in 就是 n_input(已含 cache)")

    sidj = _trial(
        root,
        "sidtok",
        agent_name="sid_code_agent:SidCodeAgent",
        n_in=4697,
        n_out=1462,
        n_cache=187957,
        cache_write=74779,
    )
    t2 = AH.normalized_tokens(json.load(open(os.path.join(sidj, "result.json"))), sidj)
    ok(t2 is not None and t2["fresh"] == 4697, "sid: fresh 就是 n_input(本来纯 fresh)")
    ok(
        t2 is not None and t2["total_in"] == 4697 + 187957 + 74779,
        "sid: total_in 归一成 fresh+read+write ⇒ 与 cc 同口径",
    )
    # 🔴 归一化的意义:裸比会得到方向相反的结论
    ok(
        t is not None and t2 is not None and t["fresh"] < t2["fresh"] and 139541 > 4697,
        "🔴 裸 n_input 说 cc 是 sid 的 30 倍,归一后 fresh 关系**是反的**(2898<4697)",
    )

    # ⛔ 取错源会算出负数 ⇒ 必须 fail-closed 返 None,不许 clamp 成 0
    neg = _trial(
        root,
        "neg",
        agent_name="claude_code_agent:ClaudeCodeNpm",
        n_in=950403,
        n_out=2365,
        cc_traj_extra={
            "total_cache_read_input_tokens": 736585,  # modelUsage 的值(错源)
            "total_cache_creation_input_tokens": 277138,
        },
    )
    ok(
        AH.normalized_tokens(json.load(open(os.path.join(neg, "result.json"))), neg)
        is None,
        "🔴 fresh<0(取了 modelUsage 而非 trajectory)⇒ None,⛔ 不许 clamp 成 0",
    )

    misstraj = _trial(
        root,
        "misstraj",
        agent_name="claude_code_agent:ClaudeCodeNpm",
        n_in=1000,
        n_out=10,
    )
    ok(
        AH.normalized_tokens(
            json.load(open(os.path.join(misstraj, "result.json"))), misstraj
        )
        is None,
        "cc 缺 trajectory.json ⇒ None(拆不出成分就别猜)",
    )
    mstok = _trial(root, "mstok", agent_name="mini-swe-agent", n_in=1000, n_out=10)
    ok(
        AH.normalized_tokens(
            json.load(open(os.path.join(mstok, "result.json"))), mstok
        )
        is None,
        "未知臂 ⇒ None(⛔ 不猜成分)",
    )
    nocollect = _trial(root, "nocollect", agent_name="sid_code_agent:SidCodeAgent")
    ok(
        AH.normalized_tokens(
            json.load(open(os.path.join(nocollect, "result.json"))), nocollect
        )
        is None,
        "两个 token 键全缺 ⇒ None(复用 agent_ran 的三态)",
    )

    # 🔴 这个 fixture 是**唯一**只有 `agent_ran` 守卫能拦住的形态,
    # 也是那条 import 真正承重的地方(没有它,M6 变异是绿的 —— 实测过)。
    #
    # 形态:cc 臂卡死在启动里(token 键整份缺失),但 `trajectory.json` **存在**
    # 且两格 cache 都是 0(harbor 转了一份空 step 列表)。
    # ⇒ 下游那些 `isinstance(..., int)` 检查**全部通过**(0 是合法 int),
    #   于是绕开 agent_ran 时会算出 fresh=0 / total_in=0 并**正常返回**:
    #
    #       {"fresh": 0, "cache_read": 0, "cache_write": 0, "out": 0, "total_in": 0}
    #
    # 那读起来像「这题真的只用了 0 token」,而真相是「压根没采到」——
    # 正是本仓最怕的静默零(它还会被算进 tokens_normalized 的合计里稀释命中率)。
    crashed_zero = _trial(
        root,
        "crashed_zero",
        agent_name="claude_code_agent:ClaudeCodeNpm",
        cc_traj_extra={
            "total_cache_read_input_tokens": 0,
            "total_cache_creation_input_tokens": 0,
        },
    )
    ok(
        AH.normalized_tokens(
            json.load(open(os.path.join(crashed_zero, "result.json"))), crashed_zero
        )
        is None,
        "🔴 token 键全缺 + cache 全 0 ⇒ None 而**不是全 0** —— 「没采到」不许伪装成「只用了 0 token」",
    )

    print("\n⑤ cache_hit_ratio —— 分母是总入,归一后两臂才可比")
    # ⚠️ 先取值再判,⛔ 不写 `abs(cache_hit_ratio(t) - ...)`:那样 t 为 None 时
    # 这条断言会**抛异常**而不是翻红 —— 变异自证里「红」与「崩」必须区分开,
    # 否则一条崩掉的断言会被当成「它承重了」。
    _hit = AH.cache_hit_ratio(t)
    ok(
        _hit is not None and abs(_hit - 102559 / 139541) < 1e-9,
        "cc 命中率 = read ÷ total_in",
    )
    ok(AH.cache_hit_ratio(None) is None, "拆不出 token ⇒ None")
    ok(AH.cache_hit_ratio({"total_in": 0, "cache_read": 0}) is None, "总入 0 ⇒ None(不除零)")


# ── 反向变异:把判据改坏,上面的断言必须红 ────────────────────────────────────

#: 每条变异 = (标签, 正则, 替换)。**必须真的改源码副本再跑**,
#: ⛔ 不许「相信它会红」—— 本仓两次踩到假绿断言都是因为没做这一步。
MUTATIONS = [
    (
        "M1 detect_arm 改成看目录名",
        r"cfg = os\.path\.join\(trial_dir, \"config\.json\"\)",
        'cfg = os.path.join(trial_dir, "__nonexistent__.json")',
    ),
    (
        # ⚠️ 必须跨 docstring 定位:`def cc_denials` 与函数体之间隔着一大段
        # 文档字符串,而 `.` 默认不匹配换行 —— 初版写 `def cc_denials.*?\n` 紧接
        # 函数体,正则**没匹配到**,于是这条变异静默失效(报「正则没匹配到」)。
        # ⇒ 变异自证脚本自己也会有 bug,所以它必须报告「没匹配到」而不是当成通过。
        "M2 cc_denials 把 None 当 0(「看着像 0 denials」)",
        r"(def cc_denials\(trial_dir: str\) -> int \| None:[\s\S]*?if ev is None:\n        )return None",
        r"\g<1>return 0",
    ),
    (
        "M3 normalized_tokens 把负 fresh clamp 成 0",
        r"if fresh < 0:\n(?:.*\n)*?            return None",
        "if fresh < 0:\n            fresh = 0",
    ),
    (
        "M4 self_reported_success_cc 用 falsy 判 reward",
        r"return isinstance\(reward, \(int, float\)\) and float\(reward\) == 0\.0",
        "return not reward",
    ),
    (
        "M5 cc_result_event 遇坏行就放弃整份",
        r"                except ValueError:\n                    continue",
        "                except ValueError:\n                    return None",
    ),
    (
        # 门禁逼出来的那条 `agent_ran` 断言必须自己也承重 ——
        # 否则它就是「为了过门禁摆一个 import」,而那正是本仓最不该有的形态。
        # 这条变异让 normalized_tokens 不再走共享三态判据(改回自己数一遍),
        # 于是 fixture 形态守卫里那条 agent_ran 断言应当翻红。
        "M6 normalized_tokens 绕开 agent_ran 自己判三态",
        r"    if agent_ran\(result\) is None:\n        return None",
        "    if False:\n        return None",
    ),
]


def self_check() -> int:
    """跑每条变异,要求测试**真的红**。绿了说明那条断言不承重。"""
    src = open(SRC, encoding="utf-8").read()
    bad = 0
    print("=== 反向变异自证(每条都必须让测试红)===\n")
    for label, pat, rep in MUTATIONS:
        mutated, n = re.subn(pat, rep, src, count=1)
        if n == 0:
            print(f"  ⛔ {label}:正则没匹配到 —— 变异本身失效了(源码改过?)")
            bad += 1
            continue
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(HERE, os.path.join(tmp, "h"), symlinks=True,
                            ignore=shutil.ignore_patterns("runs", "__pycache__",
                                                          ".venv", ".ruff_cache"))
            hdir = os.path.join(tmp, "h")
            with open(os.path.join(hdir, "arm_health.py"), "w", encoding="utf-8") as fh:
                fh.write(mutated)
            r = subprocess.run(
                [sys.executable, os.path.join(hdir, "test-arm-health.py")],
                capture_output=True,
                text=True,
                cwd=hdir,
            )
            fails = [
                x.strip() for x in r.stdout.splitlines() if x.strip().startswith("❌")
            ]
            if r.returncode == 0:
                print(f"  ❌ {label}:测试仍然**绿** ⇒ 这条断言不承重(假绿)")
                bad += 1
            elif not fails:
                # 🔴 「红」与「崩」必须区分。rc≠0 可能是 fixture 形态守卫抛了异常
                # (fail-fast 在 ① 组之前),此时**没有任何断言翻红** —— 那不叫
                # 「这条防线承重」,只叫「程序挂了」。M1 初版就是这个形态:
                # detect_arm 一坏,`_assert_fixture_shape` 直接 raise,
                # 于是 ① 组的五条断言压根没跑到,却被记成「✅ 红了」。
                print(f"  ❌ {label}:rc={r.returncode} 但**零条断言翻红** ⇒ 是崩(异常),不是红")
                tail = [x for x in (r.stderr or "").strip().splitlines() if x.strip()]
                if tail:
                    print(f"       └ {tail[-1][:120]}")
                bad += 1
            else:
                print(f"  ✅ {label}:红了({len(fails)} 条断言翻红)")
                for x in fails[:2]:
                    print(f"       └ {x}")
    print(f"\n{'=' * 60}\n  变异自证:{len(MUTATIONS) - bad} / {len(MUTATIONS)} 条真的能红")
    return 1 if bad else 0


def main() -> int:
    if "--self-check" in sys.argv:
        return self_check()
    print("=== arm_health.py 判据测试 ===")
    with tempfile.TemporaryDirectory() as root:
        run_tests(root)
    print(f"\n{'=' * 60}\n  通过 {_passed} / 失败 {_failed}")
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
