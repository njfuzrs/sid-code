#!/usr/bin/env python3
"""W1.D3 验证：扫所有 case 的 must_include_any_of 关键词在 sid-code 仓库里 grep 命中。

来源：00 §3.3 避坑 2 + methodology §9.1 反 2（code-graph case_001 教训）。

用法：python3 scripts/phase0/grep-verify-cases.py
退出码：全部命中 = 0；任意命中数 = 0 = 1。
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
CASE_DIRS = ["evals/p0-core", "evals/p1-common", "evals/p2-edge"]
SKIP_KEYWORDS = {
    # 通用动词/名词,grep 全仓必命中,无验证价值
    "Provider", "Tool", "Command", "Checker", "TODO", "FIXME",
    # case 自然语言期望（不是源码 token）
    "不存在", "未找到", "no such file", "找不到", "doesn't exist", "not found",
    "无法", "不能", "拒绝", "敏感", "需要明确", "更好", "不清楚",
    "环境变量",
}


def grep_count(keyword: str) -> int:
    """grep -r 在 sid-code 仓内计数（排除 evals/ docs/ node_modules/ .git/）。"""
    try:
        # ripgrep 优先
        proc = subprocess.run(
            ["rg", "-c", "--no-heading", "-F",
             "--glob", "!evals/**", "--glob", "!docs/**",
             "--glob", "!node_modules/**", "--glob", "!.git/**",
             keyword, str(ROOT)],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode in (0, 1):
            return sum(int(line.split(":")[-1]) for line in proc.stdout.splitlines() if ":" in line)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    proc = subprocess.run(
        ["grep", "-rF", "--include=*.ts", "--include=*.json", "--include=*.md",
         "--exclude-dir=node_modules", "--exclude-dir=.git",
         "--exclude-dir=evals", "--exclude-dir=docs",
         keyword, str(ROOT)],
        capture_output=True, text=True, timeout=30,
    )
    return len(proc.stdout.splitlines()) if proc.returncode in (0, 1) else 0


def main() -> int:
    case_files: list[Path] = []
    for d in CASE_DIRS:
        case_files.extend(sorted((ROOT / d).glob("case_*.yaml")))

    print(f"[INFO] 扫描 {len(case_files)} 条 case")
    print("=" * 80)

    all_ok = True
    for case_file in case_files:
        with case_file.open("r", encoding="utf-8") as f:
            data = yaml.safe_load(f)

        cid = data.get("id", case_file.stem)
        kws = (data.get("expected") or {}).get("must_include_any_of") or []
        if not kws:
            print(f"[WARN] {cid}: must_include_any_of 为空")
            continue

        hits = []
        misses = []
        skipped = []
        for kw in kws:
            if kw in SKIP_KEYWORDS:
                skipped.append(kw)
                continue
            cnt = grep_count(kw)
            if cnt > 0:
                hits.append(f"{kw}({cnt})")
            else:
                misses.append(kw)

        # case 至少要有一个非 SKIP 关键词命中（其他关键词允许是自然语言期望）
        meaningful = hits + misses
        if not meaningful:
            print(f"[OK]   {cid}: 全部为通用关键词,跳过 grep（人工已确认）")
            continue

        if hits:
            print(f"[OK]   {cid}: ✅ {len(hits)}/{len(meaningful)} 命中  hits={hits}  misses={misses}")
        else:
            all_ok = False
            print(f"[FAIL] {cid}: ❌ 0/{len(meaningful)} 命中  misses={misses}  请检查关键词或路径")

    print("=" * 80)
    if all_ok:
        print("[OK] 25 条全部 grep 验证通过")
        return 0
    print("[FAIL] 存在未命中的 case,需修订关键词或调整 case")
    return 1


if __name__ == "__main__":
    sys.exit(main())
