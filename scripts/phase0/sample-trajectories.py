#!/usr/bin/env python3
"""
W1.D2 第一步：从 trajectory-platform 的 2441 条 session 里随机抽 50 条，
人工读 trajectory[0]（用户首条 message），挑出 instruction 清晰的（约 50% 命中率）
作为"真实使用类" case 候选。

来源：docs/eval/00-总方案.md §3.2 + 07-执行顺序速查.md §2.2

用法：
    source /Users/dev/Code/person/trajectory-platform/backend/venv/bin/activate
    python3 scripts/phase0/sample-trajectories.py
输出：
    evals/sample-50.txt          人类阅读用列表（含 model / steps / 首条用户 query 摘要）
    evals/sample-50.jsonl        机器消费用 jsonl（含 session_id / model / 完整 user_query）

注意：
    - sid-code Day 0 抽样发现存在空 session（model=null / steps=0）→ 抽样前先过滤
    - 短 ID 目录（8 字符）和完整 UUID 目录都要兼容
    - 固定随机种子 42 保证 sample 可复现（跑两次抽到同样的 50 条）
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path
from typing import Any, Optional

# ---- 配置 ----
PULLED_DIR = Path("/Users/dev/Code/person/trajectory-platform/data/pulled_sessions")
OUT_DIR = Path(__file__).resolve().parents[2] / "evals"
SEED = 42
SAMPLE_SIZE = 50
MAX_QUERY_PREVIEW = 200  # 列表里展示的 user_query 截断长度


def extract_first_user_query(metadata: dict, traj: list[dict], history: list[dict]) -> Optional[str]:
    """优先从 metadata.user_prompts[0] 取真实用户输入；兜底从 history/trajectory 找第一条 user 文本。

    注意：trajectory[].role=user 经常是 tool_result / system_reminder 包裹，不是真实用户 query。
    metadata.user_prompts 是 sid-code/Claude Code 落盘时显式记录的"用户键入的 prompt"，最干净。
    """
    # 1. 优先 metadata.user_prompts[0]
    ups = metadata.get("user_prompts") or []
    if isinstance(ups, list) and ups:
        first = ups[0]
        if isinstance(first, str) and first.strip():
            return first.strip()
        if isinstance(first, dict):
            text = first.get("text") or first.get("content") or first.get("prompt")
            if isinstance(text, str) and text.strip():
                return text.strip()

    # 2. 兜底：history 中第一条 role=user 的纯文本（且不是 tool_result/system_reminder）
    for h in history:
        if h.get("role") != "user":
            continue
        content = h.get("content")
        if isinstance(content, str) and content.strip():
            s = content.strip()
            # 过滤明显的非用户输入
            if s.startswith("<system-reminder") or s.startswith("[tool_result") or s.startswith("Tool: "):
                continue
            return s
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    text = part.get("text")
                    if isinstance(text, str) and text.strip():
                        return text.strip()

    # 3. 最后兜底 trajectory[]
    for step in traj:
        if step.get("role") != "user":
            continue
        content = step.get("content")
        if isinstance(content, str) and content.strip():
            s = content.strip()
            if s.startswith("<system-reminder") or s.startswith("[tool_result") or "tool_result" in s[:50].lower():
                continue
            return s
    return None


def load_session(session_dir: Path) -> Optional[dict[str, Any]]:
    """加载 session.traj，过滤掉空 session 和 schema 异常。"""
    traj_file = session_dir / "session.traj"
    if not traj_file.is_file():
        return None
    try:
        with traj_file.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None

    md = data.get("metadata") or {}
    traj = data.get("trajectory") or []
    history = data.get("history") or []

    # 过滤空 session（Day 0 发现的边界）
    if md.get("total_steps", 0) == 0 and len(traj) == 0 and len(history) == 0:
        return None

    user_query = extract_first_user_query(md, traj, history)
    user_prompts_count = len(md.get("user_prompts") or [])

    return {
        "session_id": md.get("session_id") or session_dir.name,
        "session_dir": str(session_dir),
        "model": md.get("model") or "unknown",
        "total_steps": md.get("total_steps", 0),
        "exit_status": md.get("exit_status") or "",
        "tools_used": md.get("tools_used") or [],
        "files_edited": md.get("files_edited") or [],
        "has_thinking": md.get("has_thinking", False),
        "trajectory_len": len(traj),
        "history_len": len(history),
        "user_prompts_count": user_prompts_count,
        "user_query": user_query,
        "tokens_sent": md.get("total_tokens_sent", 0),
        "total_cost_usd": md.get("total_cost_usd", 0),
    }


def main() -> int:
    if not PULLED_DIR.is_dir():
        print(f"[ERROR] PULLED_DIR not found: {PULLED_DIR}", file=sys.stderr)
        return 1

    # 列举所有候选 session 目录（既要 UUID 也要短 ID）
    all_dirs = sorted(p for p in PULLED_DIR.iterdir() if p.is_dir())
    print(f"[INFO] 总目录数: {len(all_dirs)}")

    # 加载并过滤
    valid: list[dict[str, Any]] = []
    skipped_empty = 0
    skipped_schema = 0
    for d in all_dirs:
        rec = load_session(d)
        if rec is None:
            if (d / "session.traj").is_file():
                skipped_empty += 1
            else:
                skipped_schema += 1
            continue
        valid.append(rec)

    print(f"[INFO] 有效 session: {len(valid)}")
    print(f"[INFO] 跳过空 session: {skipped_empty}")
    print(f"[INFO] 跳过缺 session.traj: {skipped_schema}")

    # 进一步过滤：
    #   1. 必须有 user_prompts 字段（明确的用户键入）— 比从 history/trajectory 反推干净得多
    #   2. user_query 长度 50-3000 字符（太短无意义；太长大概率是文件内容粘贴）
    #   3. steps >= 1（真有 LLM 响应）
    def is_clean_query(rec: dict[str, Any]) -> bool:
        if rec.get("user_prompts_count", 0) == 0:
            return False
        q = rec.get("user_query") or ""
        if len(q) < 30 or len(q) > 3000:
            return False
        if rec.get("total_steps", 0) < 1:
            return False
        # 排除明显的 study/research 笔记类（他们是 study-topic 命令的输入）
        if q.startswith("/study") or q.startswith("/qa "):
            return False
        return True

    candidates = [r for r in valid if is_clean_query(r)]
    print(f"[INFO] 含 user_prompts 且 query 长度合理的 session: {len(candidates)}")

    rng = random.Random(SEED)
    sample = rng.sample(candidates, min(SAMPLE_SIZE, len(candidates)))

    # 输出 jsonl
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    jsonl_path = OUT_DIR / "sample-50.jsonl"
    with jsonl_path.open("w", encoding="utf-8") as f:
        for rec in sample:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    # 输出人类可读 txt
    txt_path = OUT_DIR / "sample-50.txt"
    with txt_path.open("w", encoding="utf-8") as f:
        f.write(f"# W1.D2 抽样 50 条 trajectory（seed={SEED}）\n\n")
        f.write(f"总目录: {len(all_dirs)} | 有效: {len(valid)} | 干净候选: {len(candidates)}\n\n")
        f.write("人工挑选标准（00 §3.2 Step 2）：\n")
        f.write("  ✅ instruction 清晰，能改写为单段独立任务描述\n")
        f.write("  ✅ 触发 sid-code 6 个工具至少一个\n")
        f.write("  ✅ 真实场景里高频遇到的（不是 toy 例子）\n")
        f.write("  ❌ 纯文本问答（'今天天气怎么样'）\n")
        f.write("  ❌ 上下文跨多轮才能理解（W2 Phase 1 处理）\n\n")
        f.write("挑出 17-18 条作为'真实使用类' case 来源；标 ✅/❌ 在每条前。\n")
        f.write("=" * 80 + "\n\n")
        for i, rec in enumerate(sample, 1):
            uq = rec.get("user_query") or "(empty)"
            uq_one_line = uq.replace("\n", " ").strip()
            preview = uq_one_line[:MAX_QUERY_PREVIEW] + ("…" if len(uq_one_line) > MAX_QUERY_PREVIEW else "")
            f.write(f"[{i:02d}] [ ] session={rec['session_id'][:8]} model={rec['model']} "
                    f"steps={rec['total_steps']} exit={rec['exit_status']!r} "
                    f"tools={rec['tools_used'][:5]}\n")
            f.write(f"     query: {preview}\n\n")

    print(f"[OK] 写入 {jsonl_path}")
    print(f"[OK] 写入 {txt_path}")
    print()
    print(f"下一步：人工阅读 {txt_path}，挑 17-18 条标 ✅，作为 case_001~case_018 来源。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
