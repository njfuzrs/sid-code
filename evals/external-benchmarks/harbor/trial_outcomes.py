#!/usr/bin/env python3
"""逐题结局的**唯一取数处**：reward + 排除原因。

## 为什么要有这个模块

`compare-paired.py` 与 `eval_verdict.py` 都要回答同一个问题：
「这一题在这一轮里到底算不算数」。如果两个脚本各写一份排除判据链，
就会出现本仓 `verifier_health.py` 文件头记的那种形态：

> 复算脚本与进度脚本各自写了一份判据 ⇒ **同一题可能一个报 ✅ 一个报 ⛔**。

两处判据都"能自证"，但它们证的不是同一件事。而评测里最贵的错误就是
「两处判据不一致，而分歧在无人看的时候发生」。

所以**排除顺序也只在这里定义一次**。`verifier_health` 定义的是**单条判据**
（verifier 判分了吗 / agent 跑过吗 / 被外部 kill 了吗），本模块定义的是
**把它们串起来时的顺序与优先级**——后者同样会分叉，而且分叉起来更隐蔽：
两条判据都真，但先问哪一条决定了 `excluded` 的措辞，而措辞进报告、进文档。

## 排除顺序不是随意的，逐条都有实测来源

下面的顺序**照抄 `compare-paired.py` 2026-08-30 起的实现**，一行没动：

1. `verifier未判分` —— 没有 reward 可比；
2. `无reward` —— verifier 跑了但没给出值；
3. `零调用` —— agent 一次 API 都没发（token 双 0）；⚠️ 必须在 `llm_fatal` **之前**；
4. `启动未完成` —— 卡死在启动里，一次请求都没发出去；
5. `被外部kill` —— result 事件从未发出（撞墙钟/硬顶）；
6. `上游打断` —— 重试链耗尽。

⚠️ 第 3 条的顺序是踩出来的（`compare-paired.py` 原注释）：
metadata 整份缺失时 `agent_ran` 返回 `None` 而不是 `False`，上面那条判据判不出来，
而 `llm_fatal` 读的也是同一份缺失的 metadata ⇒ 两条都放行。2026-09-03 实测
`fix-code-vulnerability` 就这样带着一个**卡死在启动里、一次 API 都没发**的
reward=0.0 进了配对分母，把均值从 0.250 拉到 0.125，读起来像「换档退步了」。

⚠️ 第 5 / 6 条不能合并：前者是进程被墙钟/硬顶杀掉，后者是重试链耗尽，
两类样本的处置完全相反（摘出分母 vs 单独计数）。

## ⛔ 这里不做的事

- **不判「谁是能力失败」**：本模块只回答「算不算数」，不回答「为什么没解出来」。
  那属于 `w3-classify.py` / `zero-diag` 的职责，混进来会让排除判据越来越宽。
- **不读 run 级元数据**（模型、成本、缓存）：那些是 `arm_health.py` 的事。
  本模块每题的取数源只有 `<trial>/result.json` 与 trial 目录本身。
"""

from __future__ import annotations

import glob
import json
import os
import sys
from typing import NamedTuple

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from verifier_health import (  # noqa: E402
    agent_ran,
    agent_started,
    externally_killed,
    llm_fatal,
    verifier_ran,
)


class Outcome(NamedTuple):
    """一题在一轮里的结局。

    `reward` 为 None 表示**没有可用的分值**（不是 0——0 是一个观测值）；
    `excluded` 非 None 表示这一题**不参与任何分母**，字符串是原因。
    """

    reward: float | None
    excluded: str | None


def task_key(trial_dir: str) -> str:
    """trial 目录名 → 题键。丢掉 Harbor 的 trial 哈希后缀（`T0001__abc123` → `T0001`）。

    ⚠️ 这个口径与 `w3-summary.py:171` / `w3-classify.py` 一致，四处必须同源。
    当前无碰撞（2026-09-28 实测五个 run 全部 trial 数 == 唯一 key 数）；
    一旦将来做 k>1 重跑，同题多 trial 会落到同一个 run 下，届时**必须**先扩展这里，
    否则 `load_runs` 的「后者覆盖前者」会静默丢掉一次重复运行。
    """
    return os.path.basename(os.path.normpath(trial_dir)).split("__")[0]


