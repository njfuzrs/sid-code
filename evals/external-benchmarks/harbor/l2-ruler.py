#!/usr/bin/env python3
r"""L2 发版闸的**尺子桥**：让 `scripts/eval/release-gate.ts` 调用钉在基线 commit 上的
agent-traj-bench 自己的跑批逻辑（`scripts/t15-baseline.py`），而不是在 sid-code 里复制一份。

用法（每个子命令的结论是 stdout 最后一行 `L2RULER_JSON {...}`，其余日志走 stderr）:

    <harbor 的 python> l2-ruler.py preflight --ruler <traj-bench checkout> --binary <linux-arm64 二进制> --out <dir>
    <harbor 的 python> l2-ruler.py precheck  --ruler <...> --agent oracle|nop --out <dir>
    <harbor 的 python> l2-ruler.py run       --ruler <...> --binary <...> --out <dir>

退出码：0 = 判定通过 / 2 = 判定不通过（红项在 JSON 的 `red`）/ 1 = 用法错误或尺子接口不符。

## 为什么是「加载尺子仓的模块」，而不是在这里写 harbor 命令

基线指纹只覆盖一部分配置（模型、轮数、预算、max_duration_ms、题集 digest …），
**覆盖不到** `-n` 并发、`--agent-timeout-multiplier`、`--verifier-timeout-multiplier`
这几项 —— 而它们都会改分数（并发影响 infra 失败率，超时倍数决定 harbor 硬顶）。
T15 基线的 harbor 命令是 `t15-baseline.build_cmd()` 拼的；L2 用同一个函数、
同一个 commit 上的同一份源码拼，这几项才**结构上**等于基线，而不是「抄的时候没抄错」。

## 为什么不直接调 `t15-baseline.py`（它的 main）

1. 它的闸I 要求二进制 `dirty == false` 且旁边有 `build-info.json` —— 那是**基线**
   二进制的判据。发布产物必然 dirty（release.sh 先 bump 再构建），tarball 里也没有
   旁路文件，照搬会把每次发版都拦下（方案 T20 行 2026-11-06 的裁决）。被测二进制的
   身份改由 TS 侧走 G2 判据 `judgeReleaseUpload`；这里只留 ELF 架构这一条。
2. 它的产物目录写死在尺子仓里（`reports/t15-baseline/`），L2 要写到
   `~/.sid-code/eval-gate/runs/<version>/`，不能往钉住的尺子仓里落东西。
3. 不能改尺子仓本身：指纹里的 `traj_bench_commit` 必须等于基线那次的 commit，
   给它加一个 `--under-test` 开关就换了尺子，T15 基线当场作废。

## 依赖尺子仓的哪些名字（`REQUIRED`）

只认下面这张表；尺子仓重建基线时改了其中任何一个，这里在**跑任何东西之前**
报「尺子接口不符」退出 1，而不是跑到一半才炸。
"""

from __future__ import annotations

import argparse
import contextlib
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import run_fingerprint  # noqa: E402
import trial_outcomes as O  # noqa: E402

#: 尺子模块必须有的名字。⛔ 改尺子仓的这些名字 = 换尺子，见文件头。
REQUIRED = (
    "OUT",
    "FP_DIR",
    "DIST_TASKS",
    "N_CONCURRENT",
    "DURATION_BY_TIMEOUT",
    "tiers",
    "stage_tier",
    "build_cmd",
    "build_env",
    "preflight",
    "gate_binary",
    "elf_arch",
    "scored_tasks",
    "bypass_loopback_proxy",
    "c",
)

#: 只测这一个平台：traj-bench 容器是 linux/arm64（colima on Apple Silicon）。
#: 裁决因此**只覆盖 linux-arm64**，其余 4 个平台未经 L2（方案 P3「做什么」1）。
UNDER_TEST_ARCH = "arm64"

#: 与 `t15-baseline.collect_fingerprint` 声明的同值（那里写死 `network_policy=allowlist`）；
#: 是否真的落地由尺子自己的闸E 校验（allowlist + 网关唯一放行）。
NETWORK_POLICY = "allowlist"

