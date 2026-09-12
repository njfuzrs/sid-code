#!/usr/bin/env python3
"""`w3-summary.py` 归档口径的变异自证。

⚠️ **为什么需要它**:这个脚本产出的 JSON 是**唯一入库的那一份**(`runs/` 整个
不在版本库里),简历与对照表上的每个数字都从它来。而它此前没有任何测试 ——
2026-09-12 当场踩到:给「撞满轮数」补一个可判分母时,`maxed` 是**二态布尔**
(不可判折叠成 False),于是 `sum(... if r["maxed"] is not None)` 恒等于全部题数,
**分母披露静默失效**、输出「其余 0 题不可判」而真值是 13 题。
形态是本仓那条「一个字段混了两个相反语义」的同型,而它不报错、不翻红。

⇒ 本文件的每条断言都配一条能让它红的变异(`--self-check`),⛔ 不许「相信它会红」。

⚠️ 全部在 tmpdir 里造假 trial,**不碰 runs/**(那是既有结论的取数源)。

跑法:
    python3 test-w3-summary.py                # 正向断言
    python3 test-w3-summary.py --self-check   # 反向变异(每条必须红)
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "w3-summary.py")

sys.path.insert(0, HERE)
# 🔴 与 test-w3-classify.py 同一条纪律:必须 import 真判据,⛔ 不在造假数据时
# 另存一份「这些字段意味着什么」的理解 —— 两份理解迟早分叉。
# 门禁 `harbor-agent-contract.test.ts` 拦的正是这个。
from arm_health import SID_HOME_DIRNAME  # noqa: E402
from verifier_health import agent_ran, verifier_ran  # noqa: E402

_passed = _failed = 0


def ok(cond: bool, label: str) -> None:
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  ✅ {label}")
    else:
        _failed += 1
        print(f"  ❌ {label}")


def _trial(
    job: str,
    task: str,
    *,
    reward: float = 0.0,
    turns: int | None = None,
    cost_source: str = "stream-json-result",
    subtype: str | None = "success",
    provider: str = "openai",
    model_id: str = "fixture-model",
    n_in: int = 100_000,
    n_cache: int = 90_000,
    n_out: int = 5_000,
    cost: float = 0.01,
    sid_commit: str | None = "30586ff003c968e111537d5379e79a14a2646855",
    sid_binary_sha256: str | None = "4e51bda52f9c" + "0" * 52,
) -> str:
    """造一个 sid 臂 trial。字段位置逐字对齐真实数据(见 arm_health 的 fixture 注释)。

    ⚠️ `cost_source="session-traj-fallback"` 对应真实的「result 事件丢了、
    turns 取自 traj 的 total_steps(步骤数,不是轮数)」态 —— 那是「撞满轮数」
    **判不出来**的那一态,本文件的核心断言就压在它上面。
    """
    td = os.path.join(job, f"{task}__fixture")
    os.makedirs(os.path.join(td, "agent"), exist_ok=True)
    with open(os.path.join(td, "config.json"), "w", encoding="utf-8") as fh:
        json.dump({"agent": {"name": "sid_code_agent:SidCodeAgent"}}, fh)

    md: dict = {
        "sid_cost_source": cost_source,
        "sid_permission_denials": 0,
        "sid_permission_allows": 12,
        "cache_write_tokens": 0,
    }
    if turns is not None:
        md["sid_num_turns"] = turns
    # 🔴 真跑二进制的身份(必控变量)。⚠️ 与归档顶层的 `sid_code_commit` 是两件事:
    # 那个是「跑汇总时本仓 HEAD」,只因重跑一次汇总就会变(实测踩到)。
    if sid_commit is not None:
        md["sid_commit"] = sid_commit
    if sid_binary_sha256 is not None:
        md["sid_binary_sha256"] = sid_binary_sha256
    if subtype is not None:
        md["sid_subtype"] = subtype
    res = {
        "agent_result": {
            "n_input_tokens": n_in,
            "n_cache_tokens": n_cache,
            "n_output_tokens": n_out,
            "cost_usd": cost,
            "metadata": md,
        },
        "verifier_result": {"rewards": {"reward": reward}},
    }
    with open(os.path.join(td, "result.json"), "w", encoding="utf-8") as fh:
        json.dump(res, fh)

    sh = os.path.join(td, "agent", SID_HOME_DIRNAME)
    os.makedirs(sh, exist_ok=True)
    with open(os.path.join(sh, "settings.json"), "w", encoding="utf-8") as fh:
        json.dump({"availableModels": [{"modelId": model_id, "provider": provider}]}, fh)

    # 🔴 `verifier_ran()` 判的**不是** result.json 里有没有 reward,而是
    # `verifier/*stdout*` 里有没有一条 pytest 结论行(`\d+ (passed|failed)`)。
    # ⚠️ 初版漏了这份落盘 ⇒ 5 题全被判「verifier未判分」而进了 excluded,
    # scored=0 —— 断言当场红,这正是 fixture 形态自洽守卫要抓的东西
    # (造的假数据不对时,测的就是别的东西)。
    vd = os.path.join(td, "verifier")
    os.makedirs(vd, exist_ok=True)
    with open(os.path.join(vd, "stdout.txt"), "w", encoding="utf-8") as fh:
        fh.write("1 passed in 0.42s\n" if reward else "1 failed in 0.42s\n")
    return td


def _job(root: str, name: str) -> str:
    """造一个 job 目录 + harbor 的 job metadata(finished_at 非 None = 已跑完)。

    🔴 `finished_at` 不能省:`w3-summary` 有一道「未跑完闸」,缺它会在输出里
    插一条「这一轮还没跑完」的 caveat 并拒绝给终值 —— 那会让本文件的断言
    全部落到那条分支上(即测了个别的东西)。
    """
    job = os.path.join(root, name)
    os.makedirs(job, exist_ok=True)
    with open(os.path.join(job, "metadata.json"), "w", encoding="utf-8") as fh:
        json.dump({"finished_at": "2026-09-12T00:00:00", "n_trials": None}, fh)
    return job


def _run(job: str, out: str, src: str = SRC) -> dict:
    """跑汇总并读回归档 JSON 的那一臂。"""
    r = subprocess.run(
        [sys.executable, src, job, "-o", out],
        capture_output=True, text=True, cwd=HERE,
    )
    if r.returncode != 0:
        raise RuntimeError(f"w3-summary 退出码 {r.returncode}\n{r.stdout}\n{r.stderr}")
    path = os.path.join(out, f"{os.path.basename(job)}.json")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)["arms"][0]


def run_tests(root: str, src: str = SRC) -> None:
    out = os.path.join(root, "out")
    os.makedirs(out, exist_ok=True)

    # ── fixture 形态自洽:用真判据回读,防「造的假数据本身不对」──────────────
    print("① fixture 形态自洽(用真判据回读)")
    probe = _job(root, "probe")
    ptd = _trial(probe, "t", turns=10)
    with open(os.path.join(ptd, "result.json"), encoding="utf-8") as fh:
        ok(agent_ran(json.load(fh)) is True, "造出来的 trial 被 agent_ran 判为「真跑过」")
    ok(verifier_ran(ptd) is True, "🔴 且被 verifier_ran 判为「判分了」(否则会整批进 excluded)")

    # ── ② 撞满轮数的**可判分母** ──────────────────────────────────────────
    print("\n② 撞满轮数:分母是**可判的题**,⛔ 不是 scored")
    job = _job(root, "mixed")
    # 3 题权威源:1 题撞满(41≥40)、2 题没撞满
    _trial(job, "maxed-a", turns=41, subtype="error_max_turns")
    _trial(job, "normal-a", turns=10)
    _trial(job, "normal-b", turns=12)
    # 2 题 traj 兜底 ⇒ turns 是 total_steps(步骤数)⇒ **判不出来**。
    # 🔴 其中一题 steps=88 远超 40:二态实现会把它算成「撞满」(虚报),
    #    而正确行为是**不判**。
    _trial(job, "fallback-big", turns=88, cost_source="session-traj-fallback", subtype=None)
    _trial(job, "fallback-small", turns=5, cost_source="session-traj-fallback", subtype=None)
    a = _run(job, out, src)
    fm = a["failure_mix"]
    ok(fm["maxed_turns"] == 1, f"撞满题数 = 1(⛔ 不是 2 —— steps=88 那题不许算)得 {fm['maxed_turns']}")
    ok(
        fm.get("maxed_turns_judgeable_denominator") == 3,
        f"🔴 可判分母 = 3(⛔ 不是 5)得 {fm.get('maxed_turns_judgeable_denominator')}",
    )
    ok(
        fm.get("maxed_turns_unjudgeable") == 2,
        f"🔴 不可判 = 2(这一格是 2026-09-12 静默失效过的那个)得 {fm.get('maxed_turns_unjudgeable')}",
    )
    ok(
        a["denominators"]["scored"] == 5,
        "⚠️ scored 仍是 5 —— 可判分母**小于** scored,两者不是一个量",
    )
    cav = " ".join(a["caveats"])
    ok("可判的 3 题" in cav, "caveat 里写出了可判分母(引用者看得到)")

    # ── ③ token 按族归一 ─────────────────────────────────────────────────
    print("\n③ token 归一:sid 臂**内部再分族**(openai 的 prompt_tokens 含命中)")
    joa = _job(root, "oa")
    _trial(joa, "t1", turns=10, provider="openai", n_in=298_906, n_cache=286_080, n_out=50_154)
    aoa = _run(joa, out, src)
    tn = aoa["tokens_normalized"]
    ok(tn["fresh"] == 298_906 - 286_080, f"openai: fresh = prompt−cache = 12826,得 {tn['fresh']}")
    ok(tn["total_in"] == 298_906, "openai: total_in 就是 prompt_tokens")
    ok(
        any("openai" in s for s in tn["source"]),
        f"source 带族标签(可追溯用了哪条口径),得 {tn['source']}",
    )

    jan = _job(root, "an")
    _trial(jan, "t1", turns=10, provider="anthropic", n_in=4_697, n_cache=187_957, n_out=1_462)
    aan = _run(jan, out, src)
    tna = aan["tokens_normalized"]
    ok(tna["fresh"] == 4_697, f"anthropic: fresh 就是 n_input(未命中余量),得 {tna['fresh']}")
    ok(tna["total_in"] == 4_697 + 187_957, "anthropic: total_in 归一成 fresh+read+write")

    # ── ⑤ 真跑二进制身份:必控变量,且⛔ 不能被顶层 sid_code_commit 顶替 ──────
    print("\n⑤ 真跑二进制:harness 版本是「换模型对照」的必控变量")
    cv = a["controlled_variables"]
    ok(
        cv["sid_binary_commit_observed"] == ["30586ff003c968e111537d5379e79a14a2646855"],
        f"🔴 归档记下真跑二进制的 commit(⛔ 不是跑汇总时的仓库 HEAD),得 "
        f"{[c[:12] for c in cv['sid_binary_commit_observed']]}",
    )
    ok(cv["n_sid_binary_missing"] == 0, "5 题全采到 ⇒ 缺失 0")

    # 顶层那一格答的是**另一个问题**(谁做的取数)⇒ 两者必须不同源。
    with open(os.path.join(out, f"{os.path.basename(job)}.json"), encoding="utf-8") as fh:
        top = json.load(fh)
    ok(
        top["sid_code_commit_of_analysis"] != cv["sid_binary_commit_observed"][0],
        "🔴 顶层 commit(取数时 HEAD)与真跑二进制 commit **不是同一个值** —— "
        "两者都叫 commit、都是合法 sha,看数值分辨不出来,所以必须分成两格",
    )

    # 🔴 多个 commit ⇒ 整臂不可比,必须显式报出来(⛔ 不许取第一个当代表)。
    jmix = _job(root, "binmix")
    _trial(jmix, "t1", turns=10)
    _trial(jmix, "t2", turns=10, sid_commit="d1f3071817fe960b30de00707b661a41ce64e4ba")
    amix = _run(jmix, out, src)
    ok(
        len(amix["controlled_variables"]["sid_binary_commit_observed"]) == 2,
        "两个 commit 都留在归档里(⛔ 不取第一个)",
    )
    ok(
        any("不是同一个二进制跑的" in c for c in amix["caveats"]),
        "🔴 混了两个二进制 ⇒ caveat 明说「整臂不可比」",
    )

    jmiss = _job(root, "binmiss")
    _trial(jmiss, "t1", turns=10, sid_commit=None, sid_binary_sha256=None)
    amiss = _run(jmiss, out, src)
    ok(
        amiss["controlled_variables"]["n_sid_binary_missing"] == 1,
        "没采到时如实计入缺失(⛔ 不静默当成「同一个」)",
    )
    ok(
        any("只有命令行作证" in c for c in amiss["caveats"]),
        "⚠️ 缺失时 caveat 说清「同 harness」失去了证据",
    )

    # ── ④ undercount 判据必须按族门控 ────────────────────────────────────
    print("\n④ token_undercount:分母是写死的 sonnet 价 ⇒ 换模型臂上必须不判")
    ok(
        aoa.get("token_undercount_tasks") == [],
        f"🔴 openai 族 ⇒ 一题都不标(A1 首版归档曾 54/54 全标),得 {aoa.get('token_undercount_tasks')}",
    )


# ── 反向变异:把判据改坏,上面的断言必须红 ────────────────────────────────
MUTATIONS = [
    (
        # 🔴 这条正是 2026-09-12 当场踩到的形态:maxed 折叠成二态。
        "V1 maxed 退回二态(不可判折叠成 False)⇒ 分母披露静默失效",
        r'            "maxed": \(\n                None\n(?:.*\n)*?            \),',
        '            "maxed": (\n'
        "                turns is not None and turns >= MAX_TURNS\n"
        '                and (turns_is_api_calls if this_arm != "cc" else True)\n'
        "            ),",
    ),
    (
        "V2 撞满轮数不做 fail-closed(拿 total_steps 当轮数)⇒ 虚报撞满",
        r"if turns is None or not \(turns_is_api_calls if this_arm != \"cc\" else True\)",
        "if turns is None",
    ),
    (
        "V3 可判分母改成全部题数(caveat 说「其余 0 题」)",
        r'n_judgeable_maxed = sum\(1 for r in rows if r\["maxed"\] is not None\)',
        "n_judgeable_maxed = len(rows)",
    ),
    (
        # 🔴 正是 2026-09-12 踩到的形态:拿「跑汇总时的仓库 HEAD」冒充
        # 「产出这批数据的二进制」。两者都叫 commit、都是合法 sha ⇒ 看数值分辨不出来。
        "V4 用顶层取数 commit 冒充真跑二进制 commit",
        r'        "sid_binary_commit": sid_binary_identity\(d\)\[0\],',
        '        "sid_binary_commit": _git_commit(),',
    ),
    (
        # 多个二进制混在一臂里时取第一个当代表 ⇒ 一次 harness 换版被伪装成
        # 一次干净的单版本运行,而「换模型对照」的必控变量已经动了。
        "V5 多二进制时只留第一个(把换版伪装成干净运行)",
        r'    bin_commits = sorted\(\{r\["sid_binary_commit"\] for r in rows if r\["sid_binary_commit"\]\}\)',
        '    bin_commits = sorted({r["sid_binary_commit"] for r in rows if r["sid_binary_commit"]})[:1]',
    ),
    (
        "V6 没采到二进制身份时静默当成「同一个」(缺失计数归零)",
        r'    n_bin_missing = sum\(1 for r in rows if not r\["sid_binary_commit"\]\)',
        "    n_bin_missing = 0",
    ),
]


def self_check() -> int:
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
            msrc = os.path.join(tmp, "w3-summary-mutated.py")
            with open(msrc, "w", encoding="utf-8") as fh:
                fh.write(mutated)
            # 变异副本要能 import 同目录的判据模块 ⇒ 放在 HERE 下跑
            live = os.path.join(HERE, ".mutated-w3-summary.py")
            shutil.copyfile(msrc, live)
            try:
                r = subprocess.run(
                    [sys.executable, __file__, "--mutated", live],
                    capture_output=True, text=True, cwd=HERE,
                )
            finally:
                os.path.exists(live) and os.remove(live)
        reds = [ln.strip() for ln in r.stdout.splitlines() if ln.strip().startswith("❌")]
        if r.returncode != 0 and reds:
            print(f"  ✅ {label}:红了({len(reds)} 条断言翻红)")
            for ln in reds:
                print(f"       └ {ln}")
        elif r.returncode != 0:
            # 崩了 ≠ 红了 —— 必须区分,否则一条崩掉的断言会被当成「它承重了」。
            print(f"  ⛔ {label}:**崩了而不是红了**(断言没跑到)")
            print("       " + (r.stdout + r.stderr).strip().splitlines()[-1][:160])
            bad += 1
        else:
            print(f"  ⛔ {label}:**没红** —— 那条断言不承重")
            bad += 1
    print(f"\n{'=' * 60}\n  变异自证:{len(MUTATIONS) - bad} / {len(MUTATIONS)} 条真的能红")
    return 1 if bad else 0


def main() -> int:
    if "--self-check" in sys.argv:
        return self_check()
    src = SRC
    if "--mutated" in sys.argv:
        src = sys.argv[sys.argv.index("--mutated") + 1]
    tmp = tempfile.mkdtemp(prefix="w3sum-test-")
    try:
        run_tests(tmp, src)
        print(f"\n{'=' * 60}\n  通过 {_passed} / 失败 {_failed}")
        return 1 if _failed else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
