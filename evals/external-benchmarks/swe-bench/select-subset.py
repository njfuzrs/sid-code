#!/usr/bin/env python
"""SWE-bench Verified 10 题 subset 的确定性选样 + 数据回填。

事实源：`接入计划.md` §3（目录约定）/ §4.2（数据现取）
运行：`.venv/bin/python evals/external-benchmarks/swe-bench/select-subset.py [--write]`

## 为什么要有这个脚本，而不是手挑 instance_id

原 `verified-subset.yaml` 的 10 条是**手挑**的，头部自陈「instance_id 未校验」。
本次实测校验结果：

  - **10 条里 3 条在 dataset 里根本不存在**
    （`sympy__sympy-15011` / `django__django-15347` / `sympy__sympy-21055`）；
  - 5 条候选池里**也有 3 条不存在**（所以「用候选池替换」这个兜底同样不成立）；
  - 存活的 7 条里 `psf__requests-2317` 的 `FAIL_TO_PASS` 实际是 **8 条**，
    违反文件自己写的「≤5」选取标准（yaml 里手写的 `fail_to_pass_count: 2` 是错的）；
  - yaml 里手写的 `difficulty: easy/medium/hard` **不是 dataset 的取值** ——
    真实字段是耗时分桶（`<15 min fix` / `15 min - 1 hour` / `1-4 hours` / `>4 hours`）。

不存在的 id 最坏的地方在于**它不会报错**：官方 harness 对没提到的实例记 `ungraded`，
汇总时若把它当 0，就是「30% 的题目静默变成未解出」。这与被否决的路径 A 那个
`return Score(value=0)` 是同一类假结论。

所以选样改为**确定性生成**，不再手挑。业界同形做法（DeepSeek-Reasonix）的注释说得最清楚：

  > Deterministic by construction: no random seed, no hand-picking.
  > Re-running this against the same dataset revision reproduces subset.json byte for byte,
  > **so the sample cannot be quietly tuned after seeing results.**

最后那半句是关键：手挑的样本**可以在看到分数之后被悄悄调整**，而这是评测里最难自证清白的
一件事。确定性选样从机制上消灭了这种可能——任何人重跑都得到同一份 10 条。

## 选取标准（与 yaml 头部的 5 条一致，但改为机器判定）

1. 单文件修改（patch 里 `+++ b/` 只有一处）—— 避免多文件 patch 的评分歧义
2. `FAIL_TO_PASS` ≤ 5 —— 保证测试结果稳定
3. 难度分散：按 dataset 真实的耗时分桶取，不用手写的 easy/medium/hard
4. 按 repo 比例分配（最大余数法），避免 10 条全是 django（符合条件的 414 条里 193 条是 django）
5. 每个 repo 内按 `instance_id` 排序后取**等距索引**，不取前 N 条（前 N 会系统性偏向
   同一批早期 issue）

## ⚠️ 刻意不入库的东西

`FAIL_TO_PASS` / `PASS_TO_PASS` / `patch` **不写进 yaml** —— 那是答案。
Reasonix 的 subset.json 同样故意不含它们。本脚本只回填 `base_commit`（checkout 需要）
与 `problem_statement_chars`（长度，用于估 prompt 规模），**题面本身也不入库**，
由 runner 在跑的时候从 dataset 现取（`接入计划.md §4.3` 的 prompt 契约第 1 条）。
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from collections import Counter, defaultdict

DATASET = "SWE-bench/SWE-bench_Verified"
SPLIT = "test"
TARGET_N = 10
POOL_N = 5
MAX_FILES = 1
MAX_F2P = 5

# 难度分桶的目标构成。dataset 真实取值只有 4 档，且 `>4 hours` 全库仅 3 条
# （符合单文件+F2P≤5 的只剩 1 条），拿它凑数会让 subset 依赖一条特定题目 —— 故不取。
# 6:4 的分法对应原 yaml「难度分散，避免全过或全 0」那条意图。
DIFFICULTY_QUOTA = {
    "<15 min fix": 4,
    "15 min - 1 hour": 5,
    "1-4 hours": 1,
}

# 每个 repo 最多占几条。
#
# ⚠️ 这个上限是**必须的**，纯按比例分配会失效：符合条件的 413 条里 django 占 193
# （47%），实测按比例分配得到的 10 条里 **8 条是 django**。那样的 subset
# 测不出「链路通不通」，只测出「链路在 django 上通不通」—— 而阶段 A 的目的恰恰是前者
# （不同 repo 的 conda testbed 环境、依赖装法、测试运行器都不一样，
# 这些差异正是链路要承受的东西）。
#
# 取 2：10 条 ÷ 2 ≥ 5 个 repo，而可选池有 12 个 repo，配额一定填得满。
MAX_PER_REPO = 2

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
YAML_PATH = REPO_ROOT / "evals/external-benchmarks/swe-bench/verified-subset.yaml"


def norm_list(v) -> list:
    """datasets 有时给 list、有时给 JSON 字符串，两种都要吃下。"""
    return v if isinstance(v, list) else json.loads(v)


def patch_files(patch: str) -> set[str]:
    return {ln[6:] for ln in patch.splitlines() if ln.startswith("+++ b/")}


def eligible(rec) -> bool:
    return (
        len(patch_files(rec["patch"])) <= MAX_FILES
        and len(norm_list(rec["FAIL_TO_PASS"])) <= MAX_F2P
    )


def largest_remainder(counts: dict[str, int], total: int) -> dict[str, int]:
    """最大余数法按比例分配 total 个名额。确定性：并列时按 key 排序决定。"""
    pool = sum(counts.values())
    if pool == 0:
        return {}
    exact = {k: v * total / pool for k, v in counts.items()}
    base = {k: int(v) for k, v in exact.items()}
    remaining = total - sum(base.values())
    # 余数大的优先；余数相同时按 key 字典序 —— 不留任何随机性
    order = sorted(counts, key=lambda k: (-(exact[k] - base[k]), k))
    for k in order[:remaining]:
        base[k] += 1
    return base


def pick_evenly(items: list, n: int) -> list:
    """从已排序的 items 里取 n 个等距索引。取前 n 会系统性偏向同一批早期 issue。"""
    if n <= 0 or not items:
        return []
    if n >= len(items):
        return list(items)
    return [items[round(i * (len(items) - 1) / (n - 1))] for i in range(n)] if n > 1 else [items[len(items) // 2]]


def allocate_capped(repo_counts: dict[str, int], quota: int, used: Counter) -> dict[str, int]:
    """按比例分配，但每个 repo 受 MAX_PER_REPO 上限约束（含已被别的难度桶占用的额度）。

    做法是「比例分配 → 削掉超限 → 把削出来的名额再分给还有余量的 repo」，循环到收敛。
    全程确定性：并列一律按 repo 名字典序决定。
    """
    alloc = largest_remainder(repo_counts, quota)
    for _ in range(len(repo_counts) + 1):
        overflow = 0
        for repo in sorted(alloc):
            room = max(0, MAX_PER_REPO - used[repo])
            if alloc[repo] > room:
                overflow += alloc[repo] - room
                alloc[repo] = room
        if overflow == 0:
            break
        # 还有余量的 repo：按「池子里条数多的优先」再分，条数相同按名字
        candidates = sorted(
            (r for r in repo_counts if alloc[r] < max(0, MAX_PER_REPO - used[r])),
            key=lambda r: (-repo_counts[r], r),
        )
        if not candidates:
            break
        for repo in candidates:
            if overflow == 0:
                break
            room = max(0, MAX_PER_REPO - used[repo]) - alloc[repo]
            take = min(room, overflow)
            alloc[repo] += take
            overflow -= take
    return {k: v for k, v in alloc.items() if v > 0}


def select(records: list, total: int) -> list:
    """确定性选样：难度配额 → repo 比例（带 per-repo 上限）→ repo 内等距索引。"""
    by_difficulty: dict[str, list] = defaultdict(list)
    for r in records:
        if r["difficulty"] in DIFFICULTY_QUOTA:
            by_difficulty[r["difficulty"]].append(r)

    scale = total / TARGET_N
    chosen: list = []
    # 跨难度桶共享 per-repo 上限，否则 3 个桶各给 django 2 条 = 6 条，上限形同虚设
    used: Counter = Counter()
    for difficulty in sorted(DIFFICULTY_QUOTA):
        quota = round(DIFFICULTY_QUOTA[difficulty] * scale)
        bucket = by_difficulty.get(difficulty, [])
        if not bucket or quota <= 0:
            continue
        repo_counts = Counter(r["repo"] for r in bucket)
        alloc = allocate_capped(dict(repo_counts), quota, used)
        for repo in sorted(alloc):
            k = alloc[repo]
            in_repo = sorted(
                (r for r in bucket if r["repo"] == repo),
                key=lambda r: r["instance_id"],
            )
            picked = pick_evenly(in_repo, k)
            chosen.extend(picked)
            used[repo] += len(picked)
    return sorted(chosen, key=lambda r: r["instance_id"])


def render_yaml(selected: list, pool: list, dataset_size: int) -> str:
    def block(recs: list, indent: str = "  ") -> str:
        out = []
        for r in recs:
            f2p = len(norm_list(r["FAIL_TO_PASS"]))
            files = sorted(patch_files(r["patch"]))
            out.append(
                f'{indent}- instance_id: "{r["instance_id"]}"\n'
                f'{indent}  repo: "{r["repo"]}"\n'
                f'{indent}  base_commit: "{r["base_commit"]}"\n'
                f'{indent}  version: "{r["version"]}"\n'
                f'{indent}  difficulty: "{r["difficulty"]}"\n'
                f"{indent}  # 以下三项是**实测得到的事实**，不是人写的估计；\n"
                f"{indent}  # 它们只用于核对选取标准，不参与判分（判分一律由官方 harness 做）\n"
                f"{indent}  fail_to_pass_count: {f2p}\n"
                f'{indent}  patch_file: "{files[0] if files else ""}"\n'
                f"{indent}  problem_statement_chars: {len(r['problem_statement'])}\n"
            )
        return "\n".join(out)

    return f"""# SWE-bench Verified subset — {TARGET_N} 条（**本文件由脚本生成，勿手改**）
