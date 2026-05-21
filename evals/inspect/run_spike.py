"""run_spike.py — 直接用 Python API 跑 spike,绕过 inspect CLI 的 TUI 渲染问题。

用法:
  source ~/Code/person/trajectory-platform/backend/venv/bin/activate
  cd ~/Code/person/sid-code
  python evals/inspect/run_spike.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "tasks"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))

from inspect_ai import eval as inspect_eval
from sid_code_understanding import sid_code_understanding


def main():
    log_dir = Path(__file__).resolve().parent / "logs"
    log_dir.mkdir(exist_ok=True)

    print(f"[spike] base url: {os.environ.get('ANTHROPIC_BASE_URL', '(default)')}")
    print(f"[spike] log dir:  {log_dir}")
    print("[spike] running 2 cases (case_001 + case_002) ...")

    logs = inspect_eval(
        sid_code_understanding(),
        model="anthropic/claude-sonnet-4-6",
        log_dir=str(log_dir),
        display="plain",
    )

    print("\n=== 结果摘要 ===")
    for log in logs:
        print(f"\nTask: {log.eval.task}")
        print(f"  Model: {log.eval.model}")
        print(f"  Status: {log.status}")
        if log.results:
            print(f"  Total samples: {log.results.total_samples}")
            print(f"  Completed:     {log.results.completed_samples}")
            for s in log.results.scores or []:
                print(f"  Scorer: {s.name}")
                for m_name, m in (s.metrics or {}).items():
                    print(f"    {m_name}: {m.value}")
        if log.samples:
            print("\n  按 case 拆分:")
            for sample in log.samples:
                score_obj = sample.scores.get("must_include_any_scorer") if sample.scores else None
                score_val = score_obj.value if score_obj else "—"
                explanation = score_obj.explanation if score_obj else ""
                print(f"    {sample.id}: score={score_val}  {explanation}")
                output_text = sample.output.completion if sample.output else ""
                preview = (output_text[:120] + "...") if len(output_text) > 120 else output_text
                print(f"      output preview: {preview}")
        print(f"\n  log file: {log.location}")


if __name__ == "__main__":
    main()
