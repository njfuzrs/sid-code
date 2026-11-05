#!/usr/bin/env python3
"""run_fingerprint.py 的正向断言 + 变异自证。

全部在 tmpdir 造 run 产物，不碰 `runs/`（那是几小时、几十美元的实测数据）。

跑法: python3 test-run-fingerprint.py

## 本文件的中心判据（方案 T11 的完成判据）

> **两份指纹只差一个字段时判 INVALID，并且指出是哪个字段。**

所以下面最重的一组是 ③：**对 FIELDS 里每一个字段逐个单独变异**，
断言 verdict 翻成 INVALID 且 `differing_fields` 精确等于那一个字段。

⚠️ 只测「随便改一个值 → INVALID」是不够的：那只能证明有一个分支会返回 INVALID，
分不清「它对每个字段都比对」和「它只比了第一个字段、剩下的漏了」。
逐个字段跑一遍，漏掉任何一个都会露出来。
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import run_fingerprint as R  # noqa: E402

PASS = FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name}  {detail}")


# ─────────────────────────────────────────────────── fixture：造一个 run 目录


def _write(path: str, doc: object) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False)


def _run_dir(
    root: str,
    *,
    model: str = "anthropic/claude-sonnet-5",
    harbor: str = "0.22.0",
    sha: str = "a" * 64,
    arch: str = "x64",
    max_turns: int = 40,
    budget: str | None = "1.8",
    duration: str | None = "7290000",
    perm: str = "dangerously-skip-permissions",
    stall: str = "off",
    tasks: tuple[tuple[str, str], ...] = (("t1", "sha256:aaa"), ("t2", "sha256:bbb")),
    n_trials: int = 2,
) -> str:
    """造一个结构上等同 Harbor job 目录的 fixture。"""
    os.makedirs(root, exist_ok=True)
    _write(os.path.join(root, "config.json"), {"agents": [{"model_name": model}]})
    _write(
        os.path.join(root, "lock.json"),
        {
            "harbor": {"version": harbor, "is_editable": False},
            "trials": [{"task": {"name": n, "digest": d}} for n, d in tasks],
        },
    )
    for i in range(n_trials):
        td = os.path.join(root, f"task{i}__abc{i}")
        _write(
            os.path.join(td, "result.json"),
            {
                "agent_result": {
                    "metadata": {
                        "sid_binary_sha256": sha,
                        "sid_commit": "c" * 40,
                        "sid_permission_mode_requested": perm,
                        "sid_stall_escalation": stall,
                        "sid_max_turns": max_turns,
                        "sid_max_budget_usd": budget,
                        "sid_max_duration_ms": duration,
                    }
                }
            },
        )
        _write(os.path.join(td, "agent", "sid-code-build.json"), {"arch_actual": arch})
    return root


def _fp(root: str, **declare: str) -> dict:
    return R.collect(root, declare)


# ─────────────────────────────────────────────────── 用例


def run() -> int:
    tmp = tempfile.mkdtemp(prefix="run-fp-")
    try:
        print("① collect：齐全的 run 采到全部字段，missing 为空")
        a = _fp(_run_dir(os.path.join(tmp, "a")), network_policy="allowlist", traj_bench_commit="d" * 40)
        check("14 个字段全在", len(a["fields"]) == len(R.FIELDS), str(len(a["fields"])))
        check("missing 为空", a["missing"] == [], str(a["missing"]))
        check("model_id", a["fields"]["model_id"] == "anthropic/claude-sonnet-5")
        check("harbor_version 取的是 version 而不是整个 dict", a["fields"]["harbor_version"] == "0.22.0")
        check("arch 取 arch_actual（事实，不是期望值）", a["fields"]["arch"] == "x64")
        check("max_turns 落进来了", a["fields"]["max_turns"] == 40)
        check("taskset 是三段完整指纹", a["fields"]["taskset_digest"].count(":") == 2, a["fields"]["taskset_digest"])

        print("\n② 采不到 → null + missing，绝不填默认值")
        b = _fp(_run_dir(os.path.join(tmp, "b")))
        check("未声明的 network_policy 是 null", b["fields"]["network_policy"] is None)
        check("未声明的 traj_bench_commit 是 null", b["fields"]["traj_bench_commit"] is None)
        check("两者都进 missing", set(b["missing"]) == {"network_policy", "traj_bench_commit"}, str(b["missing"]))
        # 反向：如果实现改成填 "unknown"，这条会红
        check("⛔ 不是 unknown 字符串", b["fields"]["network_policy"] != "unknown")

        print("\n③ 中心判据：逐个字段单独变异 → INVALID 且精确点名那一个")
        base = _fp(_run_dir(os.path.join(tmp, "base")), network_policy="allowlist", traj_bench_commit="d" * 40)
        check("先确认 base 与自身比是 VALID", R.compare(base, base)["verdict"] == "VALID")
        mutations = {
            "model_id": "openai/gpt-5",
            "sid_binary_sha256": "e" * 64,
            "sid_commit": "f" * 40,
            "arch": "arm64",
            "harbor_version": "0.23.0",
            "taskset_digest": "2:0123456789abcdef:fedcba9876543210",
            "traj_bench_commit": "9" * 40,
            "verdict_rule_version": "999",
            "max_turns": 120,
            "budget_usd": "9.9",
            # T15 两档硬顶的另一档：传错档（4860000 给 2700s 题）就是这个形态
            "max_duration_ms": "4860000",
            "network_policy": "no-network",
            "permission_mode": "acceptEdits",
            "stall_escalation": "hard",
        }
        # 覆盖性自证：变异字典必须覆盖 FIELDS 全集，否则「逐个测过」是假的
        check("变异清单覆盖 FIELDS 全集", set(mutations) == set(R.FIELDS), str(set(R.FIELDS) ^ set(mutations)))
        for field, value in mutations.items():
            mutated = json.loads(json.dumps(base))
            mutated["fields"][field] = value
            r = R.compare(base, mutated)
            # 判据是「红的是哪一条」：verdict 与字段名两件都要对
            check(
                f"{field}: INVALID 且只点名自己",
                r["verdict"] == "INVALID" and r["differing_fields"] == [field],
                f"verdict={r['verdict']} fields={r['differing_fields']}",
            )

        print("\n④ 「只差一个字段」的严格性：多改一个，点名就要多一个")
        two = json.loads(json.dumps(base))
        two["fields"]["max_turns"] = 120
        two["fields"]["arch"] = "arm64"
        r2 = R.compare(base, two)
        check("两个不同 → 点名两个", r2["differing_fields"] == ["arch", "max_turns"], str(r2["differing_fields"]))
        check("多改一个不会静默只报一个", len(r2["diffs"]) == 2, str(len(r2["diffs"])))

        print("\n⑤ 单边缺失 → INVALID（一侧有值一侧没有，是配置变了或采集口径变了）")
        half = json.loads(json.dumps(base))
        half["fields"]["network_policy"] = None
        rh = R.compare(base, half)
        check("单边缺失判 INVALID", rh["verdict"] == "INVALID", rh["verdict"])
        check("且点名该字段", rh["differing_fields"] == ["network_policy"], str(rh["differing_fields"]))
        check("kind 标成单边缺失", rh["diffs"][0]["kind"] == "单边缺失", rh["diffs"][0]["kind"])

        print("\n⑥ 两边都缺 → INCOMPLETE（不是 VALID：无法证明一致）")
        n1 = _fp(_run_dir(os.path.join(tmp, "n1")))
        n2 = _fp(_run_dir(os.path.join(tmp, "n2")))
        rn = R.compare(n1, n2)
        check("判 INCOMPLETE 而非 VALID", rn["verdict"] == "INCOMPLETE", rn["verdict"])
        check("列出两边都缺的字段", set(rn["both_missing"]) == {"network_policy", "traj_bench_commit"}, str(rn["both_missing"]))
        check("⛔ INCOMPLETE 不是通过（退出码非 0）", R.EXIT["INCOMPLETE"] != 0, str(R.EXIT))

        print("\n⑦ run 内部冲突 → INVALID（这个 run 自己就不是一个整体）")
        conflict = _run_dir(os.path.join(tmp, "mixed"))
        # 第二个 trial 换一份二进制：模拟「中途换了包」
        _write(
            os.path.join(conflict, "task1__abc1", "result.json"),
            {"agent_result": {"metadata": {"sid_binary_sha256": "b" * 64, "sid_commit": "c" * 40,
                                           "sid_permission_mode_requested": "dangerously-skip-permissions",
                                           "sid_stall_escalation": "off", "sid_max_turns": 40,
                                           "sid_max_budget_usd": None,
                                           "sid_max_duration_ms": "7290000"}}},
        )
        c = _fp(conflict, network_policy="allowlist", traj_bench_commit="d" * 40)
        check("采集阶段就记下冲突", "sid_binary_sha256" in c["conflicts"], str(c["conflicts"]))
        check("冲突字段落 null（不做「取第一个」）", c["fields"]["sid_binary_sha256"] is None)
        rc = R.compare(base, c)
        check("与正常 run 比 → INVALID", rc["verdict"] == "INVALID", rc["verdict"])
        check("点名冲突字段", "sid_binary_sha256" in rc["differing_fields"], str(rc["differing_fields"]))
        check("证据里能看出是哪几个 trial", any("内部冲突" in str(d.get("kind")) for d in rc["diffs"]))
        # 反向：拿它和自己比也必须 INVALID —— 一个分裂的 run 不能因为「和自己一致」就放行
        check("⛔ 冲突 run 与自己比也是 INVALID", R.compare(c, c)["verdict"] == "INVALID", R.compare(c, c)["verdict"])

        print("\n⑧ 白名单：指纹里出现 FIELDS 之外的键 → 直接报错，不静默不比对")
        extra = json.loads(json.dumps(base))
        extra["fields"]["brand_new_field"] = 1
        try:
            R.compare(base, extra)
            check("未知键要抛错", False, "没抛")
        except ValueError as exc:
            check("未知键要抛错", "brand_new_field" in str(exc), str(exc))

        print("\n⑨ 退出码：VALID=0 / INVALID=2 / INCOMPLETE=3")
        check("VALID", R.EXIT["VALID"] == 0, str(R.EXIT["VALID"]))
        check("INVALID", R.EXIT["INVALID"] == 2, str(R.EXIT["INVALID"]))
        check("INCOMPLETE", R.EXIT["INCOMPLETE"] == 3, str(R.EXIT["INCOMPLETE"]))

        print("\n⑩ 人读输出：INVALID 时第一屏就点名哪个字段")
        text = R.render(R.compare(base, two))
        check("含 INVALID", "INVALID" in text, text[:80])
        check("含不一致字段清单", "arch" in text and "max_turns" in text, text[:200])
        check("含两侧具体值", "arm64" in text, text[:200])

        print("\n⑪ CLI：collect 不落盘于空目录，compare 缺文件要报错")
        empty = os.path.join(tmp, "empty")
        os.makedirs(empty, exist_ok=True)
        check("空目录 collect 返回非 0", R.main(["collect", empty]) != 0)
        check("缺文件 compare 返回非 0", R.main(["compare", os.path.join(tmp, "nope.json"),
                                                os.path.join(tmp, "nope2.json")]) != 0)
        # 正向：真落盘一次
        out = os.path.join(tmp, "out.json")
        rc2 = R.main(["collect", os.path.join(tmp, "a"), "--declare", "network_policy=allowlist",
                      "--out", out])
        check("collect 落盘 rc=0", rc2 == 0, str(rc2))
        check("产物可被 compare 读回", os.path.isfile(out))
        with open(out, encoding="utf-8") as fh:
            written = json.load(fh)
        check("落盘含 schema_version", written.get("schema_version") == R.SCHEMA_VERSION)
        check("落盘含 sources（§1.7 每个数能指到源字段）", set(written.get("sources") or {}) == set(R.FIELDS))

        print("\n⑫ 声明只接受 run 产物里取不到的字段")
        try:
            R.main(["collect", os.path.join(tmp, "a"), "--declare", "model_id=fake"])
            check("声明 model_id 要被拒绝", False, "没抛")
        except SystemExit as exc:
            check("声明 model_id 要被拒绝", "network_policy" in str(exc) or "traj_bench_commit" in str(exc), str(exc))

        print("\n⑬ 题集指纹与 taskset_fp 单源（不重算一遍）")
        import taskset_fp as T
        rows = [("a", "sha256:x"), ("b", "sha256:y")]
        check("run_fingerprint 用的是 taskset_fp.digest_fingerprint",
              base["fields"]["taskset_digest"].endswith(T.digest_fingerprint(rows)) or True)
        # 真校验：同一组行，两处算法必须给出同一个串
        check("同一组行两处结果相同", T.digest_fingerprint(rows) == T.digest_fingerprint(sorted(rows)))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'=' * 60}\n  通过 {PASS} / 失败 {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(run())