#
# 生成器：evals/external-benchmarks/swe-bench/select-subset.py
# 数据源：{DATASET} split={SPLIT}（共 {dataset_size} 条）
# 重新生成：.venv/bin/python evals/external-benchmarks/swe-bench/select-subset.py --write
#
# ⚠️ 为什么改成脚本生成（上一版是手挑，头部自陈「instance_id 未校验」）：
#   实测校验发现手挑的 10 条里 **3 条在 dataset 里根本不存在**
#   （sympy__sympy-15011 / django__django-15347 / sympy__sympy-21055），
#   5 条候选池里**也有 3 条不存在**，所以「从候选池替换」这个兜底同样不成立。
#   存活的 7 条里 psf__requests-2317 的 FAIL_TO_PASS 实际是 8 条，违反本文件
#   自己写的「≤5」标准（手写的 fail_to_pass_count: 2 是错的）。
#
#   不存在的 id 最坏之处是**它不报错**：官方 harness 对没提到的实例记 ungraded，
#   汇总时若当 0 处理，就是「30% 的题静默变成未解出」—— 与被否决的路径 A 那个
#   scorer 硬编码返 0 是同一类假结论。
#
# 确定性保证（抄业界同形做法）：无随机种子、无手挑，同一 dataset revision 重跑
# 逐字节复现。**这样样本就不可能在看到分数之后被悄悄调整。**
#
# 选取标准（机器判定，不是人写的形容词）：
#   1. 单文件修改（patch 里 +++ b/ 仅一处）
#   2. FAIL_TO_PASS ≤ {MAX_F2P}
#   3. 难度按 dataset **真实字段**的耗时分桶取（不是人写的 easy/medium/hard）：
#      {json.dumps(DIFFICULTY_QUOTA, ensure_ascii=False)}
#      —— `>4 hours` 刻意不取：全库仅 3 条、符合前两条的只剩 1 条，
#         取它会让 subset 依赖一条特定题目
#   4. 按 repo 比例分配（最大余数法）—— 符合条件的 414 条里 193 条是 django，
#      不按比例分配会得到「10 条全是 django」
#   5. repo 内按 instance_id 排序取**等距索引**（取前 N 会系统性偏向同一批早期 issue）
#
# ⚠️ **刻意不入库**：FAIL_TO_PASS / PASS_TO_PASS / patch 全部不写进本文件 —— 那是答案。
#   problem_statement（题面）也不入库，由 runner 从 dataset 现取，
#   见 接入计划.md §4.3 prompt 契约第 1 条。
#
# 数据隔离铁律（CLAUDE.md §0.4 + §9.3）：
#   - 不写自家 baseline_scores
#   - 不进自家 grader registry
#   - 报告独立到 evals/_reports/external/

