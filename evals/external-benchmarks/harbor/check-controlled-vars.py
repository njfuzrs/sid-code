#!/usr/bin/env python3
"""控制变量跨臂一致闸。

从各臂 `lock.json` 的 `trials[0]` 读 **全部五个** multiplier，先断言键存在、
再断言跨臂相等。资源项（cpu/memory enforcement）一并比。

## 为什么「先键存在」

A10-smoke 三臂都缺 `agent_setup_timeout_multiplier` 与
`environment_build_timeout_multiplier`。只比交集的话，一个把某键整个删掉的
改动会让闸继续绿（比较集为空 ⇒ 无差异可报）—— 即「门禁绿着失效」。

规则：

- 五键里 **所有臂都缺** 同一键 → 记「缺席相同」，不算红（A10 现状）
- **部分臂缺** → 红，且报「键缺失」，点名臂与字段
- 都有但取值不同 → 红，且报「取值不一致」，点名臂与字段

这是回归保护，⛔ 不是修现存错误。2026-09-16 真跑一遍三组跨臂已一致。

用法：

    python3 check-controlled-vars.py                         # 默认三组，runs/ 相对本目录
    python3 check-controlled-vars.py --runs-dir /path/runs
    python3 check-controlled-vars.py --group W3 --runs-dir /tmp/fake
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

MULTIPLIER_KEYS = (
    "timeout_multiplier",
    "agent_timeout_multiplier",
    "verifier_timeout_multiplier",
    "agent_setup_timeout_multiplier",
    "environment_build_timeout_multiplier",
)

RESOURCE_KEYS = (
    "cpu_enforcement_policy",
    "memory_enforcement_policy",
)

# 2026-09-20：W3 必须含 A3（w3-cc-sonnet-54），缺它 = 把 15 号最关心的那一臂留在扫描面外。
GROUPS: dict[str, tuple[str, ...]] = {
    "A10-smoke": ("a10-smoke-sid", "a10-smoke-cc", "a10-smoke-mswea"),
    "A11": ("a11-sid", "a11-mswea"),
    "W3": ("w3-sid-ds41-54", "w3-sid-sonnet-66", "w3-cc-sonnet-54"),
}


def load_trial0(lock_path: str) -> dict:
    with open(lock_path, encoding="utf-8") as fh:
        doc = json.load(fh)
    trials = doc.get("trials") or []
    if not trials or not isinstance(trials[0], dict):
        raise ValueError(f"{lock_path} 没有 trials[0]")
    return trials[0]


def intra_arm_drift(lock_path: str, key: str) -> str | None:
    """同一臂内部取值必须一致。漂了就不是「跨臂」问题，是这份 lock 自己烂了。"""
    with open(lock_path, encoding="utf-8") as fh:
        doc = json.load(fh)
    vals = []
    for t in doc.get("trials") or []:
        if isinstance(t, dict) and key in t:
            vals.append(t.get(key))
    if len(set(repr(v) for v in vals)) > 1:
        return f"臂内 {key} 不唯一: {sorted({repr(v) for v in vals})}"
    return None


def check_group(name: str, arms: tuple[str, ...], runs_dir: str) -> list[str]:
    """返回错误行（空 = 通过）。缺 lock 文件也是错：扫描面里的臂必须在。"""
    errors: list[str] = []
    loaded: dict[str, dict] = {}
    locks: dict[str, str] = {}
    for arm in arms:
        p = os.path.join(runs_dir, arm, "lock.json")
        if not os.path.isfile(p):
            errors.append(f"[{name}] 键缺失: 臂 {arm} 没有 lock.json（{p}）")
            continue
        try:
            loaded[arm] = load_trial0(p)
        except (OSError, ValueError, json.JSONDecodeError) as e:
            errors.append(f"[{name}] 臂 {arm} lock 读失败: {e}")
            continue
        locks[arm] = p
    if len(loaded) < 2:
        return errors or [f"[{name}] 有效臂不足 2，比不了"]

    def env_of(arm: str) -> dict:
        raw = loaded[arm].get("environment")
        return raw if isinstance(raw, dict) else {}

    def present(arm: str, key: str, *, resource: bool = False) -> bool:
        if resource:
            return key in env_of(arm)
        return key in loaded[arm]

    def value(arm: str, key: str, *, resource: bool = False):
        if resource:
            return env_of(arm).get(key)
        return loaded[arm].get(key)

    for key in MULTIPLIER_KEYS:
        have = [arm for arm in loaded if present(arm, key)]
        miss = [arm for arm in loaded if not present(arm, key)]
        if not have:
            continue  # 缺席相同
        if miss:
            errors.append(
                f"[{name}] 键缺失: 字段 {key} 在臂 {', '.join(miss)} 上不存在"
                f"（有该键的臂: {', '.join(have)}）"
            )
            continue
        for arm, lp in locks.items():
            drift = intra_arm_drift(lp, key)
            if drift:
                errors.append(f"[{name}] {arm}: {drift}")
        vals = {arm: value(arm, key) for arm in loaded}
        uniq = {repr(v) for v in vals.values()}
        if len(uniq) > 1:
            detail = ", ".join(f"{arm}={vals[arm]!r}" for arm in loaded)
            # 点名一个与众不同的臂，方便看变异自证的输出。
            errors.append(f"[{name}] 取值不一致: 字段 {key}（{detail}）")

    for key in RESOURCE_KEYS:
        have = [arm for arm in loaded if present(arm, key, resource=True)]
        miss = [arm for arm in loaded if not present(arm, key, resource=True)]
        if not have:
            continue
        if miss:
            errors.append(
                f"[{name}] 键缺失: 字段 environment.{key} 在臂 {', '.join(miss)} 上不存在"
            )
            continue
        vals = {arm: value(arm, key, resource=True) for arm in loaded}
        if len({repr(v) for v in vals.values()}) > 1:
            detail = ", ".join(f"{arm}={vals[arm]!r}" for arm in loaded)
            errors.append(f"[{name}] 取值不一致: 字段 environment.{key}（{detail}）")
    return errors


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs-dir", default=os.path.join(HERE, "runs"))
    ap.add_argument("--group", action="append", dest="groups",
                    help="只跑这一组（可重复）。默认 A10-smoke / A11 / W3")
    args = ap.parse_args(argv)
    names = args.groups or list(GROUPS)
    unknown = [g for g in names if g not in GROUPS]
    if unknown:
        print(f"⛔ 未知组 {unknown}，可选: {list(GROUPS)}", file=sys.stderr)
        return 2
    all_err: list[str] = []
    for g in names:
        errs = check_group(g, GROUPS[g], args.runs_dir)
        if errs:
            all_err.extend(errs)
        else:
            print(f"✅ {g}: 五键先存在再相等（缺席相同也算过）")
    if all_err:
        for line in all_err:
            print(f"⛔ {line}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
