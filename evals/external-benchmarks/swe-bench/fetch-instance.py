#!/usr/bin/env python3
"""
SWE-bench 阶段 A 第 2 步 —— 从 dataset **现取** instance 字段。

事实源：`接入计划.md` §4.2（`base_commit` / `problem_statement` 从 dataset 现取，
不落在 yaml 里）。

## 为什么题面不入库（这是 §4.2 的核心约束，不是省事）

`problem_statement` 落进 `verified-subset.yaml` 会带来两个问题：
  1. 它是**题面**，和 `patch` / `FAIL_TO_PASS` 同属「不该在我们仓库里定居」的东西
     —— §3 数据隔离那条「外部答案不可流入自家 case yaml」的邻居；
  2. 更实际的是**它会漂移**：dataset 换 revision 时题面可能改，
     入库的副本不会跟着改，于是我们喂给 agent 的题面与官方判分依据的那份
     **不是同一个东西**，而这件事不会报错。

所以：yaml 里只留 `instance_id` 这个 key，其余一切现取。

## 输出

一行 JSON（给 runner.ts 消费），只含 runner 真正需要的字段：

    {"instance_id": "...", "base_commit": "...", "problem_statement": "...",
     "repo": "...", "version": "...", "environment_setup_commit": "..."}

⚠️ **刻意不输出 `patch` / `test_patch` / `FAIL_TO_PASS` / `PASS_TO_PASS`**。
那是答案。多输出一个字段，就多一条它被 log、被 cp 进容器、被 agent 读到的路径 ——
而「答案在容器里」正是 §4.1 ③ 那条断言要防的东西。

## 用法

    .venv/bin/python fetch-instance.py <instance_id>          # 一条
    .venv/bin/python fetch-instance.py --validate a b c ...    # 只校验存在性
"""

from __future__ import annotations

import argparse
import json
import sys

DATASET = "SWE-bench/SWE-bench_Verified"
SPLIT = "test"

# 允许出库的字段白名单。**用白名单而不是黑名单**：
# dataset 加了新字段时，白名单的默认行为是「不输出」（安全），
# 黑名单的默认行为是「输出」—— 那意味着上游加一个 `solution_hint`
# 之类的字段，我们会在毫无察觉的情况下把它喂给 agent。
SAFE_FIELDS = (
    "instance_id",
    "repo",
    "base_commit",
    "environment_setup_commit",
    "version",
    "problem_statement",
)


def load_records() -> dict:
    from datasets import load_dataset

    ds = load_dataset(DATASET, split=SPLIT)
    return {r["instance_id"]: r for r in ds}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("instance_ids", nargs="*")
    ap.add_argument(
        "--validate",
        action="store_true",
        help="只校验 instance_id 是否存在于 dataset，不输出题面",
    )
    args = ap.parse_args()
    if not args.instance_ids:
        print("需要至少一个 instance_id", file=sys.stderr)
        return 2

    by_id = load_records()

    # ⚠️ 存在性校验必须**显式失败**。§4.2 原话：「不存在的 id 会静默变成「未解出」」——
    # 官方 harness 对没提到的实例记 ungraded，汇总时若当 0 处理，
    # 就是把「我们的数据错了」伪装成「模型没解出来」。实测手挑的 10 条里有 3 条不存在。
    missing = [i for i in args.instance_ids if i not in by_id]
    if missing:
        print(
            f"❌ 这些 instance_id 不在 {DATASET} split={SPLIT} 里：{', '.join(missing)}",
            file=sys.stderr,
        )
        print(
            "   （不存在的 id 不会报错，只会静默记 ungraded —— 所以这里必须硬失败）",
            file=sys.stderr,
        )
        return 1

    if args.validate:
        print(json.dumps({"ok": True, "count": len(args.instance_ids)}, ensure_ascii=False))
        return 0

    for iid in args.instance_ids:
        rec = by_id[iid]
        print(json.dumps({k: rec[k] for k in SAFE_FIELDS if k in rec}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
