#!/usr/bin/env python3
"""taskset_fp.py 的正向断言 + 变异自证。

全部在 tmpdir 造 registry / lock，不碰 runs/。

跑法: python3 test-taskset-fp.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import taskset_fp as T  # noqa: E402

PASS = FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name}  {detail}")


def _reg(dir: str, name: str, ver: str, tasks: list[str]) -> str:
    os.makedirs(dir, exist_ok=True)
    path = os.path.join(dir, "registry.local.json")
    doc = [{
        "name": name,
        "version": ver,
        "tasks": [{"name": t, "git_url": "x", "git_commit_id": "y", "path": t} for t in tasks],
    }]
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh)
    return path


def _lock(job: str, pairs: list[tuple[str, str]]) -> str:
    os.makedirs(job, exist_ok=True)
    trials = [{"task": {"name": n, "digest": d}} for n, d in pairs]
    path = os.path.join(job, "lock.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"trials": trials}, fh)
    return path


def run() -> int:
    tmp = tempfile.mkdtemp(prefix="taskset-fp-")
    try:
        print("① 指纹含 digest，不只是题名")
        reg = _reg(tmp, "tb", "2.0", ["b-task", "a-task"])
        job = os.path.join(tmp, "job")
        _lock(job, [("a-task", "sha256:aaa"), ("b-task", "sha256:bbb")])
        fp = T.compute("tb@2.0", registry_path=reg, job_dir=job)
        parts = fp.split(":")
        check("三段", len(parts) == 3, fp)
        check("题数", parts[0] == "2", fp)
        names_only = T.fingerprint_names(["b-task", "a-task"])
        check("前两段 = 题名指纹", fp.startswith(names_only + ":"), fp)
        # 同名、digest 变 → 第三段必须变
        job2 = os.path.join(tmp, "job2")
        _lock(job2, [("a-task", "sha256:CHANGED"), ("b-task", "sha256:bbb")])
        fp2 = T.compute("tb@2.0", registry_path=reg, job_dir=job2)
        check("digest 变了第三段不同", fp.split(":")[2] != fp2.split(":")[2], f"{fp} vs {fp2}")
        check("题名没变前两段相同", fp.rsplit(":", 1)[0] == fp2.rsplit(":", 1)[0])

        print("\n② 无 lock → 第三段 nolock，不假装钉死")
        empty = os.path.join(tmp, "empty-job")
        os.makedirs(empty, exist_ok=True)
        fp_nl = T.compute("tb@2.0", registry_path=reg, job_dir=empty)
        check("nolock", fp_nl.endswith(":nolock"), fp_nl)

        print("\n③ 旧两段文件与新三段兼容（不误杀 resume）")
        old = names_only
        check("compatible(旧两段, 新三段)", T.compatible(old, fp) is True)
        check("compatible(新, 新)", T.compatible(fp, fp) is True)
        check("题名变了就不兼容", T.compatible(old, T.fingerprint_names(["other"])) is False)

        print("\n④ gate：题集变了必须红")
        stored = os.path.join(job, ".w3-taskset-fingerprint")
        with open(stored, "w", encoding="utf-8") as fh:
            fh.write(fp + "\n")
        rc = T.main(["--registry", reg, "--dataset", "tb@2.0", "--job-dir", job, "gate"])
        check("未变 → gate 0", rc == 0, str(rc))
        # 换 registry 题名
        _reg(os.path.join(tmp, "reg-b"), "tb", "2.0", ["a-task", "c-task"])
        rc2 = T.main(["--registry", os.path.join(tmp, "reg-b", "registry.local.json"),
                      "--dataset", "tb@2.0", "--job-dir", job, "gate"])
        check("题名变了 → gate 2", rc2 == 2, str(rc2))

        print("\n⑤ remember 不覆盖已有指纹")
        T.main(["--registry", reg, "--dataset", "tb@2.0", "--job-dir", job, "remember"])
        with open(stored, encoding="utf-8") as fh:
            check("原文件没被覆盖", fh.read().strip() == fp)

        print("\n⑥ canonical：W3-54 钉死值形状")
        want = T.CANONICAL["terminal-bench-w3-54@2.0"]
        check("钉死值三段", want.count(":") == 2, want)
        check("钉死值题数 54", want.startswith("54:"), want)
        # nolock 时不拿钉死值挡首跑
        check("nolock 不触发 canonical", T.canonical_ok("terminal-bench-w3-54@2.0", "54:aaaa:nolock") is None)
        check("digest 不对要报", T.canonical_ok("terminal-bench-w3-54@2.0", "54:b9c053ee6ba0daa0:deadbeefdeadbeef") is not None)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'=' * 60}\n  通过 {PASS} / 失败 {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(run())
