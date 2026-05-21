"""sid_code_understanding.py — Inspect AI Task: sid-code 代码理解能力评测 spike。

目标:
  - 用 Inspect AI 端到端跑 1-2 条 case_001/002(P0 代码理解)
  - 验证 inspect view 浏览器 UI 体验
  - 不调用真实 sid-code CLI(spike 阶段直接用 Anthropic 模型回答 user_query)

用法:
  source ~/Code/person/trajectory-platform/backend/venv/bin/activate
  cd ~/Code/person/sid-code
  export ANTHROPIC_API_KEY=...
  inspect eval evals/inspect/tasks/sid_code_understanding.py --model anthropic/claude-haiku-4-5
  inspect view  # 启动浏览器 UI
"""

from __future__ import annotations

import sys
from pathlib import Path

from inspect_ai import Task, task
from inspect_ai.scorer import Score, Target, accuracy, scorer
from inspect_ai.solver import TaskState, generate, system_message

THIS_DIR = Path(__file__).resolve().parent
LIB_DIR = THIS_DIR.parent / "lib"
sys.path.insert(0, str(LIB_DIR))

from yaml_to_sample import load_case_dataset  # noqa: E402

EVALS_DIR = THIS_DIR.parent.parent
SPIKE_CASES = ["case_001", "case_002"]


@scorer(metrics=[accuracy()])
def must_include_any_scorer():
    """复用 case yaml 的 must_include_any_of 做锚点确定性断言。

    命中任意一项 → 1 分,全部未命中 → 0 分。
    Inspect 自带 includes() 但不支持 any_of 语义,自定义。
    """

    async def score(state: TaskState, target: Target) -> Score:
        keywords = state.metadata.get("must_include_any_of") or []
        forbids = state.metadata.get("must_not_include") or []
        answer = state.output.completion or ""

        hits = [k for k in keywords if k.lower() in answer.lower()]
        violations = [f for f in forbids if f.lower() in answer.lower()]

        if not hits:
            return Score(
                value=0,
                answer=answer,
                explanation=f"未命中任何关键词。期望: {keywords}",
                metadata={"hits": [], "violations": violations},
            )
        if violations:
            return Score(
                value=0,
                answer=answer,
                explanation=f"触发禁止词: {violations}",
                metadata={"hits": hits, "violations": violations},
            )
        return Score(
            value=1,
            answer=answer,
            explanation=f"命中关键词: {hits}",
            metadata={"hits": hits, "violations": violations, "n_hits": len(hits), "n_total": len(keywords)},
        )

    return score


@task
def sid_code_understanding():
    """sid-code 代码理解能力 spike(2 条 case)。"""
    samples = load_case_dataset(SPIKE_CASES, EVALS_DIR)
    return Task(
        dataset=samples,
        solver=[
            system_message(
                "你是 sid-code 项目的代码理解助手。回答时优先给出文件路径与类名，并简要解释职责。"
                "如果问题涉及代码定位,务必同时给出文件路径(相对项目根)和符号名(类名/函数名)。",
            ),
            generate(),
        ],
        scorer=must_include_any_scorer(),
    )
