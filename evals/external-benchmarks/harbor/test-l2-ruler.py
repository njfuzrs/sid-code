#!/usr/bin/env python3
"""`l2-ruler.py` 的行为单测：**假尺子仓 + 假 harbor**，只用 stdlib。

为什么必须有：尺子桥的每一个红项都是「不跑模型就判 INVALID」的那道防线，
坏掉的形态是「闸没拦，真钱花出去了」或「尺子换了，指纹照样声明成基线 commit」。

覆盖：
  ① 尺子接口不符（缺 REQUIRED 名字）→ 退出 1，结论行 error=ruler
  ② 尺子 HEAD ≠ 基线 commit → 红
  ③ 尺子已跟踪文件被改 → 红
  ④ precheck oracle 全 1 → 绿；一题 0 → 红；缺题 → 红；harbor 不产出目录 → 红
  ⑤ precheck nop 全 0 → 绿；nop p2p≠1 → 红
  ⑥ run：两档各跑一次 harbor，产物根在 --out 下、尺子仓不落文件，costs / 身份回传
  ⑦ run：PYTHONPATH 指向本 checkout 的适配器目录（不是尺子 t7 写死的主仓）
  ⑧ 闸I′：ELF 不是 arm64 → 红
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "l2-ruler.py")
PASS = 0
FAIL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name}  {detail}")


STUB = r'''
import json, os
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "reports" / "t15-baseline"
FP_DIR = OUT / "fingerprints"
DIST_TASKS = ROOT / "dist" / "v0.2.1" / "tasks"
N_CONCURRENT = 6
DURATION_BY_TIMEOUT = __DUR__
TIERS = __TIERS__

def tiers():
    return dict((k, list(v)) for k, v in TIERS.items())

def scored_tasks():
    return sorted(t for v in TIERS.values() for t in v)

def tier_dir(tier):
    return OUT / "stage" / f"t{tier}"

def stage_tier(tier, tasks, dist_tasks=DIST_TASKS):
    d = tier_dir(tier)
    d.mkdir(parents=True, exist_ok=True)
    for t in tasks:
        (d / t).mkdir(exist_ok=True)
    return d

def build_cmd(task_path, out, max_duration_ms):
    return ["harbor", "run", "-p", str(task_path), "-a", "sid_code_agent:SidCodeAgent",
        "-n", str(N_CONCURRENT), "-k", "1", "-o", str(out),
        "--ak", f"max_duration_ms={max_duration_ms}",
        "--verifier-timeout-multiplier", "6", "-y"]

def build_env(binary):
    env = dict(os.environ)
    env["PYTHONPATH"] = "/ruler/hardcoded/sid-code/harbor"
    env["SID_HARBOR_BINARY_ARM64"] = str(binary)
    return env

def elf_arch(binary):
    return Path(binary).read_text().strip() or None

def gate_binary(binary):
    return ["原闸I 不该被调用"], None

def preflight(binary, sid_repo):
    red = list(json.loads(os.environ.get("STUB_PREFLIGHT_RED", "[]")))
    r, _ = gate_binary(binary)
    return red + r, None

def bypass_loopback_proxy():
    pass

c = SimpleNamespace(assert_jobs_dir_ok=lambda p: Path(p))
'''

FAKE_HARBOR = r'''#!/usr/bin/env python3
import json, os, sys, time
a = sys.argv[1:]
def opt(flag):
    return a[a.index(flag) + 1] if flag in a else None
out, tasks_dir, agent = opt("-o"), opt("-p"), opt("-a")
mode = os.environ.get("FAKE_HARBOR_MODE", "ok")
log = os.environ.get("FAKE_HARBOR_LOG")
if log:
    with open(log, "a") as fh:
        fh.write(json.dumps(dict(argv=a, pythonpath=os.environ.get("PYTHONPATH"))) + "\n")
if mode == "nodir":
    sys.exit(0)
run = os.path.join(out, time.strftime("2026-11-07__%H-%M-%S") + f"-{os.getpid()}")
os.makedirs(run)
tasks = sorted(os.listdir(tasks_dir))
if mode == "drop_one":
    tasks = tasks[1:]
for i, t in enumerate(tasks):
    td = os.path.join(run, f"{t}__x{i}")
    os.makedirs(td)
    reward = 1.0 if agent == "oracle" else 0.0
    if mode == "one_bad" and i == 0:
        reward = 1.0 - reward
    p2p = 0.0 if (mode == "p2p_bad" and i == 0) else 1.0
    res = dict(verifier_result=dict(rewards=dict(reward=reward, p2p=p2p)), exception_info=None,
        agent_result=dict(cost_usd=0.25 if i else None, metadata=dict(sid_binary_sha256="b" * 64, sid_commit="c" * 40)))
    with open(os.path.join(td, "result.json"), "w") as fh:
        json.dump(res, fh)
'''


def git(repo: str, *args: str) -> str:
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, check=True)
    return r.stdout.strip()


def make_ruler(root: str, *, drop: str | None = None) -> tuple[str, str]:
    """→ (仓路径, HEAD)。`drop` = 从 stub 里删掉一个 REQUIRED 名字。"""
    repo = os.path.join(root, "ruler")
    os.makedirs(os.path.join(repo, "scripts"))
    tiers = dict([(1800, ["T0001", "T0002"]), (2700, ["T0003"])])
    src = STUB.replace("__DUR__", repr(dict([(1800, 4860000), (2700, 7290000)]))).replace("__TIERS__", repr(tiers))
    src = src.expandtabs(4)
    if drop:
        src = src.replace(f"def {drop}(", f"def _{drop}_gone(")
    with open(os.path.join(repo, "scripts", "t15-baseline.py"), "w") as fh:
        fh.write(src)
    for t in ["T0001", "T0002", "T0003"]:
        os.makedirs(os.path.join(repo, "dist", "v0.2.1", "tasks", t))
        with open(os.path.join(repo, "dist", "v0.2.1", "tasks", t, "task.toml"), "w") as fh:
            fh.write("x=1\n")
    subprocess.run(["git", "init", "-q", repo], check=True)
    git(repo, "add", "scripts")
    git(repo, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "ruler")
    return repo, git(repo, "rev-parse", "HEAD")


def make_bin_dir(root: str) -> str:
    d = os.path.join(root, "bin")
    os.makedirs(d)
    p = os.path.join(d, "harbor")
    with open(p, "w") as fh:
        fh.write(FAKE_HARBOR.expandtabs(4))
    os.chmod(p, 0o755)
    return d


def bridge(args: list[str], env_extra: dict[str, str] | None = None) -> tuple[int, dict, str]:
    env = dict(os.environ)
    env.update(env_extra or dict())
    r = subprocess.run([sys.executable, BRIDGE, *args], capture_output=True, text=True, env=env)
    lines = [x for x in r.stdout.splitlines() if x.startswith("L2RULER_JSON ")]
    doc = json.loads(lines[-1][len("L2RULER_JSON "):]) if lines else dict()
    return r.returncode, doc, r.stdout + r.stderr


def load_bridge():
    spec = importlib.util.spec_from_file_location("l2_ruler", BRIDGE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    root = tempfile.mkdtemp(prefix="l2-ruler-test-")
    try:
        run_tests(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print(f"\n{PASS} 通过 / {FAIL} 失败")
    return 0 if FAIL == 0 else 1


def run_tests(root: str) -> None:
    bindir = make_bin_dir(root)
    path_env = dict(PATH=bindir + os.pathsep + os.environ.get("PATH", ""))
    binary = os.path.join(root, "sid-code")
    with open(binary, "w") as fh:
        fh.write("arm64\n")

    print("① 尺子接口不符")
    r1 = os.path.join(root, "r1")
    os.makedirs(r1)
    repo1, head1 = make_ruler(r1, drop="build_cmd")
    rc, doc, log = bridge(["preflight", "--ruler", repo1, "--expect-commit", head1, "--out", os.path.join(root, "o1"), "--binary", binary])
    check("缺 build_cmd → 退出 1", rc == 1, f"rc={rc} {log[-300:]}")
    check("结论行 error=ruler 且点名 build_cmd", doc.get("error") == "ruler" and "build_cmd" in json.dumps(doc, ensure_ascii=False), str(doc))

    r2 = os.path.join(root, "r2")
    os.makedirs(r2)
    repo, head = make_ruler(r2)

    print("② / ③ 尺子 commit 与改动")
    rc, doc, log = bridge(["preflight", "--ruler", repo, "--expect-commit", "0" * 40, "--out", os.path.join(root, "o2"), "--binary", binary])
    check("HEAD ≠ 基线 commit → 退出 2", rc == 2, f"rc={rc} {log[-300:]}")
    check("红项点名 traj_bench_commit", any("traj_bench_commit" in x for x in doc.get("red", [])), str(doc))
    rc, doc, _ = bridge(["preflight", "--ruler", repo, "--expect-commit", head, "--out", os.path.join(root, "o2b"), "--binary", binary])
    check("尺子正确 + 闸全绿 → 退出 0", rc == 0 and doc.get("ok") is True, str(doc))
    check("preflight 回传分档与计分集", doc.get("tiers") == dict([("1800", ["T0001", "T0002"]), ("2700", ["T0003"])]) and doc.get("scored") == ["T0001", "T0002", "T0003"], str(doc))
    check("declared 带尺子 HEAD", (doc.get("declared") or dict()).get("traj_bench_commit") == head, str(doc))
    rc, doc, _ = bridge(["preflight", "--ruler", repo, "--expect-commit", head, "--out", os.path.join(root, "o2c"), "--binary", binary],
        dict(STUB_PREFLIGHT_RED=json.dumps(["闸E 网络策略不对"])))
    check("尺子自己的闸报红 → 退出 2 且原样透传", rc == 2 and "闸E 网络策略不对" in doc.get("red", []), str(doc))
    with open(os.path.join(repo, "scripts", "t15-baseline.py"), "a") as fh:
        fh.write("\n# 被人改了\n")
    rc, doc, _ = bridge(["preflight", "--ruler", repo, "--expect-commit", head, "--out", os.path.join(root, "o3"), "--binary", binary])
    check("已跟踪文件被改 → 退出 2", rc == 2 and any("已跟踪文件有改动" in x for x in doc.get("red", [])), str(doc))
    git(repo, "checkout", "--", "scripts/t15-baseline.py")

    print("⑧ 闸I′ ELF 架构")
    x64 = os.path.join(root, "sid-code-x64")
    with open(x64, "w") as fh:
        fh.write("x64\n")
    rc, doc, _ = bridge(["preflight", "--ruler", repo, "--expect-commit", head, "--out", os.path.join(root, "o8"), "--binary", x64])
    check("x64 二进制 → 红，且原闸I 没被调用", rc == 2 and any("ELF 架构 x64" in x for x in doc.get("red", [])) and not any("原闸I" in x for x in doc.get("red", [])), str(doc))

    print("④ / ⑤ oracle / nop 预检（经假 harbor）")
    cases = [
        ("oracle", "ok", 0), ("oracle", "one_bad", 2), ("oracle", "drop_one", 2), ("oracle", "nodir", 2),
        ("nop", "ok", 0), ("nop", "p2p_bad", 2), ("nop", "one_bad", 2),
    ]
    for agent, mode, want in cases:
        out = os.path.join(root, f"pc-{agent}-{mode}")
        env = dict(path_env, FAKE_HARBOR_MODE=mode)
        rc, doc, log = bridge(["precheck", "--ruler", repo, "--expect-commit", head, "--out", out, "--agent", agent], env)
        check(f"{agent} / {mode} → 退出 {want}", rc == want, f"rc={rc} doc={doc} {log[-300:]}")

    print("⑥ / ⑦ run 两档")
    out = os.path.join(root, "run-ok")
    hlog = os.path.join(root, "harbor-calls.jsonl")
    env = dict(path_env, FAKE_HARBOR_MODE="ok", FAKE_HARBOR_LOG=hlog)
    rc, doc, log = bridge(["run", "--ruler", repo, "--expect-commit", head, "--out", out, "--binary", binary], env)
    check("run → 退出 0", rc == 0, f"rc={rc} {log[-400:]}")
    check("两档各一个 run 目录，都在 --out 下", len(doc.get("run_dirs", [])) == 2 and all(d.startswith(os.path.realpath(out)) for d in doc["run_dirs"]), str(doc.get("run_dirs")))
    check("costs 逐 trial 回传，缺成本记 null（不是 0）", sorted(doc.get("costs", []), key=lambda v: -1 if v is None else v) == [None, None, 0.25], str(doc.get("costs")))
    check("容器内二进制身份回传", doc.get("binary_identities") == [["b" * 64, "c" * 40]], str(doc.get("binary_identities")))
    check("尺子仓没有落任何产物", not os.path.exists(os.path.join(repo, "reports")), "reports/ 出现在尺子仓里")
    calls = [json.loads(x) for x in open(hlog)] if os.path.exists(hlog) else []
    check("harbor 被调两次，max_duration_ms 分别是两档的值", sorted(next(v for v in c["argv"] if v.startswith("max_duration_ms=")) for c in calls) == ["max_duration_ms=4860000", "max_duration_ms=7290000"], str(calls))
    check("PYTHONPATH 指向本 checkout 的适配器目录", calls and all(c["pythonpath"] == HERE for c in calls), str([c["pythonpath"] for c in calls]))
    rc, doc, _ = bridge(["run", "--ruler", repo, "--expect-commit", head, "--out", os.path.join(root, "run-nodir"), "--binary", binary], dict(path_env, FAKE_HARBOR_MODE="nodir"))
    check("harbor 不产出目录 → 退出 2", rc == 2 and len(doc.get("red", [])) == 2, str(doc))

    print("纯函数 judge_precheck")
    m = load_bridge()
    red, _ = m.judge_precheck("oracle", ["T1"], [])
    check("零产物 → 红（空集不当通过）", bool(red), str(red))


if __name__ == "__main__":
    sys.exit(main())
