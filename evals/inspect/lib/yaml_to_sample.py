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


def load_case_dataset(
    case_ids: list[str], evals_dir: Path, allow_holdout: bool = False
) -> list[Sample]:
    """按 case_id 列表加载,跨 p0-core / p1-common / p2-edge 目录搜寻。

    F-H3(2026-05-30 起):默认拒绝 holdout case_id —— 防止题面通过 inspect 路径泄露。
    holdout 评估必须显式 ``allow_holdout=True`` 调用,且仅限 m3-gate 等私有评测脚本。
    """
    samples = []
    # F-H3: 主搜索路径不含 holdout;命中 holdout/* 必须走 allow_holdout 显式开关
    search_dirs = ["p0-core", "p1-common", "p2-edge"]
    for case_id in case_ids:
        found = False
        # 1) 先扫公开池
        for bucket in search_dirs:
            p = evals_dir / bucket / f"{case_id}.yaml"
            if p.exists():
                samples.append(case_yaml_to_sample(p))
                found = True
                break
        if found:
            continue
        # 2) 再扫 holdout/*(含子目录如 holdout/architecture/);命中需开关
        for p in evals_dir.glob(f"holdout/**/{case_id}.yaml"):
            if not allow_holdout:
                raise ValueError(
                    f"holdout case '{case_id}' requires allow_holdout=True "
                    f"(F-H3 双重防御:防止 holdout 题面通过 inspect 路径泄露)"
                )
            # 防御 yaml 内 holdout: true 字段也校验一次
            with p.open("r", encoding="utf-8") as f:
                doc = yaml.safe_load(f)
            if doc.get("holdout") is True and not allow_holdout:
                raise ValueError(
                    f"case '{case_id}' has holdout: true but allow_holdout=False"
                )
            samples.append(case_yaml_to_sample(p))
            found = True
            break
        if not found:
            raise FileNotFoundError(f"case yaml 未找到: {case_id}")
    return samples
