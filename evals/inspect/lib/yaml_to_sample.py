"""yaml_to_sample.py — 把 sid-code 现有 case yaml 转成 Inspect Sample。

不改动任何现有 case yaml。仅做字段映射:
  - input.user_query     → Sample.input
  - expected.must_include_any_of → Sample.target(用 \\n 拼接,供 includes() scorer 命中)
  - id / priority / category / expected.* → Sample.metadata
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from inspect_ai.dataset import Sample


def case_yaml_to_sample(case_path: Path) -> Sample:
    with case_path.open("r", encoding="utf-8") as f:
        doc: dict[str, Any] = yaml.safe_load(f)

    user_query = doc.get("input", {}).get("user_query", "")
    must_include = doc.get("expected", {}).get("must_include_any_of", []) or []
    must_not = doc.get("expected", {}).get("must_not_include", []) or []
    reference_answer = doc.get("expected", {}).get("reference_answer", "")

    target = "\n".join(str(x) for x in must_include) if must_include else reference_answer

    metadata = {
        "case_id": doc.get("id", case_path.stem),
        "priority": doc.get("priority", "?"),
        "category": doc.get("category", "?"),
        "must_include_any_of": must_include,
        "must_not_include": must_not,
        "reference_answer": reference_answer,
        "rubric": doc.get("rubric", {}),
        "max_steps": doc.get("expected", {}).get("max_steps"),
        "source_path": str(case_path),
    }

    return Sample(input=user_query, target=target, metadata=metadata, id=doc.get("id", case_path.stem))


def load_case_dataset(case_ids: list[str], evals_dir: Path) -> list[Sample]:
    """按 case_id 列表加载,跨 p0-core / p1-common / p2-edge 目录搜寻。"""
    samples = []
    search_dirs = ["p0-core", "p1-common", "p2-edge", "holdout"]
    for case_id in case_ids:
        found = False
        for bucket in search_dirs:
            p = evals_dir / bucket / f"{case_id}.yaml"
            if p.exists():
                samples.append(case_yaml_to_sample(p))
                found = True
                break
        if not found:
            raise FileNotFoundError(f"case yaml 未找到: {case_id}")
    return samples