dataset:
  name: "{DATASET}"
  split: "{SPLIT}"
  size: {dataset_size}

selection_criteria:
  files_modified_max: {MAX_FILES}
  fail_to_pass_max: {MAX_F2P}
  difficulty_quota:
{chr(10).join(f'    "{k}": {v}' for k, v in sorted(DIFFICULTY_QUOTA.items()))}
  deterministic: true

instances:
{block(selected)}
# === 候选池（{POOL_N} 条）===
# 用途：某条 instance 在 gold 自检阶段跑不过时的替补。
# ⚠️ 与上面 10 条同一套标准、同一个确定性算法产出，**已逐条校验存在于 dataset**
#    （上一版候选池 5 条里有 3 条不存在，等于没有兜底）。
candidate_pool:
{block(pool)}"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="写回 verified-subset.yaml")
    args = ap.parse_args()

    from datasets import load_dataset

    ds = load_dataset(DATASET, split=SPLIT)
    records = [r for r in ds if eligible(r)]
    print(f"dataset {len(ds)} 条，符合「单文件 + F2P≤{MAX_F2P}」{len(records)} 条")

    picked = select(records, TARGET_N + POOL_N)
    if len(picked) < TARGET_N + POOL_N:
        print(f"❌ 只选出 {len(picked)} 条，不足 {TARGET_N + POOL_N}", file=sys.stderr)
        return 1

    selected, pool = picked[:TARGET_N], picked[TARGET_N : TARGET_N + POOL_N]

    print(f"\n选中 {len(selected)} 条：")
    for r in selected:
        f2p = len(norm_list(r["FAIL_TO_PASS"]))
        print(f"  {r['instance_id']:<42} {r['difficulty']:<18} F2P={f2p} base={r['base_commit'][:10]}")
    print(f"\n候选池 {len(pool)} 条：")
    for r in pool:
        print(f"  {r['instance_id']:<42} {r['difficulty']}")
    print("\nrepo 分布:", dict(Counter(r["repo"] for r in selected)))

    if args.write:
        YAML_PATH.write_text(render_yaml(selected, pool, len(ds)))
        print(f"\n已写入 {YAML_PATH.relative_to(REPO_ROOT)}")
    else:
        print("\n（未写入；加 --write 落盘）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