#: stdout 结论行前缀。日志与结论分流：尺子模块与 harbor 都会往 stdout 打字。
JSON_PREFIX = "L2RULER_JSON "

EXIT_OK = 0
EXIT_USAGE = 1
EXIT_RED = 2


class RulerError(Exception):
    """尺子仓不对（接口不符 / commit 不对 / 被改过）—— 不是「判定不通过」，是根本没法判。"""


def emit(doc: dict[str, Any], code: int) -> int:
    """结论行只走 stdout 最后一行；调用方按前缀取，不解析日志。"""
    print(JSON_PREFIX + json.dumps(doc, ensure_ascii=False), flush=True)
    return code


def git_head(ruler: Path) -> str | None:
    r = subprocess.run(
        ["git", "-C", str(ruler), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
    )
    v = r.stdout.strip()
    return v if r.returncode == 0 and len(v) == 40 else None


def git_tracked_changes(ruler: Path) -> list[str]:
    """尺子仓**已跟踪**文件的改动（`--untracked-files=no`）。

    未跟踪的不算：`dist/` 由尺子自己的闸B（digest 三处一致）校验，`reports/` 是产物。
    已跟踪文件被改过 ⇒ 跑的不是 `traj_bench_commit` 那份尺子，而指纹里那一格仍会
    声明成那个 commit —— 一个会撒谎的字段，比没有更糟。
    """
    r = subprocess.run(
        ["git", "-C", str(ruler), "status", "--porcelain", "--untracked-files=no"],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
    )
    if r.returncode != 0:
        return [f"<git status 失败: {r.stderr.strip()[:200]}>"]
    return [line for line in r.stdout.splitlines() if line.strip()]


def check_ruler_state(ruler: Path, expect_commit: str) -> tuple[str | None, list[str]]:
    """尺子 checkout 必须正好是基线那次的 commit，且已跟踪文件没被改过。"""
    red: list[str] = []
    head = git_head(ruler)
    if head is None:
        red.append(f"尺子 {ruler} 不是 git checkout（取不到 HEAD）")
    elif head != expect_commit:
        red.append(
            f"尺子 HEAD={head[:12]}，基线的 traj_bench_commit={expect_commit[:12]} —— "
            f"换了尺子就不能和这份基线比。先 `git -C {ruler} checkout {expect_commit}`"
        )
    changed = git_tracked_changes(ruler)
    if changed:
        red.append(f"尺子仓已跟踪文件有改动（{len(changed)} 处，如 {changed[:3]}）—— 跑的不是那份尺子")
    return head, red


def load_ruler(ruler: Path, out: Path):
    """加载尺子仓的 `scripts/t15-baseline.py`，并把它的产物根改到 `out`。

    `tier_dir` / `stage_tier` 在**调用时**读模块全局 `OUT`，所以改全局即可，
    不往尺子仓里落任何文件。
    """
    script = ruler / "scripts" / "t15-baseline.py"
    if not script.is_file():
        raise RulerError(f"{script} 不存在 —— --ruler 不是 agent-traj-bench checkout？")
    spec = importlib.util.spec_from_file_location("l2_ruler_t15", script)
    if spec is None or spec.loader is None:
        raise RulerError(f"无法加载 {script}")
    mod = importlib.util.module_from_spec(spec)
    with contextlib.redirect_stdout(sys.stderr):
        spec.loader.exec_module(mod)
    missing = [n for n in REQUIRED if not hasattr(mod, n)]
    if missing:
        raise RulerError(f"尺子接口不符：{script} 缺 {missing}（尺子仓重建基线时改了名字？）")
    mod.OUT = out
    mod.FP_DIR = out / "fingerprints"
    mod.gate_binary = make_gate_binary(mod)
    return mod


def make_gate_binary(mod):
    """替换尺子的闸I：只核 ELF 架构（理由见文件头第 1 条）。签名与原闸一致。"""

    def gate_binary(binary: Path) -> tuple[list[str], str | None]:
        if not binary.is_file():
            return [f"闸I′ 二进制不存在：{binary}"], None
        got = mod.elf_arch(binary)
        print(f"  闸I′ ELF={got}（被测二进制身份已由 release-gate 按 G2 判据核过，这里不核 dirty）")
        if got != UNDER_TEST_ARCH:
            return [f"闸I′ 二进制 ELF 架构 {got}，L2 只测 linux-{UNDER_TEST_ARCH}"], None
        return [], None

    return gate_binary


def adapter_env(mod, binary: Path) -> dict[str, str]:
    """尺子的 `build_env`，但 PYTHONPATH 指向**本 checkout** 的适配器目录。

    尺子 t7 把适配器路径写死成 `~/Code/person/sid-code/...`；L2 由哪份 sid-code 发起，
    就该用哪份的适配器，否则 worktree 里改了适配器、跑的却是主仓那份（§3.1 同型）。
    """
    env = dict(mod.build_env(binary))
    env["PYTHONPATH"] = HERE
    return env


def run_dirs_under(jobs: Path) -> list[str]:
    """harbor 在 `-o` 下建的时间戳目录（与尺子 `judged_tasks` 同一判据：名字以 20 开头）。"""
    if not jobs.is_dir():
        return []
    return sorted(str(p) for p in jobs.iterdir() if p.is_dir() and p.name[:2] == "20")


def run_harbor(cmd: list[str], jobs: Path, env: dict[str, str]) -> tuple[int, str | None, Path]:
    """跑一次 harbor，返回 (退出码, 新出现的 run 目录, 日志)。

    ⚠️ 不能看退出码：harbor 失败时也返 0（尺子 README）。判据是产物。
    """
    jobs.mkdir(parents=True, exist_ok=True)
    before = set(run_dirs_under(jobs))
    log = jobs / f"run-{time.strftime('%Y%m%d-%H%M%S')}.log"
    with open(log, "w", encoding="utf-8") as fh:
        rc = subprocess.run(
            cmd, stdout=fh, stderr=subprocess.STDOUT, env=env, check=False, stdin=subprocess.DEVNULL
        ).returncode
    new = sorted(set(run_dirs_under(jobs)) - before)
    return rc, (new[-1] if len(new) == 1 else None), log


# ───────────────────────────────────────────── oracle / nop 预检（§5.4-3：先 $0 后真钱）

#: 预检期望的 reward。oracle 照 gold patch 改 ⇒ 全 1；nop 什么都不改 ⇒ 全 0。
PRECHECK_EXPECT = {"oracle": 1.0, "nop": 0.0}


def precheck_cmd(mod, agent: str, jobs: Path) -> list[str]:
    """oracle / nop 的 harbor 命令。并发与 verifier 超时倍数**取自尺子的 build_cmd**，不另写。"""
    base = mod.build_cmd(Path("_"), Path("_"), 0)
    flag = "--verifier-timeout-multiplier"
    vmult = base[base.index(flag) + 1] if flag in base else None
    cmd = ["harbor", "run", "-p", str(mod.DIST_TASKS), "-a", agent,
        "-n", str(mod.N_CONCURRENT), "-k", "1", "-o", str(jobs)]
    if vmult is not None:
        cmd += [flag, vmult]
    return cmd + ["-y"]


def _exception_name(result: dict[str, Any]) -> str | None:
    exc = result.get("exception_info")
    if not exc:
        return None
    if isinstance(exc, dict):
        return str(exc.get("exception_type") or exc.get("type") or "exception")
    return str(exc)[:80]


def judge_precheck(agent: str, expected: list[str], run_dirs: list[str]) -> tuple[list[str], dict[str, Any]]:
    """→ (红项, 逐题观测)。**纯函数**（只读产物），单测覆盖各分支。

    ⚠️ 不走 `trial_outcomes.load_runs`：它的排除判据链（零调用 / 被外部 kill …）
    读的是 sid 适配器的 metadata，oracle / nop 根本没有这些键。这里只要 reward
    （与 nop 的 p2p）这两个 verifier 侧的事实，取数仍复用 `trial_outcomes` 的
    `trial_dirs` / `read_result` / `task_key`（同一判据认 trial、认题名）。
    """
    want = PRECHECK_EXPECT[agent]
    seen: dict[str, Any] = dict()
    for rd in run_dirs:
        for td in O.trial_dirs(rd):
            d = O.read_result(td) or dict()
            rewards = (d.get("verifier_result") or dict()).get("rewards") or dict()
            seen[O.task_key(td)] = {
                "reward": rewards.get("reward"),
                "p2p": rewards.get("p2p"),
                "exception": _exception_name(d),
            }
    red: list[str] = []
    missing = sorted(set(expected) - set(seen))
    extra = sorted(set(seen) - set(expected))
    if missing:
        red.append(f"{agent} 预检缺 {len(missing)} 题（没跑或没写 result.json）：{missing[:8]}")
    if extra:
        red.append(f"{agent} 预检多出计分集之外的 {len(extra)} 题：{extra[:8]}")
    bad: list[str] = []
    for t in sorted(set(expected) & set(seen)):
        s = seen[t]
        r = s["reward"]
        if s["exception"]:
            bad.append(f"{t}:异常 {s['exception']}")
        elif isinstance(r, bool) or not isinstance(r, (int, float)):
            bad.append(f"{t}:reward={r!r}")
        elif float(r) != want:
            bad.append(f"{t}:reward={r}")
        elif agent == "nop" and s["p2p"] is not None and s["p2p"] != 1.0:
            # nop 不改代码，P2P（本来就过的测试）必须全过；不过 = 环境本身坏了
            bad.append(f"{t}:p2p={s['p2p']}")
    if bad:
        red.append(f"{agent} 预检 {len(bad)}/{len(expected)} 题不符（期望 reward={want}）：{bad[:8]}")
    return red, seen


# ───────────────────────────────────────────── 子命令


def cmd_preflight(a, mod, ruler: Path, out: Path) -> int:
    head, red = check_ruler_state(ruler, a.expect_commit)
    binary = Path(a.binary).resolve()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            mod.bypass_loopback_proxy()
            gate_red, _ = mod.preflight(binary, Path(HERE).parents[2])
        red += list(gate_red)
    except Exception as exc:  # noqa: BLE001 —— 闸本身跑崩 = 没法证明环境是好的
        red.append(f"尺子跑前闸执行异常：{type(exc).__name__}: {exc}")
    tiers = {str(k): v for k, v in sorted(mod.tiers().items())}
    doc = {
        "ok": not red,
        "red": red,
        "head": head,
        "tiers": tiers,
        "scored": list(mod.scored_tasks()),
        "declared": {"traj_bench_commit": head, "network_policy": NETWORK_POLICY},
    }
    return emit(doc, EXIT_OK if not red else EXIT_RED)


def cmd_precheck(a, mod, ruler: Path, out: Path) -> int:
    head, red = check_ruler_state(ruler, a.expect_commit)
    if red:
        return emit({"ok": False, "red": red, "agent": a.agent}, EXIT_RED)
    jobs = out / "precheck" / a.agent
    jobs.mkdir(parents=True, exist_ok=True)
    mod.c.assert_jobs_dir_ok(jobs)
    with contextlib.redirect_stdout(sys.stderr):
        mod.bypass_loopback_proxy()
    cmd = precheck_cmd(mod, a.agent, jobs)
    rc, run_dir, log = run_harbor(cmd, jobs, dict(os.environ, HARBOR_TELEMETRY="0"))
    if run_dir is None:
        red.append(f"{a.agent} 预检：harbor 没有产出唯一的 run 目录（rc={rc}）—— 看 {log}")
        seen: dict[str, Any] = dict()
    else:
        r, seen = judge_precheck(a.agent, list(mod.scored_tasks()), [run_dir])
        red += r
    doc = {"ok": not red, "red": red, "agent": a.agent, "run_dir": run_dir, "log": str(log),
        "harbor_rc": rc, "n_seen": len(seen)}
    return emit(doc, EXIT_OK if not red else EXIT_RED)


def _cost_or_none(v: object) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def cmd_run(a, mod, ruler: Path, out: Path) -> int:
    head, red = check_ruler_state(ruler, a.expect_commit)
    if red:
        return emit({"ok": False, "red": red}, EXIT_RED)
    binary = Path(a.binary).resolve()
    with contextlib.redirect_stdout(sys.stderr):
        mod.bypass_loopback_proxy()
    env = adapter_env(mod, binary)
    declared = {"traj_bench_commit": head or "", "network_policy": NETWORK_POLICY}
    tiers_out: list[dict[str, Any]] = []
    costs: list[float | None] = []
    identities: set[tuple[object, object]] = set()
    for sec, tasks in sorted(mod.tiers().items()):
        ms = mod.DURATION_BY_TIMEOUT[sec]
        with contextlib.redirect_stdout(sys.stderr):
            path = mod.stage_tier(sec, tasks)
        jobs = out / "l2" / f"t{sec}"
        jobs.mkdir(parents=True, exist_ok=True)
        mod.c.assert_jobs_dir_ok(jobs)
        print(f"L2 t{sec}：{len(tasks)} 题，max_duration_ms={ms} …", file=sys.stderr, flush=True)
        rc, run_dir, log = run_harbor(mod.build_cmd(path, jobs, ms), jobs, env)
        entry: dict[str, Any] = {"tier": sec, "n_tasks": len(tasks), "run_dir": run_dir,
            "harbor_rc": rc, "log": str(log)}
        if run_dir is None:
            red.append(f"t{sec}：harbor 没有产出唯一的 run 目录（rc={rc}）—— 看 {log}")
        else:
            for td in O.trial_dirs(run_dir):
                d = O.read_result(td) or dict()
                costs.append(_cost_or_none((d.get("agent_result") or dict()).get("cost_usd")))
            fp = run_fingerprint.collect(run_dir, declared)
            f = fp.get("fields") or dict()
            identities.add((f.get("sid_binary_sha256"), f.get("sid_commit")))
            entry["n_trials"] = fp.get("n_trials")
        tiers_out.append(entry)
    doc = {
        "ok": not red,
        "red": red,
        "head": head,
        "declared": declared,
        "tiers": tiers_out,
        "run_dirs": [t["run_dir"] for t in tiers_out if t["run_dir"]],
        "costs": costs,
        # 容器里实际跑的二进制（适配器从产物字节读回）。release-gate 拿它与下载解出来的
        # 那份 sha256 比 —— 「跑的不是你以为的那份二进制」（evals/CLAUDE.md §3.1）。
        "binary_identities": sorted([list(x) for x in identities], key=str),
    }
    return emit(doc, EXIT_OK if not red else EXIT_RED)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="L2 发版闸的尺子桥（加载钉住 commit 的 traj-bench 跑批逻辑）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("preflight", "precheck", "run"):
        p = sub.add_parser(name)
        p.add_argument("--ruler", required=True, help="agent-traj-bench checkout（钉在基线 commit）")
        p.add_argument("--expect-commit", required=True, help="基线指纹里的 traj_bench_commit")
        p.add_argument("--out", required=True, help="本次 L2 的产物根（必须在 $HOME 下，colima 只挂它）")
        if name in ("preflight", "run"):
            p.add_argument("--binary", required=True, help="被测的 linux-arm64 二进制")
        if name == "precheck":
            p.add_argument("--agent", required=True, choices=sorted(PRECHECK_EXPECT))
    a = ap.parse_args(argv)
    ruler = Path(a.ruler).expanduser().resolve()
    out = Path(a.out).expanduser().resolve()
    try:
        mod = load_ruler(ruler, out)
    except RulerError as exc:
        return emit({"ok": False, "red": [str(exc)], "error": "ruler"}, EXIT_USAGE)
    handlers = {"preflight": cmd_preflight, "precheck": cmd_precheck, "run": cmd_run}
    try:
        return handlers[a.cmd](a, mod, ruler, out)
    except Exception as exc:  # noqa: BLE001 —— 任何崩溃都要落成一条结论，不能让调用方读空
        return emit({"ok": False, "red": [f"{a.cmd} 执行异常：{type(exc).__name__}: {exc}"],
            "error": "crash"}, EXIT_USAGE)


if __name__ == "__main__":
    sys.exit(main())
