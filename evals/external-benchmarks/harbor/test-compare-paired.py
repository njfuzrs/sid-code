#!/usr/bin/env python3
"""compare-paired.py 的回归测试 —— 重点是外部评测缺陷 28（双向题集检查）。

跑法: python3 test-compare-paired.py

## 本文件的中心判据

> **换档后多出来的题不许静默消失。**

修前（缺陷 28）的实测形态：`new` 侧多一道 `t-extra`，它不在配对表、不在
`➖ 不参与配对`、不在 `⚠️ 尚未跑` —— 一个读者看到 `n=3` 会以为「两侧都是这 3 题」。
而且那道题分数低时，丢掉它会让「换档后」看起来更好（朝有利方向失真）。

所以本文件的断言分两层：
1. `t-extra` **必须出现在输出里**（修复的最低要求）；
2. 默认**拒绝给结论**（rc=2）—— 仅仅打印是不够的，还得不让那个均值被引用。
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tempfile
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def _load_module(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


CP = _load_module("compare_paired", os.path.join(HERE, "compare-paired.py"))

PASS = FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name}  {detail}")


# ─────────────────────────────────────────────────────────── fixture


def _write(path: str, doc: object) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False)


def _write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def make_run(root: str, rewards: dict[str, float], *, no_verifier: set[str] | None = None) -> str:
    """造一个最小的 Harbor job 目录（只覆盖 compare-paired 用到的判据）。"""
    no_verifier = no_verifier or set()
    for i, (task, reward) in enumerate(sorted(rewards.items())):
        td = os.path.join(root, f"{task}__h{i}")
        _write(
            os.path.join(td, "result.json"),
            {
                "verifier_result": {"rewards": {"reward": reward}},
                "agent_result": {"n_input_tokens": 100, "n_output_tokens": 10},
            },
        )
        if task not in no_verifier:
            _write_text(os.path.join(td, "verifier", "stdout.txt"), "1 passed in 0.1s\n")
        _write_text(
            os.path.join(td, "agent", "sid-home", "debug.log"), "[PERF] startup\n[APP] 初始化\n"
        )
    return root


def run(argv: list[str]) -> tuple[int, str]:
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = CP.main(argv)
    return rc, buf.getvalue()


# ─────────────────────────────────────────────────────── 正向：配对可比


def test_paired_ok() -> None:
    print("\n=== ① 两侧题集一致 → 给结论 ===")
    with tempfile.TemporaryDirectory() as tmp:
        base = make_run(os.path.join(tmp, "base"), {"a": 0.0, "b": 0.0, "c": 0.0})
        new = make_run(os.path.join(tmp, "new"), {"a": 1.0, "b": 1.0, "c": 1.0})
        rc, out = run([base, new])
        check("rc=0", rc == 0, str(rc))
        check("配对均值 0.000 → 1.000", "0.000 → 1.000" in out, out[-300:])
        check("↑3 题 / ↓0 题", "↑3 题 / ↓0 题" in out, out[-300:])
        check("分母写明 n=3", "n=3" in out, out[-300:])


def test_dropped_side() -> None:
    print("\n=== ② 任一侧被排除 → 整对退出配对 ===")
    with tempfile.TemporaryDirectory() as tmp:
        base = make_run(os.path.join(tmp, "base"), {"a": 0.0, "b": 0.0, "c": 0.0})
        new = make_run(os.path.join(tmp, "new"), {"a": 1.0, "b": 1.0, "c": 1.0}, no_verifier={"b"})
        rc, out = run([base, new])
        check("rc=0（还有 2 题可比）", rc == 0, str(rc))
        check("b 进入「不参与配对」清单", "➖ 1 题不参与配对" in out, out[-500:])
        check("写明原因 verifier未判分", "verifier未判分" in out, out[-500:])
        check("配对均值 n=2", "n=2" in out, out[-500:])


# ─────────────────────────────── 缺陷 28：两个方向都要查（本文件的存在理由）


def test_base_only_refuses() -> None:
    print("\n=== ③ 基线有、换档后没跑 → 拒绝给结论 ===")
    with tempfile.TemporaryDirectory() as tmp:
        base = make_run(os.path.join(tmp, "base"), {"a": 0.0, "b": 0.0, "c": 0.0})
        new = make_run(os.path.join(tmp, "new"), {"a": 1.0, "b": 1.0})
        rc, out = run([base, new])
        check("rc=2（拒绝）", rc == 2, str(rc))
        check("点名 c 尚未跑", "尚未跑" in out and "['c']" in out, out[-500:])
        check("不输出配对均值", "配对均值" not in out, out[-300:])


def test_new_only_refuses() -> None:
    """缺陷 28 的核心回归：new 独有题必须被打印，且默认拒绝给结论。"""
    print("\n=== ④ 换档后多出来的题 → 打印 + 拒绝给结论（缺陷 28）===")
    with tempfile.TemporaryDirectory() as tmp:
        base = make_run(os.path.join(tmp, "base"), {"a": 0.0, "b": 0.0, "c": 0.0})
        new = make_run(os.path.join(tmp, "new"), {"a": 1.0, "b": 1.0, "c": 1.0, "t-extra": 0.0})
        rc, out = run([base, new])
        check("t-extra 出现在输出里", "t-extra" in out, out[-600:])
        check("rc=2（题集不一致，拒绝给结论）", rc == 2, str(rc))
        check("点名「不在基线里」", "不在基线里" in out, out[-600:])
        check("不输出配对均值", "配对均值" not in out, out[-300:])


def test_new_only_allow_extra() -> None:
    print("\n=== ⑤ --allow-extra → 继续给结论，但清单仍在 ===")
    with tempfile.TemporaryDirectory() as tmp:
        base = make_run(os.path.join(tmp, "base"), {"a": 0.0, "b": 0.0, "c": 0.0})
        new = make_run(os.path.join(tmp, "new"), {"a": 1.0, "b": 1.0, "c": 1.0, "t-extra": 0.0})
        rc, out = run([base, new, "--allow-extra"])
        check("rc=0", rc == 0, str(rc))
        check("t-extra 仍被打印", "t-extra" in out, out[-600:])
        check("写明按 --allow-extra 忽略", "已按 --allow-extra 显式忽略" in out, out[-600:])
        check("配对均值 n=3（t-extra 不计入）", "n=3" in out, out[-400:])


def test_json_report_has_both_sides() -> None:
    print("\n=== ⑥ --json 报告同时含 base_only 与 new_only ===")
    with tempfile.TemporaryDirectory() as tmp:
        base = make_run(os.path.join(tmp, "base"), {"a": 0.0, "b": 0.0, "c": 0.0})
        new = make_run(os.path.join(tmp, "new"), {"a": 1.0, "b": 1.0, "d": 0.0})
        rc, out = run([base, new, "--allow-extra", "--json"])
        # 输出里最后一段是 JSON；直接找最外层的 {
        start = out.find("{\n")
        doc = json.loads(out[start:])
        # ⚠️ `--allow-extra` 只放行 new_only；base_only 是「尚未跑」，
        # 刻意没有放行开关 —— 所以这里仍应 rc=2。
        check("rc=2（allow-extra 不放行 base_only）", rc == 2, str(rc))
        check("base_only 含 c", doc["base_only"] == ["c"], str(doc["base_only"]))
        check("new_only 含 d", doc["new_only"] == ["d"], str(doc["new_only"]))
        check("allow_extra=True 被记录", doc["allow_extra"] is True)


def test_all_excluded_refuses() -> None:
    print("\n=== ⑦ 所有题都被排除 → 不是「没有变化」 ===")
    with tempfile.TemporaryDirectory() as tmp:
        base = make_run(os.path.join(tmp, "base"), {"a": 0.0, "b": 0.0})
        new = make_run(
            os.path.join(tmp, "new"), {"a": 1.0, "b": 1.0}, no_verifier={"a", "b"}
        )
        rc, out = run([base, new])
        check("rc=2", rc == 2, str(rc))
        check("写明「没有任何样本可比」", "没有任何样本可比" in out, out[-400:])


def main() -> int:
    print("=" * 64)
    print("  compare-paired.py —— 双向题集检查回归（外部评测缺陷 28）")
    print("=" * 64)
    test_paired_ok()
    test_dropped_side()
    test_base_only_refuses()
    test_new_only_refuses()
    test_new_only_allow_extra()
    test_json_report_has_both_sides()
    test_all_excluded_refuses()
    print("\n" + "=" * 64)
    print(f"  通过 {PASS} / 失败 {FAIL}")
    print("=" * 64)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
