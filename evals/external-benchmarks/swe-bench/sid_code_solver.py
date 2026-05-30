"""sid_code_solver.py — Inspect AI custom solver：把 SWE-bench instance 喂给 sid-code CLI。

> 状态：骨架（B8-1），待 S8 实施时跑通端到端
> 关联：evals/external-benchmarks/swe-bench/接入计划.md §4

用法（S8 实施者）:
  source ~/Code/person/trajectory-platform/backend/venv/bin/activate
  cd ~/Code/person/sid-code
  export ANTHROPIC_API_KEY=...
  inspect eval evals/external-benchmarks/swe-bench/sid_code_solver.py:swe_bench_sid_code \
    --model anthropic/claude-sonnet-4-6 --limit 1

设计要点:
  1. 复用 inspect_evals.swe_bench dataset（不重写 instance loader）
  2. solver 内部 subprocess 调 sid-code 无头入口（src/entrypoints/bootstrap.ts）
  3. 每条 instance 在独立 worktree 内执行，避免污染主仓
  4. 结果通过 Inspect EvalLog 落盘，runner.ts 二次汇总

数据隔离铁律（CLAUDE.md §0.4 + §9.3）:
  - 不写自家 baseline_scores
  - 输出独立到 _reports/external/inspect-{date}.md
  - SWE-bench instance 任何 patch / FAIL_TO_PASS 内容都不可流入自家 case yaml
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

import yaml
from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.scorer import Score, Target, accuracy, scorer
from inspect_ai.solver import Generate, Solver, TaskState, solver

THIS_DIR = Path(__file__).resolve().parent
SUBSET_YAML = THIS_DIR / "verified-subset.yaml"
SID_CODE_ROOT = THIS_DIR.parent.parent.parent  # /Users/dev/Code/person/sid-code
SID_CODE_BOOTSTRAP = SID_CODE_ROOT / "src" / "entrypoints" / "bootstrap.ts"


def load_subset() -> list[dict]:
    """加载 B8-2 精挑的 10 条 instance_id。"""
    if not SUBSET_YAML.exists():
        raise FileNotFoundError(
            f"verified-subset.yaml 未生成,先跑 B8-2 精挑流程: {SUBSET_YAML}"
        )
    data = yaml.safe_load(SUBSET_YAML.read_text(encoding="utf-8"))
    instances = data.get("instances") or []
    if not instances:
        raise ValueError("verified-subset.yaml 未配置 instances 字段")
    return instances


def instance_to_sample(inst: dict) -> Sample:
    """把 SWE-bench instance 转成 Inspect Sample。"""
    return Sample(
        id=inst["instance_id"],
        input=inst["problem_statement"],
        target="",  # SWE-bench 用 FAIL_TO_PASS 测试代替 target 字符串
        metadata={
            "repo": inst["repo"],
            "base_commit": inst["base_commit"],
            "fail_to_pass": inst.get("FAIL_TO_PASS") or [],
            "pass_to_pass": inst.get("PASS_TO_PASS") or [],
            "difficulty": inst.get("difficulty"),
            "selection_reason": inst.get("selection_reason"),
        },
    )


def run_sid_code_subprocess(
    user_query: str,
    workdir: Path,
    timeout: int = 1800,
) -> dict:
    """spawn sid-code 无头入口跑一条 instance。

    返回:
      {
        "completion": "agent 最终输出",
        "trace_path": "/tmp/.../trace.jsonl",
        "exit_code": 0,
        "duration_s": 123.4,
        "error": "" | "..."
      }

    实施提示（S8 实施者）:
      - sid-code 已有 sid-code-live wrapper(`evals/providers/sid-code-live.ts`),
        但 inspect 的 solver 必须用 Python,所以这里改 subprocess 调 bun
      - bootstrap.ts 是评估模式无头入口(CLAUDE.md §0.4 已注明)
      - 实际跑通时还需要传 --workdir / --no-tui / --trace-out 等参数,见 bootstrap.ts
    """
    # ⚠ 骨架占位:S8 实施者据 bootstrap.ts 实际签名调整
    cmd = [
        "bun",
        "run",
        str(SID_CODE_BOOTSTRAP),
        "--user-query",
        user_query,
        "--workdir",
        str(workdir),
        "--headless",
        "--trace-out",
        str(workdir / "trace.jsonl"),
    ]

    try:
        proc = subprocess.run(
            cmd,
            cwd=str(SID_CODE_ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "SID_CODE_HEADLESS": "1"},
        )
        completion = proc.stdout.strip()
        return {
            "completion": completion,
            "trace_path": str(workdir / "trace.jsonl"),
            "exit_code": proc.returncode,
            "duration_s": 0.0,  # TODO: 从 trace.jsonl 解析
            "error": proc.stderr if proc.returncode != 0 else "",
        }
    except subprocess.TimeoutExpired:
        return {
            "completion": "",
            "trace_path": "",
            "exit_code": -1,
            "duration_s": float(timeout),
            "error": f"sid-code subprocess timeout after {timeout}s",
        }


@solver
def sid_code_solver_impl() -> Solver:
    """custom solver：每条 instance 起独立 worktree 跑 sid-code。

    步骤:
      1. mkdtemp 起独立 worktree
      2. git clone {repo} + checkout {base_commit}（实施者据 instance 元数据补完）
      3. 调 run_sid_code_subprocess 跑 sid-code
      4. 把 completion / trace_path 写入 state.metadata
      5. 让 inspect_evals.swe_bench 内置 scorer 跑 FAIL_TO_PASS 测试
    """

    async def solve(state: TaskState, _generate: Generate) -> TaskState:
        meta = state.metadata or {}
        # repo / base_commit 在 S8 实施者补 git clone 时使用,这里先放进 metadata 留痕
        _repo = meta.get("repo")
        _base_commit = meta.get("base_commit")

        with tempfile.TemporaryDirectory(prefix="swe-bench-") as tmp:
            workdir = Path(tmp)

            # ⚠ 骨架占位:S8 实施者补 git clone / checkout（建议复用 inspect_evals 的 setup）
            # subprocess.run(["git", "clone", f"https://github.com/{_repo}.git", str(workdir)], check=True)
            # subprocess.run(["git", "-C", str(workdir), "checkout", _base_commit], check=True)

            user_query = state.input_text or ""
            result = run_sid_code_subprocess(user_query, workdir)

            state.output.completion = result["completion"]
            state.metadata = {
                **meta,
                "sid_code_trace_path": result["trace_path"],
                "sid_code_exit_code": result["exit_code"],
                "sid_code_duration_s": result["duration_s"],
                "sid_code_error": result["error"],
                "workdir": str(workdir),
            }

        return state

    return solve


@scorer(metrics=[accuracy()])
def fail_to_pass_scorer():
    """SWE-bench 风格 scorer：跑 FAIL_TO_PASS 测试,全过 → 1,否则 → 0。

    ⚠ 骨架占位:S8 实施者按 inspect_evals.swe_bench 内置 scorer 适配
    （建议直接复用 inspect_evals.swe_bench.scorer，不要重复造轮）。
    """

    async def score(state: TaskState, target: Target) -> Score:
        meta = state.metadata or {}
        exit_code = meta.get("sid_code_exit_code", -1)

        if exit_code != 0:
            return Score(
                value=0,
                explanation=f"sid-code subprocess 失败: exit={exit_code}",
            )

        # ⚠ 骨架:实际应该 cd workdir → pytest fail_to_pass + pass_to_pass
        return Score(
            value=0,  # 默认 0,等 S8 实施者接 inspect_evals.swe_bench scorer
            explanation="骨架占位,等 S8 实施者接 inspect_evals.swe_bench scorer",
        )

    return score


@task
def swe_bench_sid_code() -> Task:
    """SWE-bench Verified subset 10 条,跑 sid-code custom solver。"""
    instances = load_subset()
    samples = [instance_to_sample(inst) for inst in instances]

    return Task(
        dataset=samples,
        solver=sid_code_solver_impl(),
        scorer=fail_to_pass_scorer(),
        # 实施提示:Inspect 自带 sandbox=docker,可参考 inspect_evals.swe_bench 的 sandbox 配置
    )


if __name__ == "__main__":
    # 本地 smoke 检查（不调真实模型）
    insts = load_subset()
    print(f"[swe-bench/sid_code_solver] 加载 {len(insts)} 条 instance:")
    for inst in insts:
        print(f"  - {inst['instance_id']}  ({inst.get('difficulty', '?')})")
