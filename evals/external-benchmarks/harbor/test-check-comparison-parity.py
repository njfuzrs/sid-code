#!/usr/bin/env python3
"""check-comparison-parity.py 的变异自证。

A3 收尾实测踩到两处假结论,都是「脚本打印 ⛔ / ✅ 但 rc 恒 0」或
「把超时未落盘 result 事件算成权限档不同源」:

  1. feal-linear-cryptanalysis:cc 跑了 2h 被 AgentTimeoutError 杀掉,
     claude-code.txt 有 assistant 消息、token 非 0,**没有 type=result**,
     cc_denials=None。旧版把它推进 bad ⇒ 「1/54 题权限档不同源,分数不可互比」。
     那是归因错误:问题是超时,不是权限档。
  2. 结论行写「分数不可互比」时 exit 0。CI / 串联脚本会当成功。

全部在 tmpdir 造假 trial,不碰 runs/。

跑法: python3 test-check-comparison-parity.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "check-comparison-parity.py")

sys.path.insert(0, HERE)
from verifier_health import agent_ran  # noqa: E402
from arm_health import cc_denials, detect_arm  # noqa: E402

PASS = FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name}  {detail}")


def _sid_trial(job: str, task: str, *, deny: int, allow: int, tokens=(10, 10)) -> str:
    td = os.path.join(job, f"{task}__sid")
    os.makedirs(os.path.join(td, "agent", "sid-home", "logs"), exist_ok=True)
    with open(os.path.join(td, "config.json"), "w", encoding="utf-8") as fh:
        json.dump({"agent": {"name": "sid_code_agent:SidCodeAgent"}}, fh)
    res = {
        "task_name": task,
        "agent_result": {
            "n_input_tokens": tokens[0],
            "n_output_tokens": tokens[1],
            "metadata": {"sid_permission_mode_requested": "dangerously-skip-permissions"},
        },
        "verifier_result": {"rewards": {"reward": 0.0}},
    }
    with open(os.path.join(td, "result.json"), "w", encoding="utf-8") as fh:
        json.dump(res, fh)
    audit = os.path.join(td, "agent", "sid-home", "logs", "permissions-audit.log")
    with open(audit, "w", encoding="utf-8") as fh:
        for _ in range(deny):
            fh.write(json.dumps({"decision": "deny"}) + "\n")
        for _ in range(allow):
            fh.write(json.dumps({"decision": "allow"}) + "\n")
    assert agent_ran(res) is True
    return td


def _cc_trial(job: str, task: str, *, events: list[dict] | None, tokens=(10, 10)) -> str:
    td = os.path.join(job, f"{task}__cc")
    os.makedirs(os.path.join(td, "agent"), exist_ok=True)
    with open(os.path.join(td, "config.json"), "w", encoding="utf-8") as fh:
        json.dump({"agent": {"name": "claude_code_agent:ClaudeCodeNpm"}}, fh)
    res = {
        "task_name": task,
        "agent_result": {
            "n_input_tokens": tokens[0],
            "n_output_tokens": tokens[1],
        },
        "verifier_result": {"rewards": {"reward": 0.0}},
    }
    with open(os.path.join(td, "result.json"), "w", encoding="utf-8") as fh:
        json.dump(res, fh)
    if events is not None:
        with open(os.path.join(td, "agent", "claude-code.txt"), "w", encoding="utf-8") as fh:
            for ev in events:
                fh.write(json.dumps(ev) + "\n")
    assert detect_arm(td) == "cc"
    return td


def run_parity(sid_job: str, cc_job: str) -> tuple[int, str]:
    p = subprocess.run(
        [sys.executable, SCRIPT, sid_job, cc_job],
        capture_output=True, text=True, check=False,
    )
    return p.returncode, p.stdout + p.stderr


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="parity-")
    try:
        print("\n=== ① 两侧都有 denials=0 + sid allow>0 ⇒ rc=0,结论无反证 ===")
        sid = os.path.join(tmp, "sid1"); os.makedirs(sid)
        cc = os.path.join(tmp, "cc1"); os.makedirs(cc)
        _sid_trial(sid, "ok-task", deny=0, allow=5)
        _cc_trial(cc, "ok-task", events=[{"type": "result", "permission_denials": []}])
        rc, out = run_parity(sid, cc)
        check("rc=0", rc == 0, f"rc={rc}\n{out[-400:]}")
        check("结论含无反证", "无反证" in out, out[-400:])
        check("⛔ 不含「不可互比」", "不可互比" not in out, out[-400:])

        print("\n=== ② 🔴 cc 超时无 result 事件(denials=None,token 非 0) ⇒ 不参与对照,其余题仍可比 ===")
        # 这就是 feal-linear-cryptanalysis 的形态。旧版把它推进 bad 且 rc=0,
        # 结论写成「分数不可互比」—— 归因错,门禁还假绿。
        # 单独一题被 skip 时 judged=0 会走 rc=2(零样本对照,那是另一条防线);
        # 这里再放一题正常对照,专门锁「超时题不污染其余 53 题的可比性」。
        sid = os.path.join(tmp, "sid2"); os.makedirs(sid)
        cc = os.path.join(tmp, "cc2"); os.makedirs(cc)
        _sid_trial(sid, "feal-linear-cryptanalysis", deny=0, allow=2)
        _sid_trial(sid, "ok-task", deny=0, allow=5)
        td = _cc_trial(
            cc, "feal-linear-cryptanalysis",
            events=[{"type": "assistant", "message": {"content": [{"type": "text", "text": "x"}]}}],
            tokens=(7798844, 63529),
        )
        _cc_trial(cc, "ok-task", events=[{"type": "result", "permission_denials": []}])
        check("fixture:cc_denials 是 None(不是 0)", cc_denials(td) is None, f"{cc_denials(td)!r}")
        rc, out = run_parity(sid, cc)
        check("rc=0(超时不是档位问题,其余题无反证)", rc == 0, f"rc={rc}\n{out[-500:]}")
        check("判为不参与对照", "不参与" in out and "result 事件" in out, out[-500:])
        check("⛔ 不写「权限档不同源」", "权限档不同源" not in out, out[-500:])
        check("其余题仍报无反证", "无反证" in out, out[-500:])

        print("\n=== ④ 全部题都被 skip ⇒ rc=2(零样本对照,不是全绿) ===")
        sid = os.path.join(tmp, "sid4"); os.makedirs(sid)
        cc = os.path.join(tmp, "cc4"); os.makedirs(cc)
        _sid_trial(sid, "only-timeout", deny=0, allow=2)
        _cc_trial(
            cc, "only-timeout",
            events=[{"type": "assistant"}],
            tokens=(100, 10),
        )
        rc, out = run_parity(sid, cc)
        check("rc=2", rc == 2, f"rc={rc}\n{out[-400:]}")
        check("结论含参与对照的题数为 0", "题数为 0" in out, out[-400:])

        print("\n=== ③ cc 真有拒绝 ⇒ rc=1,结论不可互比 ===")
        sid = os.path.join(tmp, "sid3"); os.makedirs(sid)
        cc = os.path.join(tmp, "cc3"); os.makedirs(cc)
        _sid_trial(sid, "denied", deny=0, allow=3)
        _cc_trial(cc, "denied", events=[{"type": "result", "permission_denials": [{"x": 1}]}])
        rc, out = run_parity(sid, cc)
        check("rc=1", rc == 1, f"rc={rc}\n{out[-400:]}")
        check("结论含不可互比", "不可互比" in out, out[-400:])

        print(f"\n{'='*56}\n  通过 {PASS} / 失败 {FAIL}")
        return 1 if FAIL else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
