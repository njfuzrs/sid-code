"""verifier 到底判分了没有 —— **唯一判据定义处**(两个脚本都从这里取)。

## 为什么要单独一个模块

2026-08-29 那次,进度脚本与复算脚本各自写了一份判据:
  - 复算脚本:`pytest 有结论行` 即算跑成
  - 进度脚本:`uv 装上` **且** `pytest 有结论行`
于是**同一题可能一个报 ✅ 一个报 ⛔**。两个都"能自证",但它们证的不是同一件事 ——
而评测里最贵的错误就是"两处判据不一致,而分歧在无人看的时候发生"。

判据只能有一个定义处。**这个文件就是那个定义处。**

## 判据本身:正向,不对"怎么坏的"做假设

`verifier/*stdout*` 里出现 pytest 的结论行(`N passed` / `N failed`)⟺ 判分发生了。

⛔ **不用 `uv: command not found` 当判据**(初版踩过):那是**某一种坏法的症状**。
`polyglot-c-py` 的 verifier 是在下载 uv 的中途被超时杀掉的,日志停在
`downloading uv 0.7.13`,那句 `command not found` 压根没来得及打印 ——
判据漏了它,而它只是**恰好**因为 `reward=None` 才被排除(运气,不是判据)。

⛔ **也不额外要求 `installing to /root/.local/bin`**:那是当前 `test.sh` 的实现细节。
上游换个装 uv 的方式(预装、换镜像源、改路径),这条就会把好数据判成坏数据 ——
判据要盯**结果**(判分有没有发生),不盯**过程**(uv 怎么装上的)。
"""

from __future__ import annotations

import glob
import os
import re

#: pytest 的结论行。`\d+ (passed|failed)` 覆盖 "3 failed in 0.61s" /
#: "1 passed, 2 failed" 等形态。⚠️ 改这个正则等于改所有脚本的判据。
PYTEST_CONCLUSION = re.compile(r"\d+ (?:passed|failed)")


def verifier_ran(trial_dir: str) -> bool:
    """True = 这一题的 verifier 真的判分了(stdout 里有 pytest 结论行)。

    没有 stdout 文件 → False(算没跑成,而不是当成跑成了):
    「没采到」与「跑成了」在数据上不可区分时,一律按坏的算 —— 与本仓
    「绝不让采集失败伪装成成功」是同一条纪律。
    """
    for cand in glob.glob(os.path.join(trial_dir, "verifier", "*stdout*")):
        try:
            if PYTEST_CONCLUSION.search(open(cand, errors="replace").read()):
                return True
        except OSError:
            pass
    return False


def verifier_note(trial_dir: str) -> str:
    """给人看的一格短标签。**判定本身只来自 `verifier_ran`**,
    这里多出来的字只解释「大概是怎么坏的」,不参与判定。"""
    if verifier_ran(trial_dir):
        return "✅判分"
    blob = ""
    for cand in glob.glob(os.path.join(trial_dir, "verifier", "*stdout*")):
        try:
            blob += open(cand, errors="replace").read()
        except OSError:
            pass
    if not blob:
        return "⛔未判分(无stdout)"
    if "command not found" in blob:
        return "⛔未判分(uv没装上)"
    if "downloading uv" in blob:
        return "⛔未判分(下载中被杀)"
    return "⛔未判分(原因待查)"
