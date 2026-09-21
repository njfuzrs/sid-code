#!/usr/bin/env python3
"""题集指纹：题名 + task.digest，给四条跑法脚本共用。

## 为什么必须有这个模块

`w3-run.sh` 里那道指纹闸只哈希 **sorted(task names) → sha256:16**。
题内容变了（同一题名、digest 变）它看不见。覆盖面也只有 1/4
（`run-claude-code-contrast.sh` / `run-model-switch.sh` / `run-permission-switch.sh` 没接）。

本文件是那道闸的共享实现。格式：

    {n}:{name_sha16}:{digest_sha16|nolock}

- `n` / `name_sha16`：来自 `registry.local.json` 该 dataset 的题名
- `digest_sha16`：来自 job 的 `lock.json` `trials[].task.digest`（有 lock 才有）
- 没有 lock（首跑之前）第三段写 `nolock`，**不假装题内容已钉死**

旧文件只有两段 `{n}:{name_sha16}`（本 PR 之前 w3 写下的）。
比对时两段文件只核前两段 —— 否则所有在途 job 的 resume 会被新格式误杀。
新写入一律三段。

W3-54 的期望值钉在 `CANONICAL`：有 lock 时第三段必须对上。
那 54 个 digest 是 A1/A3 的公共题集（2026-09-21 从 lock 复算）。
⛔ 没跑过 lock 就别说「题集版本已钉死」。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FP_NAMES = (".taskset-fingerprint", ".w3-taskset-fingerprint")

# dataset@ver → 三段指纹。只钉「有 lock、三臂已跑完」的那一集。
# 取数：w3-sid-ds41-54 与 w3-cc-sonnet-54 的 lock 唯一 digest 集相等。
CANONICAL = {
    "terminal-bench-w3-54@2.0": "54:b9c053ee6ba0daa0:44587da4ee10d51b",
}


def _sha16(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _load_registry(path: str) -> list:
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    return doc if isinstance(doc, list) else list(doc.get("datasets") or [])


def names_from_registry(registry_path: str, dataset: str) -> list[str] | None:
    """从 registry 取该 dataset 的排序题名。找不到返回 None（调用方报 MISSING）。"""
    name, _, ver = dataset.partition("@")
    ver = ver or None
    for e in _load_registry(registry_path):
        if e.get("name") == name and (ver is None or str(e.get("version")) == ver):
            ts = sorted(t["name"] if isinstance(t, dict) else t for t in e.get("tasks") or [])
            return ts
    return None


def digests_from_lock(lock_path: str) -> list[tuple[str, str]] | None:
    """`(name, digest)` 排序列表。缺 lock / 缺 digest 返回 None。"""
    if not os.path.isfile(lock_path):
        return None
    try:
        with open(lock_path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return None
    rows: list[tuple[str, str]] = []
    for t in doc.get("trials") or []:
        task = t.get("task") if isinstance(t, dict) else None
        if not isinstance(task, dict):
            continue
        n, d = task.get("name"), task.get("digest")
        if n and d:
            rows.append((str(n), str(d)))
    return sorted(rows) if rows else None


def fingerprint_names(names: list[str]) -> str:
    """只含题名的两段指纹（给 gen-w3-54-registry 那种还没有 lock 的生成器）。"""
    ts = sorted(names)
    return f"{len(ts)}:{_sha16(chr(10).join(ts))}"


def compute(
    dataset: str,
    *,
    registry_path: str,
    job_dir: str | None = None,
) -> str:
    names = names_from_registry(registry_path, dataset)
    if names is None:
        return "MISSING"
    name_fp = fingerprint_names(names)
    lock_path = os.path.join(job_dir, "lock.json") if job_dir else ""
    rows = digests_from_lock(lock_path) if lock_path else None
    if not rows:
        return f"{name_fp}:nolock"
    digest_fp = _sha16(chr(10).join(f"{n}\t{d}" for n, d in rows))
    return f"{name_fp}:{digest_fp}"


def compatible(stored: str, now: str) -> bool:
    """旧两段 vs 新三段：前两段相同即视为同一题名集。三段则全等。"""
    if stored == now:
        return True
    a, b = stored.strip().split(":"), now.strip().split(":")
    if a[0] == "MISSING" or b[0] == "MISSING":
        return False
    if len(a) >= 2 and len(b) >= 2 and a[0] == b[0] and a[1] == b[1]:
        # 两段旧文件没有 digest，不能因为新格式多了一段就杀 resume。
        if len(a) < 3 or len(b) < 3:
            return True
        if a[2] in {"nolock", "pending"} or b[2] in {"nolock", "pending"}:
            return True
        return a[2] == b[2]
    return False


def find_stored(job_dir: str) -> tuple[str | None, str | None]:
    """`(内容, 路径)`。两个候选文件都没有 → `(None, None)`。"""
    for name in FP_NAMES:
        p = os.path.join(job_dir, name)
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as fh:
                return fh.read().strip(), p
    return None, None


def canonical_ok(dataset: str, fp: str) -> str | None:
    """不对则返回原因；对或没有钉死值则 None。"""
    want = CANONICAL.get(dataset)
    if not want:
        return None
    parts = fp.split(":")
    want_parts = want.split(":")
    if len(parts) < 3 or parts[2] == "nolock":
        return None  # 还没有 lock，钉死值无从核
    if parts[0] != want_parts[0] or parts[1] != want_parts[1]:
        return (
            f"dataset {dataset} 题名指纹 {parts[0]}:{parts[1]} "
            f"≠ 钉死值 {want_parts[0]}:{want_parts[1]}"
        )
    if parts[2] != want_parts[2]:
        return (
            f"dataset {dataset} digest 指纹 {parts[2]} ≠ 钉死值 {want_parts[2]} "
            "—— 题内容变了，resume 会把两个版本混进一个分母"
        )
    return None


def cmd_compute(args: argparse.Namespace) -> int:
    fp = compute(args.dataset, registry_path=args.registry, job_dir=args.job_dir)
    print(fp)
    return 0 if fp != "MISSING" else 2


def cmd_gate(args: argparse.Namespace) -> int:
    job_dir = args.job_dir
    fp = compute(args.dataset, registry_path=args.registry, job_dir=job_dir)
    if fp == "MISSING":
        print(f"⛔ registry 里找不到 dataset '{args.dataset}' —— 停手。", file=sys.stderr)
        print("   先跑: python3 gen-local-registry.py", file=sys.stderr)
        return 2
    reason = canonical_ok(args.dataset, fp)
    if reason:
        print(f"⛔ {reason}", file=sys.stderr)
        return 2
    stored, path = find_stored(job_dir)
    if stored is None:
        return 0
    if compatible(stored, fp):
        return 0
    print("⛔ **题集与本 job 首跑时不一致** —— resume 会把两个题集混进一个分母，停手。", file=sys.stderr)
    print(f"   首跑: {stored}  ({path})", file=sys.stderr)
    print(f"   现在: {fp}    （格式 = 题数:题名sha16:digest_sha16）", file=sys.stderr)
    print("   多半是中途 docker prune / 重新生成了 registry.local.json / 题内容变了。", file=sys.stderr)
    print("   ⇒ 要么把镜像补回来让指纹复原，要么换一个新 job 名重跑。", file=sys.stderr)
    return 2


def cmd_remember(args: argparse.Namespace) -> int:
    job_dir = args.job_dir
    if not os.path.isdir(job_dir):
        return 0
    stored, _ = find_stored(job_dir)
    if stored is not None:
        return 0  # 已有就不覆盖 —— 覆盖等于把闸拆了
    fp = compute(args.dataset, registry_path=args.registry, job_dir=job_dir)
    if fp == "MISSING":
        return 0
    dest = os.path.join(job_dir, FP_NAMES[0])
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(fp + "\n")
    print(f"--- 已记题集指纹: {fp}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="题集指纹（题名 + digest）")
    ap.add_argument("--registry", default=os.path.join(HERE, "registry.local.json"))
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--job-dir", default="")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("compute")
    sub.add_parser("gate")
    sub.add_parser("remember")
    args = ap.parse_args(argv)
    args.job_dir = args.job_dir or ""
    if args.cmd == "compute":
        return cmd_compute(args)
    if args.cmd == "gate":
        return cmd_gate(args)
    return cmd_remember(args)


if __name__ == "__main__":
    sys.exit(main())
