"""verifier 到底判分了没有 —— **唯一判据定义处**(两个脚本都从这里取)。

## 为什么要单独一个模块

2026-08-29 那次,进度脚本与复算脚本各自写了一份判据:
  - 复算脚本:`pytest 有结论行` 即算跑成
  - 进度脚本:`uv 装上` **且** `pytest 有结论行`
于是**同一题可能一个报 ✅ 一个报 ⛔**。两个都"能自证",但它们证的不是同一件事 ——
而评测里最贵的错误就是"两处判据不一致,而分歧在无人看的时候发生"。

判据只能有一个定义处。**这个文件就是那个定义处。**

## 这里放两个判据,它们问的是**两个不同主语**

| 函数 | 问题 | 取数源 |
| --- | --- | --- |
| `verifier_ran` | **verifier** 判分了没有 | `verifier/*stdout*` 的 pytest 结论行 |
| `agent_ran` | **agent** 跑过没有 | `agent_result` 的 in/out token 数 |

两者都可能单独为假,而组合起来的语义完全不同:agent 没跑过而 verifier 判了分,
形态就是「拿到一个 reward=0,看起来像没解出来,实际压根没碰过这道题」。

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


def agent_ran(result: dict) -> bool | None:
    """agent 到底有没有真的跑过。**None = 采集缺失,不可判**(与 False 严格区分)。

    ## 为什么需要这一条(2026-08-29 本轮实测)

    `polyglot-c-py` 拿到 `reward=0.0` 且 verifier **判分正常** —— 于是所有
    verifier 侧的判据都放它进分母。而它的真实形态是:

        [AUDIT:API] ✗ 请求异常 err=502 Remote end closed connection
        [FALLBACK] S3:剩余预算不足以「退避 + 一次请求」,停止重试
        {"num_turns":0,"total_cost_usd":0,"usage":{"inputTokens":0,"outputTokens":0}}

    网关 502 挡了 277 秒,**一次 API 调用都没成功,压根没碰过这道题**。
    把它当真实 0 分,就是把一次基础设施故障记进能力账。

    ## 判据为什么用 token 而不用 `turns`

    - `turns` 来自 **agent 自述**的 result 事件;token 来自 Harbor 侧的
      `agent_result` —— **取观测方,不取自述方**(跨主语推断是本仓反复踩的坑)。
    - `turns == 0` 理论上还能是「一轮就答完」;in/out token 双 0 只有
      「一次调用都没发生」这一种解释。

    ## ⚠️ `None`(键不存在)与 `0`(显式为零)必须分开

    基线 `fix-code-vulnerability` 整份 metadata 缺失 → 两个键都是 `None`,
    但它 verifier 判了分、reward 有值,属于「采集缺失但题跑过了」。
    用 falsy 判断会把它一起吞掉,**让文档基线 0.100 变成 0.111**(实测)。
    所以这里返回三态:True / False / None,由调用方决定 None 怎么处理。
    """
    a = result.get("agent_result") or {}
    tin, tout = a.get("n_input_tokens"), a.get("n_output_tokens")
    if tin is None and tout is None:
        return None
    return not ((tin or 0) == 0 and (tout or 0) == 0)