def trial_dirs(run_dir: str) -> list[str]:
    """run 目录下的 trial 子目录，按名字排序（判据：有 `result.json`）。

    与 `run_fingerprint.trial_dirs` 同一个判据——`result.json` 也是 harbor
    自己 resume 时用的判据（`job.py:333`）。
    """
    if not os.path.isdir(run_dir):
        return []
    out = []
    for name in sorted(os.listdir(run_dir)):
        p = os.path.join(run_dir, name)
        if os.path.isfile(os.path.join(p, "result.json")):
            out.append(p)
    return out


def read_result(trial_dir: str) -> dict | None:
    """读 trial 的 `result.json`。**读不到 / 不是对象 → None，不抛异常**。

    公开版本：`eval_verdict.py` 算缓存与成本时也要读同一份文件，
    ⛔ 别让它去 import 别的模块的私有 `_read_json`（那等于把两个模块焊死）。
    """
    try:
        with open(os.path.join(trial_dir, "result.json"), encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) else None


def _load(trial_dir: str) -> Outcome:
    """单题的结局。**判据全部复用 `verifier_health`，不在此重写。**"""
    d = read_result(trial_dir)
    if d is None:
        # 读不了 result.json ⇒ 这一题没有任何可用的观测。
        # ⛔ 不当成 0 分：那会把采集失败记成能力失败。
        return Outcome(None, "产物不可读")

    rew = ((d.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    if not verifier_ran(trial_dir):
        excl = "verifier未判分"
    elif rew is None:
        excl = "无reward"
    # ⚠️ 下面两条的顺序与 `is False`（不是 `not`）都是踩出来的，别"顺手简化"：
    # - `agent_ran` 返回 None 表示**采集缺失**，不是「跑过」也不是「没跑」；
    # - `agent_started` 返回 None 表示**没有 agent 日志**（cc / mswea 侧），
    #   用 `not` 会把整个对照侧一起排除掉。
    elif agent_ran(d) is False:
        excl = "零调用"
    elif agent_started(trial_dir) is False:
        excl = "启动未完成"
    elif externally_killed(d):
        excl = "被外部kill"
    elif llm_fatal(d, trial_dir):
        excl = "上游打断"
    else:
        excl = None

    if isinstance(rew, bool):
        # bool 是 int 的子类：`True` 会被当成 1.0 混进均值，且 JSON 里看不出区别。
        return Outcome(None, "reward非数值")
    if isinstance(rew, (int, float)):
        return Outcome(float(rew), excl)
    return Outcome(None, excl)


def load_run(run_dir: str) -> dict[str, Outcome]:
    """一个 run 目录 → `{题: Outcome}`。"""
    return {task_key(td): _load(td) for td in trial_dirs(run_dir)}


def load_runs(run_dirs: list[str]) -> dict[str, Outcome]:
    """多个 run 合并，**后者覆盖前者**（补跑语义）。

    与 `compare-paired.py` 原实现一致：`for r in sys.argv[2:]: new.update(load(r))`。
    ⚠️ 覆盖是静默的——同一题在补跑 run 里出现两次时，只有后那份生效。
    调用方（`compare-paired.py` / `eval_verdict.py`）负责在题集层面做一致性检查；
    本函数不猜「哪一份才对」。
    """
    out: dict[str, Outcome] = {}
    for run_dir in run_dirs:
        out.update(load_run(run_dir))
    return out


def infra_faults(outcomes: dict[str, Outcome]) -> dict[str, str]:
    """被排除的题 → 原因。**这些题不进任何分母**（§5.2）。"""
    return {t: o.excluded for t, o in outcomes.items() if o.excluded}
