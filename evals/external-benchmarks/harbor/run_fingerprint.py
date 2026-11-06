#!/usr/bin/env python3
"""run 级配置指纹：采集（collect）+ 比对（compare）。方案 §3.4 的落地。

## 为什么基线是「一组带指纹的逐题结果」，不是一个分数

同一个模型、同一批题，换一版二进制、换一次 harbor、换一个轮数上限，分数都会动。
之后拿两个数并列写「37.8% → 33.3%」，读起来像能力退步，实际可能是三处配置里
任意一处变了。§3.4 的判据是：**指纹不一致的两次结果不能直接比**。

`taskset_fp.py` 只钉了题集这一项（题名 + task.digest）。本文件补齐其余必控变量。

## 落盘位置与「每次 run 都落」

    python3 run_fingerprint.py collect runs/<job>

写 `<job>/run-fingerprint.json`。这是一个**读取现有产物**的动作，不消耗任何模型调用，
所以可以在跑完任何一次 run 之后无脑执行（跑法脚本的收尾处已接，见 w3-run.sh）。

## 「采不到」绝不填默认值

本仓反复踩过同一形态：`null` 在下游被当成 0（成本低报 1.1%，`sid_code_agent.py`
的兜底注释里记着）。指纹同理——缺字段填 `"unknown"` 之后，两份指纹会「一致」，
而这个一致毫无信息量。

所以缺字段一律落 `null` 并进 `missing` 清单，比对时**单边缺失判 INVALID、
双边都缺判 INCOMPLETE**（后者不是通过：只是无法证明差异，与「通过」是两件事）。

## run 内部冲突单列

同一 run 的多个 trial 本该共享同一份二进制/模型。一旦某个字段出现两个值
（中途换了二进制、混了两个 registry），这个 run **本身就不能当一个整体**。
`conflicts` 会记下具体是哪几个 trial 分歧，比对时直接判 INVALID。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import taskset_fp  # noqa: E402

#: 指纹文件格式版本。加字段不一定要 bump；改既有字段的**语义**必须 bump。
SCHEMA_VERSION = 1

FINGERPRINT_FILENAME = "run-fingerprint.json"

#: 判定器 / 执行脚本版本。
#:
#: 改判据（阈值、S 集算法、INVALID 条件、排除规则）时必须 +1。
#: 它参与指纹比对的理由：同一批产物用两套判据能得出相反结论，那时差异不是配置造成的。
#: T12 的判定器（eval-verdict）落地后**复用这一个常量**，不另立版本号。
VERDICT_RULE_VERSION = "1"

#: 参与比对的字段 **闭集**。
#:
#: ⚠️ 白名单而非黑名单（evals/CLAUDE.md §4.5）：比对时若指纹文件里出现本清单之外的键，
#: 说明采集端加了字段而比对端不知道 —— 那会让新字段**静默不参与比对**，
#: 比没有这个字段更糟（看起来「全字段一致」）。所以 compare 遇到未知键直接报错。
FIELDS = (
    "model_id",
    "sid_binary_sha256",
    "sid_commit",
    "arch",
    "harbor_version",
    "taskset_digest",
    "traj_bench_commit",
    "verdict_rule_version",
    "max_turns",
    "budget_usd",
    "max_duration_ms",
    "network_policy",
    "permission_mode",
    "stall_escalation",
)

#: run 产物里**根本没有**、只能由调用方声明的字段。
#:
#: - `traj_bench_commit`：题集仓的 commit。harbor run 只认 tasks 目录，不认它从哪个仓来。
#: - `network_policy`：容器网络档（`allowlist` / `no-network` / `public`）。
#:   Harbor 把它放在 trial 运行期的 network_policy 里，**不写进 result.json**（2026-11-04 核过）。
#: - `cpu` / `mem`：宿主资源，跨机不可比。上面两个不在此列是因为它们能从产物读。
DECLARED_ONLY = ("traj_bench_commit", "network_policy")

#: 每个字段的取数源（`source` 落盘，供审计「这个值从哪来」——§1.7）。
SOURCES = {
    "model_id": "config.json:agents[0].model_name",
    "sid_binary_sha256": "<trial>/result.json:agent_result.metadata.sid_binary_sha256",
    "sid_commit": "<trial>/result.json:agent_result.metadata.sid_commit",
    "arch": "<trial>/agent/sid-code-build.json:arch_actual",
    "harbor_version": "lock.json:harbor",
    "taskset_digest": "lock.json:trials[].task.{name,digest} → taskset_fp.digest_fingerprint",
    "traj_bench_commit": "declared",
    "verdict_rule_version": "run_fingerprint.py:VERDICT_RULE_VERSION",
    "max_turns": "<trial>/result.json:agent_result.metadata.sid_max_turns",
    "budget_usd": "<trial>/result.json:agent_result.metadata.sid_max_budget_usd",
    "max_duration_ms": "<trial>/result.json:agent_result.metadata.sid_max_duration_ms",
    "network_policy": "declared",
    "permission_mode": "<trial>/result.json:agent_result.metadata.sid_permission_mode_requested",
    "stall_escalation": "<trial>/result.json:agent_result.metadata.sid_stall_escalation",
}


# ───────────────────────────────────────────────────────────────── 读产物


def _read_json(path: str) -> object | None:
    """读不到 / 不是合法 JSON 一律 None。**不抛异常**：缺一个文件不该让整次采集失败。"""
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def trial_dirs(run_dir: str) -> list[str]:
    """run 目录下的 trial 子目录，按名字排序（判据是「有 result.json」）。

    ⚠️ 不能用「目录里有什么」猜：harbor 会在同一个 job 目录下放 `config.json` /
    `lock.json` / `job.log`，它们不是 trial。用 `result.json` 当判据是唯一稳的
    ——它也是 harbor 自己 resume 时用的判据（`job.py:333`）。
    """
    if not os.path.isdir(run_dir):
        return []
    out = []
    for name in sorted(os.listdir(run_dir)):
        p = os.path.join(run_dir, name)
        if os.path.isfile(os.path.join(p, "result.json")):
            out.append(p)
    return out


def _collapse(per_trial: dict[str, object]) -> tuple[object, list[str]]:
    """多 trial 的同一字段 → `(唯一值, 冲突证据)`。

    返回值第二项非空 = **run 内部就不一致**，此时第一项为 None（不做「取第一个」这种
    静默择一：那等于把一个分裂的 run 伪装成一个正常的 run）。
    """
    buckets: dict[str, list[str]] = {}
    for trial, value in per_trial.items():
        key = json.dumps(value, sort_keys=True, ensure_ascii=False)
        buckets.setdefault(key, []).append(trial)
    if not buckets:
        return None, []
    if len(buckets) > 1:
        evidence = [f"{k} ← {', '.join(sorted(v))}" for k, v in sorted(buckets.items())]
        return None, evidence
    return json.loads(next(iter(buckets))), []


def collect(run_dir: str, declared: dict[str, str]) -> dict[str, object]:
    """采集一个 run 目录的指纹。**只读**，不写盘（由调用方决定落到哪）。"""
    trials = trial_dirs(run_dir)
    config = _read_json(os.path.join(run_dir, "config.json")) or {}
    lock = _read_json(os.path.join(run_dir, "lock.json")) or {}

    fields: dict[str, object] = {}
    conflicts: dict[str, list[str]] = {}

    def put(name: str, per_trial: dict[str, object]) -> None:
        value, evidence = _collapse(per_trial)
        fields[name] = value
        if evidence:
            conflicts[name] = evidence

    # ── run 级（不随 trial 变） ──
    agents = config.get("agents") if isinstance(config, dict) else None
    if isinstance(agents, list) and agents and isinstance(agents[0], dict):
        fields["model_id"] = agents[0].get("model_name")
    else:
        fields["model_id"] = None

    # ⚠️ `lock.json:harbor` 是一个**对象**（`{"version", "is_editable"}`），不是字符串。
    # 整个 dict 塞进指纹会让比对结果里出现一坨不可读的东西，而人读不懂就没人看；
    # 只看 `version` 是对的：`is_editable` 描述的是「怎么装的」，不影响跑出来的数。
    harbor = lock.get("harbor") if isinstance(lock, dict) else None
    fields["harbor_version"] = harbor.get("version") if isinstance(harbor, dict) else None

    # 题集：复用 taskset_fp 的算法，**不在这里重算一遍**（否则「同一题集」有两个答案）。
    # 取**完整三段**（题数:题名sha16:digest_sha16）而不是只取第三段：
    # 单看 digest 段时，「39 题」与「54 题」的指纹长得一样短，人读不出这是哪一集。
    rows = taskset_fp.digests_from_lock(os.path.join(run_dir, "lock.json"))
    if rows:
        name_fp = taskset_fp.fingerprint_names([n for n, _ in rows])
        fields["taskset_digest"] = f"{name_fp}:{taskset_fp.digest_fingerprint(rows)}"
    else:
        fields["taskset_digest"] = None

    fields["verdict_rule_version"] = VERDICT_RULE_VERSION

    # ── trial 级（逐 trial 读后折叠） ──
    sha: dict[str, object] = {}
    commit: dict[str, object] = {}
    arch: dict[str, object] = {}
    max_turns: dict[str, object] = {}
    budget: dict[str, object] = {}
    duration: dict[str, object] = {}
    perm: dict[str, object] = {}
    stall: dict[str, object] = {}

    for td in trials:
        name = os.path.basename(td)
        result = _read_json(os.path.join(td, "result.json")) or {}
        meta = ((result.get("agent_result") or {}).get("metadata") or {}) if isinstance(
            result, dict
        ) else {}
        build = _read_json(os.path.join(td, "agent", "sid-code-build.json")) or {}

        sha[name] = meta.get("sid_binary_sha256")
        commit[name] = meta.get("sid_commit")
        # ⚠️ 取 `arch_actual`（ELF 读出来的事实），不是 `arch`（那是期望值）。
        # §3.3 那次事故就是 build.json 里只有期望值、它写着 x64 而传的是 arm64 包。
        arch[name] = build.get("arch_actual") if isinstance(build, dict) else None
        max_turns[name] = meta.get("sid_max_turns")
        budget[name] = meta.get("sid_max_budget_usd")
        duration[name] = meta.get("sid_max_duration_ms")
        perm[name] = meta.get("sid_permission_mode_requested")
        stall[name] = meta.get("sid_stall_escalation")

    put("sid_binary_sha256", sha)
    put("sid_commit", commit)
    put("arch", arch)
    put("max_turns", max_turns)
    put("budget_usd", budget)
    put("max_duration_ms", duration)
    put("permission_mode", perm)
    put("stall_escalation", stall)

    # ── 只能声明的 ──
    for name in DECLARED_ONLY:
        fields[name] = declared.get(name)

    missing = [f for f in FIELDS if fields.get(f) is None and f not in conflicts]

    return {
        "schema_version": SCHEMA_VERSION,
        "run_dir": os.path.abspath(run_dir),
        "n_trials": len(trials),
        "fields": {f: fields.get(f) for f in FIELDS},
        "sources": dict(SOURCES),
        "declared": {k: v for k, v in declared.items() if k in DECLARED_ONLY},
        "missing": missing,
        "conflicts": conflicts,
    }


# ───────────────────────────────────────────────────────────────── 比对


def compare(
    base: dict[str, object],
    cur: dict[str, object],
    *,
    under_test: tuple[str, ...] = (),
) -> dict[str, object]:
    """两份指纹 → 逐字段差异。**任何一项不同都判 INVALID 并指名道姓。**

    `under_test` 是**被测变量**：L2 发版闸拿新二进制比基线，二进制 sha / commit
    必然不同 —— 那正是要测的东西，不是配置漂移。这些字段的「值不同」不进 `diffs`，
    改记在 `under_test_diffs`；但**仍要求两边都采到**（单边缺失 / 两边都缺照常判），
    否则裁决说不清测的是哪一版。缺省为空 = 全字段严格相等（T11/T16 的用法不变）。

    返回 `verdict` ∈ {VALID, INCOMPLETE, INVALID}：

    | 结论 | 条件 | 含义 |
    | --- | --- | --- |
    | INVALID | 有字段值不同 / 单边缺失 / 任一侧 run 内部冲突 | 两次结果不能比 |
    | INCOMPLETE | 无差异，但有字段**两边都没有** | 无法证明一致，不等于通过 |
    | VALID | 全部字段都采到且相同 | 可比 |
    """
    bf = base.get("fields") or {}
    cf = cur.get("fields") or {}

    # 未知键 = 采集端加了字段、比对端不知道 → 新字段会静默不参与比对。
    unknown = sorted((set(bf) | set(cf)) - set(FIELDS))
    if unknown:
        raise ValueError(
            f"指纹里有 FIELDS 之外的键 {unknown} —— 采集端加了字段而比对端没同步。"
            "请把它加进 run_fingerprint.FIELDS（白名单，见 evals/CLAUDE.md §4.5）。"
        )

    unknown_ut = sorted(set(under_test) - set(FIELDS))
    if unknown_ut:
        raise ValueError(f"under_test 里有 FIELDS 之外的键 {unknown_ut}")

    diffs: list[dict[str, object]] = []
    under_test_diffs: list[dict[str, object]] = []
    both_missing: list[str] = []

    for name in FIELDS:
        bv, cv = bf.get(name), cf.get(name)
        if bv is None and cv is None:
            both_missing.append(name)
        elif bv is None or cv is None:
            diffs.append({"field": name, "base": bv, "current": cv, "kind": "单边缺失"})
        elif bv != cv:
            entry = {"field": name, "base": bv, "current": cv, "kind": "值不同"}
            (under_test_diffs if name in under_test else diffs).append(entry)

    # run 内部冲突：这个 run 自己就不是一个整体，无论和谁比都不能出结论。
    for side, doc in (("base", base), ("current", cur)):
        for name, evidence in (doc.get("conflicts") or {}).items():
            diffs.append(
                {"field": name, "base": None, "current": None, "kind": f"{side} 内部冲突", "evidence": evidence}
            )

    if diffs:
        verdict = "INVALID"
    elif both_missing:
        verdict = "INCOMPLETE"
    else:
        verdict = "VALID"

    return {
        "verdict": verdict,
        "differing_fields": sorted({d["field"] for d in diffs}),
        "diffs": diffs,
        "both_missing": both_missing,
        "under_test": list(under_test),
        "under_test_diffs": under_test_diffs,
        "base_run": base.get("run_dir"),
        "current_run": cur.get("run_dir"),
        "verdict_rule_version": VERDICT_RULE_VERSION,
    }


def render(report: dict[str, object]) -> str:
    """人读输出。判 INVALID 时**第一行就点名哪个字段**——这是本任务的完成判据。"""
    verdict = report["verdict"]
    lines = [f"=== run 指纹比对 ===  结论: {verdict}"]
    if verdict == "VALID":
        lines.append("  ✅ 全部字段一致，两次结果可直接比较")
    elif verdict == "INCOMPLETE":
        lines.append("  ⚠️ 无差异，但下列字段两边都没采到 —— **无法证明一致，不等于通过**：")
        for name in report["both_missing"]:
            lines.append(f"     - {name}（取数源: {SOURCES.get(name, '?')}）")
    else:
        lines.append(f"  ⛔ 不一致字段: {', '.join(report['differing_fields'])}")
        for d in report["diffs"]:
            if d["kind"] == "值不同":
                lines.append(f"     - {d['field']}: {d['base']!r} → {d['current']!r}")
            elif d["kind"] == "单边缺失":
                lines.append(f"     - {d['field']}: {d['base']!r} → {d['current']!r}（一侧没采到）")
            else:
                lines.append(f"     - {d['field']}: {d['kind']} —— {'; '.join(d.get('evidence') or [])}")
    lines.append(f"  base:    {report.get('base_run')}")
    lines.append(f"  current: {report.get('current_run')}")
    return "\n".join(lines)


# ───────────────────────────────────────────────────────────────── CLI

EXIT = {"VALID": 0, "INVALID": 2, "INCOMPLETE": 3}


def _parse_declared(pairs: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in pairs:
        if "=" not in raw:
            raise SystemExit(f"--declare 需要 key=value 形式，收到 {raw!r}")
        k, v = raw.split("=", 1)
        if k not in DECLARED_ONLY:
            raise SystemExit(
                f"--declare 只接受 run 产物里取不到的字段 {DECLARED_ONLY}，收到 {k!r}。"
                " 其余字段一律从产物读 —— 手工声明会让「采到的」和「声称的」混成一个值。"
            )
        out[k] = v
    return out


def cmd_collect(args: argparse.Namespace) -> int:
    doc = collect(args.run_dir, _parse_declared(args.declare))
    if doc["n_trials"] == 0:
        print(f"⛔ {args.run_dir} 下没有任何 trial（判据: 有 result.json）—— 不落盘。", file=sys.stderr)
        return 1
    out = args.out or os.path.join(args.run_dir, FINGERPRINT_FILENAME)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"已落盘指纹: {out}  （{doc['n_trials']} 个 trial）")
    if doc["missing"]:
        print(f"  ⚠️ 未采到（落 null，不填默认值）: {', '.join(doc['missing'])}")
    if doc["conflicts"]:
        print(f"  ⛔ run 内部冲突: {', '.join(doc['conflicts'])}")
    return 0


def cmd_compare(args: argparse.Namespace) -> int:
    base = _read_json(args.base)
    cur = _read_json(args.current)
    if not isinstance(base, dict):
        print(f"⛔ 读不了基线指纹: {args.base}", file=sys.stderr)
        return 1
    if not isinstance(cur, dict):
        print(f"⛔ 读不了待比指纹: {args.current}", file=sys.stderr)
        return 1
    try:
        report = compare(base, cur)
    except ValueError as exc:
        print(f"⛔ {exc}", file=sys.stderr)
        return 1
    print(render(report))
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return EXIT[report["verdict"]]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="run 级配置指纹：采集 / 比对")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_add = sub.add_parser("collect", help="从 run 目录采集指纹并落盘")
    p_add.add_argument("run_dir")
    p_add.add_argument("--out", default="")
    p_add.add_argument(
        "--declare",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help=f"声明 run 产物里取不到的字段，仅限 {DECLARED_ONLY}，可重复",
    )

    p_cmp = sub.add_parser("compare", help="比对两份指纹，不一致判 INVALID")
    p_cmp.add_argument("base")
    p_cmp.add_argument("current")
    p_cmp.add_argument("--json", action="store_true", help="额外输出机器可读的完整报告")

    args = ap.parse_args(argv)
    return cmd_collect(args) if args.cmd == "collect" else cmd_compare(args)


if __name__ == "__main__":
    sys.exit(main())
