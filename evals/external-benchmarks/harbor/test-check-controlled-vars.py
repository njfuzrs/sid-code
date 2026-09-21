#!/usr/bin/env python3
"""check-controlled-vars.py 的正向断言 + 两条变异自证。

变异在 tmpdir 上改 lock 副本，不动真实 runs/。

  a) 改一臂的 agent_timeout_multiplier → 红，且点名臂与字段
  b) 删一臂的某个 multiplier 键 → 红，且报「键缺失」

跑法: python3 test-check-controlled-vars.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
# 文件名带连字符，不能 `import check-controlled-vars`
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "check_controlled_vars", os.path.join(HERE, "check-controlled-vars.py")
)
assert _spec and _spec.loader
C = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(C)

PASS = FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name}  {detail}")


FIVE = {
    "timeout_multiplier": 1.0,
    "agent_timeout_multiplier": 4.0,
    "verifier_timeout_multiplier": 6.0,
    "agent_setup_timeout_multiplier": 8.0,
    "environment_build_timeout_multiplier": 3.0,
}


def _lock(job: str, multipliers: dict, *, drop: str | None = None) -> None:
    os.makedirs(job, exist_ok=True)
    t0 = dict(multipliers)
    if drop:
        t0.pop(drop, None)
    t0["environment"] = {
        "cpu_enforcement_policy": "auto",
        "memory_enforcement_policy": "auto",
    }
    with open(os.path.join(job, "lock.json"), "w", encoding="utf-8") as fh:
        json.dump({"trials": [t0, dict(t0)]}, fh)


def run() -> int:
    tmp = tempfile.mkdtemp(prefix="cvars-")
    try:
        print("① 三臂五键齐全且相等 → 过")
        for arm in C.GROUPS["W3"]:
            _lock(os.path.join(tmp, arm), FIVE)
        errs = C.check_group("W3", C.GROUPS["W3"], tmp)
        check("W3 绿", errs == [], str(errs))

        print("\n② 变异 a：改一臂的 agent_timeout_multiplier")
        changed = dict(FIVE)
        changed["agent_timeout_multiplier"] = 99.0
        _lock(os.path.join(tmp, "w3-cc-sonnet-54"), changed)
        errs = C.check_group("W3", C.GROUPS["W3"], tmp)
        blob = "\n".join(errs)
        check("改值必须红", bool(errs), blob)
        check("点名字段 agent_timeout_multiplier", "agent_timeout_multiplier" in blob, blob)
        check("点名臂 w3-cc-sonnet-54", "w3-cc-sonnet-54" in blob, blob)
        check("报的是取值不一致", "取值不一致" in blob, blob)

        print("\n③ 变异 b：删一臂的某个键（不是改值）")
        _lock(os.path.join(tmp, "w3-cc-sonnet-54"), FIVE, drop="agent_setup_timeout_multiplier")
        errs = C.check_group("W3", C.GROUPS["W3"], tmp)
        blob = "\n".join(errs)
        check("删键必须红", bool(errs), blob)
        check("报「键缺失」而不是取值不一致", "键缺失" in blob and "取值不一致" not in blob, blob)
        check("点名字段 agent_setup_timeout_multiplier", "agent_setup_timeout_multiplier" in blob, blob)
        check("点名臂 w3-cc-sonnet-54", "w3-cc-sonnet-54" in blob, blob)

        print("\n④ 缺席相同（A10 形态）不算红")
        a10 = dict(FIVE)
        a10.pop("agent_setup_timeout_multiplier")
        a10.pop("environment_build_timeout_multiplier")
        for arm in C.GROUPS["A10-smoke"]:
            _lock(os.path.join(tmp, arm), a10)
        errs = C.check_group("A10-smoke", C.GROUPS["A10-smoke"], tmp)
        check("三臂一起缺两键 → 绿", errs == [], str(errs))

        print("\n⑤ 缺 lock 必须红且点名臂")
        shutil.rmtree(os.path.join(tmp, "w3-cc-sonnet-54"))
        # 另两个臂恢复五键齐全
        for arm in ("w3-sid-ds41-54", "w3-sid-sonnet-66"):
            _lock(os.path.join(tmp, arm), FIVE)
        errs = C.check_group("W3", C.GROUPS["W3"], tmp)
        blob = "\n".join(errs)
        check("缺 lock 红", bool(errs), blob)
        check("点名缺失的臂", "w3-cc-sonnet-54" in blob and "键缺失" in blob, blob)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'=' * 60}\n  通过 {PASS} / 失败 {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(run())
