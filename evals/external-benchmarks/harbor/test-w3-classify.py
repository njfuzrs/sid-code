#!/usr/bin/env python3
"""w3-classify.py 的变异自证。

⚠️ **为什么不是"跑通了"**：一个脚本跑完没报错，证明不了它选对了要删的目录。
本仓的教训是「防线还在，但它当初要防的条件变了」——所以每条用例都构造一个
**具体形态**的 trial，断言它被判进正确的一边。

⚠️ 全部在 tmpdir 里造假 trial，**不碰 runs/**（那是既有结论的取数源）。

跑法：python3 test-w3-classify.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "w3-classify.py")

sys.path.insert(0, HERE)
# 🔴 **本文件必须 import 真判据，不许自己数 token。**
#
# 门禁 `harbor-agent-contract.test.ts`「agent 侧健康判据同样只有一处定义」拦的
# 就是这个 —— 而它**当场就拦住了本文件**（2026-09-07 实测），理由完全正确：
# 造假数据时写下 `n_input_tokens` 却不 import `agent_ran`，等于对「这些字段
# 意味着什么」另存了一份理解，而两份理解迟早分叉。
#
# ⚠️ 这不是"为了让门禁绿"而加的形式 import —— 它真的能防住我已经犯过的错：
# 初版 `mk_trial` 把 token 写进 `metadata.total_input_tokens`（agent 自述），
# 而 `agent_ran` 读的是 `result.agent_result.n_input_tokens`（Harbor 侧观测）
# ⇒ 健康 trial 被判「零调用」，两组测试假红。下面的 `_assert_fixture_shape()`
# 用真判据回读每一个造出来的 fixture，**那个错在今天会当场红**。
from verifier_health import agent_ran, agent_started, verifier_ran

PASS = FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name}  {detail}")


def mk_trial(job: str, task: str, *, reward, tokens=None, metadata=None,
             debug_log: str | None = None, verifier_ok: bool = True,
             exception=None) -> str:
    r"""造一个假 trial 目录。**形态必须照 verifier_health 真正读的那些字段**。

    ⚠️ 这个函数我第一版写错了两处，导致 ① ⑤ 两组变红 —— 而**红的是脚手架，
    不是被测脚本**（07 号 §8.3 记着同型：七条变异里三条的红是脚手架自己的错）。
    两处错法记在这里，因为它们都是"看着对"的：

      1. `verifier_ran` 读的是 **`verifier/*stdout*` 里的 pytest 结论行**
         （`\d+ (passed|failed)`），**不是** `ctrf.json`。我写了 ctrf.json ⇒
         健康 trial 被判「verifier未判分」。
      2. `agent_ran` 读的是 **`result["agent_result"]["n_input_tokens"]`**
         （Harbor 侧观测值），**不是** `metadata.total_input_tokens`（agent 自述）。
         verifier_health 的注释明确写了「取观测方，不取自述方」。

    ⇒ 教训：造假数据的字段名必须回源码核，不能照 metadata 里看到的键名猜。
    """
    td = os.path.join(job, f"{task}__FAKEabc")
    os.makedirs(os.path.join(td, "agent", "sid-home"), exist_ok=True)
    os.makedirs(os.path.join(td, "verifier"), exist_ok=True)
    res = {
        "task_name": task,
        "trial_name": f"{task}__FAKEabc",
        "exception_info": exception,
        "verifier_result": ({"rewards": {"reward": reward}} if reward is not None
                            else None),
        "metadata": metadata if metadata is not None else {},
    }
    if tokens is not None:
        res["agent_result"] = {"n_input_tokens": tokens[0],
                               "n_output_tokens": tokens[1]}
    with open(os.path.join(td, "result.json"), "w", encoding="utf-8") as fh:
        json.dump(res, fh)
    if verifier_ok:
        with open(os.path.join(td, "verifier", "verifier-stdout.txt"), "w",
                  encoding="utf-8") as fh:
            fh.write("collected 3 items\n\n3 passed in 0.61s\n")
    if debug_log is not None:
        with open(os.path.join(td, "agent", "sid-home", "debug.log"), "w",
                  encoding="utf-8") as fh:
            fh.write(debug_log)
    _assert_fixture_shape(td, res, tokens, debug_log, verifier_ok)
    return td


def _assert_fixture_shape(td, res, tokens, debug_log, verifier_ok):
    """用**真判据**回读刚造出来的 fixture，确认它的形态确实是我想要的。

    造假数据最容易犯的错是**字段名猜错**（写进一个判据根本不读的键），
    形态是「测试红了，但红的是脚手架」。这个函数把那类错从「调试半小时」
    变成「当场 AssertionError 并指出是哪个字段」。
    """
    got = verifier_ran(td)
    assert got is verifier_ok, (
        f"fixture 形态不符：期望 verifier_ran={verifier_ok}，实得 {got}。"
        f"⇒ 判据读的是 verifier/*stdout* 里的 pytest 结论行，不是 ctrf.json")
    # None（没传）与 (None, None)（传了但双 null）都对应 agent_ran 的
    # **不可判**三态 —— 判据的 `if tin is None and tout is None: return None`。
    if tokens is None or tokens == (None, None):
        want_ran = None
    else:
        want_ran = not (tokens[0] == 0 and tokens[1] == 0)
    got = agent_ran(res)
    assert got is want_ran, (
        f"fixture 形态不符：tokens={tokens} 期望 agent_ran={want_ran}，实得 {got}。"
        f"⇒ 判据读的是 result.agent_result.n_input_tokens（Harbor 侧观测），"
        f"不是 metadata.total_input_tokens（agent 自述）")
    want_started = None if debug_log is None else ("[PERF] startup" in debug_log)
    got = agent_started(td)
    assert got is want_started, (
        f"fixture 形态不符：期望 agent_started={want_started}，实得 {got}。"
        f"⇒ 无 debug.log ⇒ None（不可判），有但缺 [PERF] startup ⇒ False")


def run(job: str, *extra) -> tuple[int, dict]:
    # check=False 是刻意的：本测试要读 rc（rc=3 是 fail-closed 的判据），
    # 抛异常就读不到了。
    p = subprocess.run([sys.executable, SCRIPT, job, "--json", *extra],
                       capture_output=True, text=True, check=False)
    summary = {}
    for line in p.stdout.splitlines():
        if line.startswith("JSON:"):
            summary = json.loads(line[5:])
    return p.returncode, summary


HEALTHY_LOG = "x\n[PERF] startup done\n[APP] 开始初始化\n" + "line\n" * 600

#: 「卡死在启动里」的真实形态（照 `runs/modelswitch-base-rerun/fix-code-vulnerability`）：
#: debug.log **存在但只有 134 行且没有 `[PERF] startup`**，进程一秒没往前走。
#: ⚠️ 不能用「没有 debug.log」来造它 —— 那时 `agent_started` 返回 **None（不可判）**
#: 而不是 False，形态与 cc 侧（本来就没有 debug.log）撞车。
STUCK_LOG = "boot\n" * 134


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="w3cls-")
    try:
        # ── ① 真实 0 分：reward=0.0 但四条判据全过 ⇒ ⛔ 绝不删 ──────────────
        print("\n=== ① reward=0.0 且判据全过 ⇒ ⛔ 不许删（删了就是伪造成绩）===")
        job = os.path.join(tmp, "j1"); os.makedirs(job)
        mk_trial(job, "real-zero", reward=0.0, tokens=(5000, 900),
                 debug_log=HEALTHY_LOG)
        rc, s = run(job, "--apply")
        check("rc=0", rc == 0, f"rc={rc}")
        check("判为计分 keep=1", s.get("keep") == 1, f"{s}")
        check("⛔ 一个都没删", s.get("deleted") == 0, f"{s}")
        check("目录还在", os.path.isdir(os.path.join(job, "real-zero__FAKEabc")))

        # ── ①ʙ 🔴 cc 侧形态：没有 debug.log ⇒ agent_started=None ⇒ 必须保留 ──
        #
        # 这条用例是补出来的：变异 M1（把 `agent_started(td) is False` 写成
        # `not agent_started(td)`）**原本 21/21 全绿照过**，而它在真实数据上
        # 会把 `ccrun-n6` 判成 **10/10 全部非能力失败** —— 整条 cc 臂的数据被删。
        # ⇒ 「变异过不了测试」才是判据，绿灯本身什么都不证明。
        print("\n=== ①ʙ cc 侧无 debug.log（agent_started=None）⇒ ⛔ 不许删 ===")
        job = os.path.join(tmp, "j1b"); os.makedirs(job)
        mk_trial(job, "cc-style", reward=1.0, tokens=(860941, 2952),
                 debug_log=None)   # cc 不写 sid 的 debug.log
        rc, s = run(job, "--apply")
        check("判为计分（None ≠ False）", s.get("keep") == 1, f"{s}")
        check("⛔ 没删", s.get("deleted") == 0, f"{s}")
        check("目录还在", os.path.isdir(os.path.join(job, "cc-style__FAKEabc")))

        # ── ② 假 0：metadata 整份缺失 + exception_info=None ⇒ 必须删 ───────
        print("\n=== ② metadata={} + exception_info=None（§2.2 那种假 0）⇒ 必须删 ===")
        job = os.path.join(tmp, "j2"); os.makedirs(job)
        # 真实形态：`agent_result` 在、但 token 双 null（metadata 采集缺失）
        # ⇒ `agent_ran` 返回 None（不是 False）⇒ 「零调用」这条判不出来；
        # 只有 `agent_started` 读 debug.log 才能抓到它。这正是 05 号 §00
        # 那道题绕过两条判据的原因。
        mk_trial(job, "ghost-zero", reward=0.0, tokens=(None, None),
                 debug_log=STUCK_LOG)
        rc, s = run(job, "--apply")
        check("判为非能力失败 drop=1", s.get("drop") == 1, f"{s}")
        check("真的删了", s.get("deleted") == 1, f"{s}")
        check("目录已消失", not os.path.isdir(os.path.join(job, "ghost-zero__FAKEabc")))

        # ── ③ 判据抛异常 ⇒ fail-closed，一个都不删 ────────────────────────
        print("\n=== ③ 判据抛异常 ⇒ 🔴 fail-closed 停手（⛔ 不许「判不出来就删」）===")
        job = os.path.join(tmp, "j3"); os.makedirs(job)
        mk_trial(job, "ok-one", reward=0.0, tokens=(10, 10),
                 debug_log=HEALTHY_LOG)
        bad = os.path.join(job, "broken__FAKEabc")
        os.makedirs(bad)
        with open(os.path.join(bad, "result.json"), "w") as fh:
            fh.write("{ this is not json")
        rc, s = run(job, "--apply")
        check("rc=3（停手）", rc == 3, f"rc={rc}")
        check("⛔ 一个都没删", not s or s.get("deleted", 0) == 0, f"{s}")
        check("健康的那个还在", os.path.isdir(os.path.join(job, "ok-one__FAKEabc")))

        # ── ④ dry-run 默认不删 ────────────────────────────────────────────
        print("\n=== ④ 不加 --apply ⇒ 只打印，绝不删 ===")
        job = os.path.join(tmp, "j4"); os.makedirs(job)
        mk_trial(job, "ghost", reward=0.0, tokens=(None, None),
                 debug_log=STUCK_LOG)
        rc, s = run(job)
        check("drop=1 但 deleted=0", s.get("drop") == 1 and s.get("deleted") == 0, f"{s}")
        check("目录还在", os.path.isdir(os.path.join(job, "ghost__FAKEabc")))

        # ── ⑤ 未跑完 ≠ 被排除 ─────────────────────────────────────────────
        print("\n=== ⑤ 没有 result.json ⇒ 记「尚未跑完」，⛔ 不当成被排除 ===")
        job = os.path.join(tmp, "j5"); os.makedirs(job)
        os.makedirs(os.path.join(job, "not-yet__FAKEabc"))
        mk_trial(job, "done", reward=1.0, tokens=(10, 10),
                 debug_log=HEALTHY_LOG)
        rc, s = run(job, "--apply")
        check("pending=1", s.get("pending") == 1, f"{s}")
        check("drop=0（不混为一谈）", s.get("drop") == 0, f"{s}")
        check("⛔ 未删未跑完的目录", os.path.isdir(os.path.join(job, "not-yet__FAKEabc")))

        # ── ⑥ verifier 没判分 ⇒ 删 ────────────────────────────────────────
        print("\n=== ⑥ verifier 未判分（假 0 形态之一）⇒ 必须删 ===")
        job = os.path.join(tmp, "j6"); os.makedirs(job)
        mk_trial(job, "no-verify", reward=0.0, verifier_ok=False,
                 tokens=(9, 9), debug_log=HEALTHY_LOG)
        rc, s = run(job, "--apply")
        check("判为 verifier未判分", "no-verify" in (s.get("drop_tasks") or []), f"{s}")
        check("已删", s.get("deleted") == 1, f"{s}")

        # ── ⑦ 零调用（token 双 0）⇒ 删 ────────────────────────────────────
        print("\n=== ⑦ token 双 0（零调用）⇒ 必须删 ===")
        job = os.path.join(tmp, "j7"); os.makedirs(job)
        mk_trial(job, "zero-call", reward=0.0, tokens=(0, 0),
                 debug_log=HEALTHY_LOG)
        rc, s = run(job, "--apply")
        check("判为零调用并删除", s.get("deleted") == 1, f"{s}")

        # ── ⑧ 只删本 job 目录下的东西 ─────────────────────────────────────
        print("\n=== ⑧ 兄弟目录不受影响（形态校验）===")
        parent = os.path.join(tmp, "p8"); os.makedirs(parent)
        job = os.path.join(parent, "myjob"); os.makedirs(job)
        sibling = os.path.join(parent, "OTHER-JOB__keepme"); os.makedirs(sibling)
        with open(os.path.join(sibling, "result.json"), "w") as fh:
            fh.write("{}")
        mk_trial(job, "ghost", reward=0.0, tokens=(None, None),
                 debug_log=STUCK_LOG)
        rc, s = run(job, "--apply")
        check("本 job 的删了", s.get("deleted") == 1, f"{s}")
        check("⛔ 兄弟 job 目录没被碰", os.path.isdir(sibling))
        check("⛔ 兄弟的 result.json 还在",
              os.path.exists(os.path.join(sibling, "result.json")))

        print(f"\n{'='*56}\n  通过 {PASS} / 失败 {FAIL}")
        return 1 if FAIL else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
