"""按臂取数:**同一判据、不同取数源** —— cc / sid / mswea 的唯一定义处。

## 为什么要这个模块(2026-09-08 实测)

`verifier_health.py` 的判据全部读 sid 侧的落点(`metadata.sid_*` / `sid-home/debug.log`)。
cc 臂**天然没有那些键**,于是 `analyze-model-switch.py runs/ccrun-n6` 的实测输出是:

    turns / stolen / subtype / stop_reason / deny / allow / model / provider → 缺 10/10

而这些数据**其实全都在**,在 `agent/claude-code.txt` 的 `result` 事件里
(实测取到 `turns=41 subtype=error_max_turns denials=0`)——
**只是没有任何脚本去读它**。形态是表格里一整列 `None`,而
「看着像 0 denials」与「压根没采到」在表格里长得一模一样,结论却相反。

⇒ 这是本仓「防线全在、调用全 0」的同型:数据落盘了,消费方是空的。

## 三个判据函数与 `verifier_health` 的对应关系

| 语义 | sid 侧(`verifier_health`) | cc 侧(本模块) |
| --- | --- | --- |
| 跑了多少轮 | `metadata.sid_num_turns` | `result` 事件的 `num_turns` |
| 怎么收尾的 | `metadata.sid_subtype` | `result` 事件的 `subtype` |
| 权限拒绝数 | `permissions-audit.log` 实数 | `result` 事件的 `permission_denials` |
| 自报成功却 0 分 | `self_reported_success()` | `self_reported_success_cc()` |

⚠️ **两侧不是同一个函数的两种写法,取数源不同是本质的**:sid 侧的 deny 取
**审计日志实数**(观测),cc 侧只有 agent 自述的 `permission_denials`。
⇒ 报告时必须标明这一格两侧口径不同,⛔ 不许合成一列假装同源。

## ⛔ 三条不许改回去的设计

1. **`detect_arm()` 只信 `config.json` 的 `agent.name`,⛔ 不看目录名。**
   08 号 §9.2-⑦ 那个真错正是「目录名说 cc、里面是 sid」(漏 `SID_W3_ARM=cc`),
   两侧都不报错。跑前闸只在跑之前拦;**手工跑过的 job 事后只有这一条能发现**。
2. **cc 侧 cache token 只取 `trajectory.json`,⛔ 不取 `modelUsage`。** 理由见
   `normalized_tokens()` 的 docstring —— 用后者会算出**负数** fresh。
3. **三态,`None` 必须与 `0` 分开。** 实测边界:`ccrun-smoke` 与 `a10-smoke-cc`
   压根没有 `claude-code.txt`;`ccrun-n6-503-aborted` 有 txt 但**无 result 事件**
   (6 trial / 2 有 txt / 1 有 result)。这三种都必须是 `None` 而不是 0。
"""

from __future__ import annotations

import json
import os
from typing import Any

# ⚠️ import 共享判据而不是自己再数一遍 token —— 「同一判据两份拷贝」是这个目录
# 已经踩过的错(`verifier_health.py` 模块头记着)。
#
# ⛔ **不是为了过门禁摆一个 import**:`normalized_tokens()` 里「采集缺失」那一态
# 直接调 `agent_ran(result) is None` 来判,而不是自己再写一遍
# `tin is None and tout is None`。后者与共享判据**当下等价**,但它是第二份拷贝 ——
# 哪天 `agent_ran` 的三态口径变了,这里会静默分叉。
from verifier_health import agent_ran

#: `config.json` 里 `agent.name` → 臂标识。**用前缀匹配而不是全等**:
#: sid 侧是 `sid_code_agent:SidCodeAgent`、cc 侧是 `claude_code_agent:ClaudeCodeNpm`,
#: 类名会随实现改,模块名是稳定的那一半。
_ARM_BY_AGENT_PREFIX = (
    ("sid_code_agent", "sid"),
    ("claude_code_agent", "cc"),
    ("mini-swe-agent", "mswea"),
)

#: cc 的 NDJSON 输出文件名(相对 trial 的 `agent/`)。
CC_OUTPUT_FILENAME = "claude-code.txt"

#: cc 侧 ATIF 轨迹(harbor 转换产物)。**它是 cc 侧 cache token 的唯一合法源**。
CC_TRAJECTORY_FILENAME = "trajectory.json"

#: sid 侧 SID_CONFIG_DIR 在 trial 的 `agent/` 下的子目录名。
#: ⚠️ 与 `sid_code_agent.py:76` 的同名常量保持一致 —— 不一致的形态是
#: 「settings.json 永远读不到」⇒ 模型名整列 None,而它不报错。
SID_HOME_DIRNAME = "sid-home"


def detect_arm(trial_dir: str) -> str | None:
    """这个 trial 到底是哪条臂跑的。**None = 判不出来**(缺 config.json 或新 agent)。

    判据是 `config.json` 的 `agent.name` —— harbor 自己写下的**观测值**,
    ⛔ 不是目录名,也不是我们传进去的 job 名。

    ## 为什么这一条本身就是一个检测器

    08 号 §9.2-⑦:A3 命令漏了 `SID_W3_ARM=cc` 时,driver 默认 `ARM=sid`,
    于是**拿 sid 跑出一个名叫 `w3-cc-sonnet-72` 的 job**。两侧都不报错,
    到 T5 汇总才发现「harness 对照」两边是同一个 harness。
    `w3-run.sh` 已有跑前一致性闸,但它只管自己启动的 run ——
    **手工跑过的、或从别处拷来的 job 目录,事后只有这一条能发现。**
    """
    cfg = os.path.join(trial_dir, "config.json")
    if not os.path.isfile(cfg):
        return None
    try:
        with open(cfg, encoding="utf-8", errors="replace") as fh:
            name = ((json.load(fh).get("agent") or {}).get("name")) or ""
    except (OSError, ValueError):
        return None
    for prefix, arm in _ARM_BY_AGENT_PREFIX:
        if name.startswith(prefix):
            return arm
    return None


def cc_result_event(trial_dir: str) -> dict[str, Any] | None:
    """cc 侧那个权威的 `result` 事件。**None = 没采到**(三种真实形态,见模块头)。

    取**最后一个** `result` 事件,与 sid 侧 `_last_result_event` 同口径 ——
    一个 trial 理论上只有一个,但取最后一个对「resume / 多段输出」是安全的,
    取第一个不是。

    ⚠️ 坏行必须跳过而不是让整份取数失败:cc 被 SIGKILL 时最后一行可能是半截 JSON。
    一行坏掉就返回 None 等于把「有 30 个好事件 + 1 个截断行」判成「什么都没采到」。
    """
    path = os.path.join(trial_dir, "agent", CC_OUTPUT_FILENAME)
    if not os.path.isfile(path):
        return None
    found: dict[str, Any] | None = None
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue  # 半截行:跳过,不放弃整份
                if isinstance(obj, dict) and obj.get("type") == "result":
                    found = obj
    except OSError:
        return None
    return found


def cc_turns(trial_dir: str) -> int | None:
    """cc 跑了多少轮。**None = 没采到**(⛔ 不是 0 轮)。

    对应 sid 侧的 `metadata.sid_num_turns`。⚠️ cc **没有** sid 那个
    `num_turns_without_model_interaction`(被偷轮数)——那是 sid 自己埋的,
    所以「撞满轮数」在 cc 侧只能看总数,分解不了成因。报告时要说明这一点。
    """
    ev = cc_result_event(trial_dir)
    if ev is None:
        return None
    v = ev.get("num_turns")
    return v if isinstance(v, int) else None


def cc_subtype(trial_dir: str) -> str | None:
    """cc 怎么收尾的:`success` / `error_max_turns` / ...。**None = 没采到**。

    对应 sid 侧 `metadata.sid_subtype`,取值域实测一致(`success`/`error_max_turns`)
    ⇒ 「撞满轮数」这个判据两臂**可比**,这是难得的一格。
    """
    ev = cc_result_event(trial_dir)
    if ev is None:
        return None
    v = ev.get("subtype")
    return v if isinstance(v, str) else None


def cc_denials(trial_dir: str) -> int | None:
    """cc 的权限拒绝条数。**None = 没采到**(⛔ 不是「0 denials」)。

    🔴 **这一格与 sid 侧不同源,不许合成一列**:
      - sid: `permissions-audit.log` 的 **deny 实际条数**(观测,checker 自己记的)
      - cc : `result` 事件的 `permission_denials` 数组长度(**agent 自述**)

    ⚠️ cc 侧**没有 allow 计数** ⇒ sid 侧那条「allow>0 作为反向自证」在 cc 上
    做不到。所以 cc 的 `denials=0` **比 sid 的 `deny=0` 弱**:它区分不出
    「真的零拒绝」与「审计层没记」。08 号 §4.1.1 已警告过这个形态。
    """
    ev = cc_result_event(trial_dir)
    if ev is None:
        return None
    v = ev.get("permission_denials")
    return len(v) if isinstance(v, list) else None


def cc_ttft_ms(trial_dir: str) -> int | None:
    """cc 的 TTFT。**None = 没采到**,而且缺失是**系统性的**。

    🔴 **这个数不能与 sid 侧的 TTFT 做对照**,两条理由都是实测:

    1. **口径不同**:cc 这里是**整会话一个数**;sid 侧 digest 是**每次 fetch 一条**
       (polyglot 那题 n=11 分桶)。一个标量与一个分布的 P50 不是同一件事。
    2. **缺失偏在最需要它的样本上**:`ccrun-n6` 实测 **4/10 题为 None**,
       且**全是 `error_max_turns` 那几题** —— 即撞满轮数、跑得最久的题。
       按有值的样本算均值 = 系统性地只统计了顺利的那些。

    ⇒ 保留这个函数是为了**能报出「缺了几个、缺在哪」**,
    ⛔ 不是为了拿它算两臂 TTFT 差值。
    """
    ev = cc_result_event(trial_dir)
    if ev is None:
        return None
    v = ev.get("ttft_ms")
    return v if isinstance(v, int) else None


def cc_api_error_status(trial_dir: str) -> Any:
    """cc 最后一次 API 错误的状态码(实测 `ccrun-n6` 10/10 都是 None = 无错误)。

    ⚠️ **它不是 sid 侧 `llm_fatal` 的对应物**。cc **自带一层重试**
    (`max_retries=10`,08 号 §4.1.1 实测)⇒ 这个字段有值意味着
    「shim 重试 + cc 自己重试 **都**没救回来」,门槛比 sid 侧高得多。
    ⇒ ⛔ 不许把两臂的「上游打断题数」直接并列 —— 那会让 cc 看起来更稳,
    而其中一部分是它多一层重试换来的,不是 harness 更好。
    """
    ev = cc_result_event(trial_dir)
    if ev is None:
        return None
    return ev.get("api_error_status")


def sid_settings(trial_dir: str) -> dict[str, Any]:
    """容器内那份 `settings.json`(sid agent 真正用的配置)。

    ⚠️ 取它而不取我们传进去的环境变量:环境变量是**意图**,这份文件是
    **落到容器里的事实**。两者不一致过(`_render_settings` 的回落值硬编码
    "openai"),而那种不一致只有对比事实侧才发现得了。
    """
    f = os.path.join(trial_dir, "agent", SID_HOME_DIRNAME, "settings.json")
    if not os.path.isfile(f):
        return {}
    try:
        with open(f, encoding="utf-8", errors="replace") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def sid_model(trial_dir: str) -> tuple[str | None, str | None]:
    """sid 本轮真正发给厂商的 wire model 与 provider。**(None, None) = 没采到**。

    ⚠️ 取 `availableModels[0].modelId`,**不取顶层 `model`** —— 后者是**本地别名**
    (实测恒为 `harbor-gateway`),对「跑的是哪个模型」这个问题恒答错。
    别名 vs 真名的区分见 `packages/core/src/llm/wire-model.ts` 的表。

    📌 与 `cc_model()` 并列:同一个问题(这轮跑的是哪个模型)、不同取数源,
    但**两侧都取观测值** —— 这是本模块的组织原则。
    """
    am = (sid_settings(trial_dir).get("availableModels") or [{}])[0]
    if not isinstance(am, dict):
        return (None, None)
    return (am.get("modelId") or None, am.get("provider") or None)


def cc_model(trial_dir: str) -> str | None:
    """cc 本轮真正被调用的模型。**None = 没采到**。

    取 `result` 事件 `modelUsage` 的键 —— 那是**观测值**:只有真的产生了用量的
    模型才会在里面出现(实测 `{'claude-sonnet-5': {...costUSD...}}`)。

    ⛔ **不取 `config.agent.model_name`**(实测 `anthropic/claude-sonnet-5`)——
    那是**我们传进去的意图**,与 sid 侧「不取环境变量、取容器里那份
    settings.json」是同一条纪律(`_model_of` 的 docstring 记着:意图与事实
    不一致过,而那种不一致只有对比事实侧才发现得了)。

    🔴 **同模型是 harness 对照的必控变量**。这一格缺失时,「A2 vs A3 同模型」
    这句话就只有命令行作证 —— 而本仓三个已实测的坑全是「传了但没生效且不报错」。

    ⚠️ 多个键 ⇒ 本轮**换过模型**(降级链动过)。此时返回逗号拼接的全部键而不是
    第一个:那种情况下"这一轮跑的是哪个模型"本身就没有单一答案,
    截断成一个会把一次降级伪装成一次干净的单模型运行。
    """
    ev = cc_result_event(trial_dir)
    if ev is None:
        return None
    mu = ev.get("modelUsage")
    if not isinstance(mu, dict) or not mu:
        return None
    return ",".join(sorted(mu))


def cc_provider(trial_dir: str) -> str | None:
    """cc 侧 provider(实测 `modelUsage[m].provider`,如 `firstParty`)。**None = 没采到**。

    ⚠️ 与 sid 侧的 `provider` **不同取值域**(sid 是 `anthropic`/`openai` 族名,
    cc 是 `firstParty` 这类内部标签)⇒ ⛔ 两侧不许直接比字符串相等,
    只能各自核「是不是我预期的那个」。
    """
    ev = cc_result_event(trial_dir)
    if ev is None:
        return None
    mu = ev.get("modelUsage")
    if not isinstance(mu, dict) or not mu:
        return None
    provs = sorted(
        str(v["provider"]) for v in mu.values()
        if isinstance(v, dict) and v.get("provider")
    )
    return ",".join(provs) if provs else None


def self_reported_success_cc(result: dict, trial_dir: str) -> bool:
    """cc 侧的「自报做完了,而 verifier 判 0 分」—— 与 sid 侧同语义、异取数源。

    ⚠️ 与 `verifier_health.self_reported_success` **刻意分成两个函数**而不是加个
    分支:那个函数的 docstring 记着三处踩过的取数坑(metadata 在 agent_result 下、
    rewards 是复数、字段名是 sid_subtype),混进 cc 分支会让那些教训失去对应的代码。

    判据同样窄:`subtype == "success"` 且 `reward` 严格 `== 0.0`。
    `reward is None`(verifier 没判分)**不算** —— 那是 `verifier_ran` 管的事,
    混进来会让「仪器坏了」伪装成「agent 自报喜」,两者处置完全相反。
    """
    if cc_subtype(trial_dir) != "success":
        return False
    rewards = (result.get("verifier_result") or {}).get("rewards") or {}
    reward = rewards.get("reward")
    return isinstance(reward, (int, float)) and float(reward) == 0.0


# ── token 归一化:🔴 本模块最要紧的一段 ──────────────────────────────────────


def normalized_tokens(result: dict, trial_dir: str) -> dict[str, Any] | None:
    """把两臂的 token 拆成**同口径**的四格。**None = 拆不出来**(fail-closed)。

    返回 `{fresh, cache_read, cache_write, out, total_in, source}`。

    ## 🔴 为什么必须归一化:裸比 `n_input_tokens` 会得到一个**方向相反**的假数

    两臂的 `n_input_tokens` 语义**相反**(2026-09-08 实测):

    | 臂 | `n_input_tokens` 的成分 | 取数源 |
    | --- | --- | --- |
    | cc  | fresh **+ cache_read + cache_write**(打包) | `harbor/agents/installed/claude_code.py:_build_metrics()` |
    | sid | **按族不同**(见下节)                    | `sid_code_agent.py:993` 取 `total_cumulative_prompt_tokens` |

    ## 🔴 sid 臂内部还要再分族 —— 「按 arm 分支」不够(2026-09-12 实测)

    本函数原先对 sid 臂无条件按「`n_input_tokens` 是纯 fresh」处理。
    **那只对 anthropic 族成立**,因为它累加的 `usage.inputTokens` 直接来自厂商:

        Anthropic  `input_tokens`  = 未命中余量(**不含** cache_read)
        OpenAI 族  `prompt_tokens` = 完整输入(**含** cached_tokens)

    这不是猜的,是 pin 住的那个二进制里的显式分族逻辑
    (`git show 30586ff003c9:packages/core/src/llm/types.ts` 的
    `normalizeCacheUsage()`:anthropic 走 `uncached = input`,
    openai 族走 `uncached = input - hit - write`)——
    **成本那一侧一直是对的**,错的只有本函数。

    ⇒ A1 臂(`origin-deepseek-v4-1-flash`, provider=`openai`)上的实测后果:

        修前:fresh 56,621,493 / cache_read 52,210,549 ⇒ 命中率 48.0%
        修后:fresh  4,410,944 / cache_read 52,210,549 ⇒ 命中率 92.2%

    fresh 虚高 **12.8 倍** —— cache_read 被重复计进了 fresh。而
    A2 臂(sonnet, provider=`anthropic`)不受影响,两臂的差异本身就是这个 bug 的指纹:
    ⛔ 修前那份 48% 与 92.2% 若并列写成「换模型后缓存命中率翻倍」,
    读到的是一个纯粹由取数口径造出来的假变化。

    **判据(逐位复算,⛔ 不是"机理讲得通")**:按族修正后拿 token 反算实付,
    A1 臂 **52/54 题逐位闭合**(相对误差中位 1.11e-16,浮点级)。
    修前用同一份价表算,54 题**一题都不闭合**(比值散在 0.14–0.87,CV 0.42)。
    残差那 2 题(`count-dataset-tokens` +7.7%、`fix-code-vulnerability` +3.7%)
    方向都是**实付高于按累计 token 的预测** ⇒ 疑似有未进 token 累加的额外请求,
    不是本函数的口径问题(口径错会让全部 54 题同向偏移,而不是 2 题)。

    同一题 `polyglot-c-py` 实测:

        cc  n_input = 139541   ← 内含 cache_read 102559 + cache_write 34084,真 fresh 仅 2898
        sid n_input =   4697   ← 纯 fresh

    ⇒ 直接并列会读成「cc 的 input 是 sid 的 30 倍」,而**真实关系是反的**
    (fresh 2898 < 4697)。这是「分母口径一变曲线整体平移」的形态,
    而两个数各自都对、都不报错。

    ✅ **两侧都是 flow(累积)口径**,这一点已实测:`n_input == Σsteps.prompt_tokens`
    在 `ccrun-n6` 上 **10/10 成立**。⇒ 差异**只在成分,不在 stock/flow**,
    所以拆开成分之后是真的可比(不像 `total_tokens_sent` 那种末次快照值)。

    ## ⛔ cc 侧的 cache 只能取 `trajectory.json`,取 `modelUsage` 会算出负数

    两个候选源实测**不一致**,而只有一个与 `n_input_tokens` 同源:

        qemu-startup: harbor n_input = 950403
          trajectory.json  cache_r=681403 cache_w=253983 → fresh =  15017  ✅
          modelUsage       cache_r=736585 cache_w=277138 → fresh = -63320  ❌

    `n_input == Σsteps.prompt_tokens` 而 `trajectory.json` 的
    `final_metrics.extra` 也是同一批 step 累加的 ⇒ **只有它自洽**。
    `modelUsage` 是 cc 自己的会话级计数,与 harbor 转换出的 step 集合不是同一个总体
    (实测差 79891 in / 2185 out,10 题里 1 题不一致)。

    ⇒ 所以本函数带一条**自洽断言**:`fresh < 0` 时返回 `None` 而不是一个负数。
    ⛔ 不许 `max(0, fresh)` 兜底 —— 那会把一个「取数源选错了」的信号
    抹成一个看起来正常的 0,正是本仓最怕的那类静默。
    """
    # 「采集缺失」这一态**复用共享判据**,⛔ 不在这里另写一遍 `tin is None and
    # tout is None` —— 那是第二份拷贝(见模块头 import 处的理由)。
    if agent_ran(result) is None:
        return None
    ar = result.get("agent_result") or {}
    total_in, out = ar.get("n_input_tokens"), ar.get("n_output_tokens")

    arm = detect_arm(trial_dir)
    if arm == "cc":
        traj = os.path.join(trial_dir, "agent", CC_TRAJECTORY_FILENAME)
        if not os.path.isfile(traj):
            return None
        try:
            with open(traj, encoding="utf-8", errors="replace") as fh:
                extra = ((json.load(fh).get("final_metrics") or {}).get("extra")) or {}
        except (OSError, ValueError):
            return None
        cache_read = extra.get("total_cache_read_input_tokens")
        cache_write = extra.get("total_cache_creation_input_tokens")
        if not isinstance(cache_read, int) or not isinstance(cache_write, int):
            return None
        fresh = (total_in or 0) - cache_read - cache_write
        if fresh < 0:
            # 取数源选错了(见 docstring 那个 -63320)。fail-closed:⛔ 不 clamp 成 0。
            return None
        source = "cc-trajectory-final-metrics"
    elif arm == "sid":
        # 🔴 sid 侧 `n_input_tokens` 的成分**按厂商族不同**,⛔ 不是无条件的纯 fresh
        # (2026-09-12 在 A1 换模型臂上实测抓到,详见下方 "sid 臂内部还要再分族")。
        cache_read = ar.get("n_cache_tokens")
        cache_write = ((ar.get("metadata") or {}).get("cache_write_tokens"))
        if not isinstance(cache_read, int) or not isinstance(cache_write, int):
            return None
        _, provider = sid_model(trial_dir)
        if provider is None:
            # fail-closed:族未知时**不猜**。猜错的形态是 cache_read 被重复计入总入,
            # 而两个数各自都对、都不报错(正是本函数存在的理由)。
            return None
        raw_in = total_in or 0
        if provider == "anthropic":
            # Anthropic:`input_tokens` 本就是未命中余量 ⇒ 直接是 fresh。
            fresh = raw_in
            total_in = fresh + cache_read + cache_write
        else:
            # OpenAI 族(deepseek/glm/qwen/…):`prompt_tokens` **含命中** ⇒ 要减掉。
            fresh = raw_in - cache_read - cache_write
            if fresh < 0:
                # 与 cc 分支同一条纪律:⛔ 不 clamp 成 0,那会把「族判错了」
                # 抹成一个看起来正常的数。
                return None
            total_in = raw_in
        source = f"sid-metadata:{provider}"
    else:
        # mswea / 未知臂:⛔ 不猜成分。归一化的前提是知道哪一族口径。
        return None

    return {
        "fresh": fresh,
        "cache_read": cache_read,
        "cache_write": cache_write,
        "out": out or 0,
        "total_in": total_in or 0,
        "source": source,
    }


def observed_model_family(trial_dir: str) -> str | None:
    """这一题**实际**跑的厂商族:`"anthropic"` / `"openai"` / `None`(没采到)。

    两臂各有取数源,都取**观测值**(与 `sid_model` / `cc_model` 同一条纪律):
      - sid:容器 `settings.json` 的 `availableModels[0].provider`(族名,直接就是答案);
      - cc :`modelUsage[m].provider` 是 `firstParty` 这类**内部标签**,不是族名 ⇒
             退回按模型名判(cc 臂在本方案里只跑 `claude-*`)。

    🔴 存在的理由:多条判据的口径**按族不同**(见 `normalized_tokens` 与
    `pricing_ratio`),而"记得按族分支"这件事原先只写在 docstring 里靠调用方自觉,
    实测没被遵守。有了这个函数,门控才能落在被判据自己身上。
    """
    arm = detect_arm(trial_dir)
    if arm == "sid":
        return sid_model(trial_dir)[1]
    if arm == "cc":
        m = cc_model(trial_dir)
        if not m:
            return None
        # 多模型(降级链动过)时:全部都得是 claude 才敢答 anthropic。
        names = [x.strip() for x in m.split(",") if x.strip()]
        if names and all(n.lower().startswith("claude") for n in names):
            return "anthropic"
        return None
    return None


#: sonnet 官方单价(USD / 百万 token):fresh in / cache write / cache read / out。
#: ⚠️ 只用来算**比值**(见 `pricing_ratio`),⛔ 不用来算钱 —— 钱一律取 `cost_usd`。
_SONNET_PRICE = {"fresh": 3.0, "cache_write": 3.75, "cache_read": 0.3, "out": 15.0}

#: 网关折扣后的隐含比值(实测:两臂 19/20 题**逐题都是** 0.6667 = 官方价 × 2/3)。
_EXPECTED_RATIO = 2.0 / 3.0

#: 比值容差。取 1% 而不是浮点 epsilon:实测同一定价表下比值稳定到 4 位小数,
#: 1% 足够宽到容纳舍入,又窄到能抓住 0.7425 那种 11% 的偏离。
_RATIO_TOL = 0.01


def pricing_ratio(result: dict, trial_dir: str) -> float | None:
    """`cost_usd` ÷ 按官方价算出的钱。**None = 算不出**。

    ## 🔴 它是一个**免费的 token 低报检测器**(2026-09-08 实测发现)

    两臂的成本都不是我们自己算的:cc 取 `total_cost_usd`(cc 自报,实测与
    `agent_result.cost_usd` **10/10 逐位相同**),sid 取网关计费口径。
    ⇒ 把 cost 与「按 token 反算的钱」相除,得到的是**隐含定价倍率**。

    实测 20 题(cc 10 + sid 10):**19 题都是 0.6667**(= 官方价 × 2/3,网关折扣),
    逐题一致到 4 位小数 —— 这本身先证明了一件事:**两臂走的是同一张定价表**,
    所以两臂的成本**真的可比**(这是难得的干净口径)。

    而唯一的例外 `qemu-startup` 是 **0.7425**,它暴露了一个真缺陷:

        用 cc 自报 modelUsage 的 token 反算 ⇒ 比值 0.6667  ✅
        用 harbor 累加 step 的 token 反算   ⇒ 比值 0.7425  ❌

    ⇒ **cost 是对的,token 是低报的**:harbor 的 ATIF 转换漏了一部分 step
    (实测漏 79891 input / 2185 output,即 7.8% / 48%)。
    分母小了 ⇒ 算出来的单价偏高 ⇒ 比值偏离。

    ## ⇒ 怎么用它

    比值偏离 `2/3` ⇒ **那一题的 token 不可信,但 cost 可信**。
    ⛔ 别反过来:cost 有独立权威源(agent 自报 + 网关账本),token 只有一条链路。

    ## ⚠️ 只对 sonnet 定价有效 —— 而这条纪律现在**落在代码里**,不再靠调用方记

    换模型臂单价不同,比值不再落在 2/3 附近。原先这里只写了一句"调用方要按模型
    分组看",结果 2026-09-12 的 A1 归档里 `token_undercount_tasks` **命中全部 54 题**,
    并附带一句"⛔ 别拿这些题算缓存命中率" ⇒ 等于把整臂的缓存口径作废掉。

    ⚠️ 而且原文说的"偏移到另一个常数"**也不对**:A1 实测比值散在 0.006–0.034
    (CV 0.39),不是常数 —— 因为偏离量取决于每题的 cache 占比,而两族的单价结构
    差异不是等比的。所以「按模型分组看比值」这个原计划本身也行不通。
    ⇒ 现在改成 `observed_model_family() != "anthropic"` 直接返回 None(判不出来)。

    📌 换模型臂上「token 是否低报」这个问题**当前没有判据**,如实标成 None,
    ⛔ 不用一个恒真的判据冒充它 —— 那比没有判据更坏(见 CLAUDE.md「零触发」那节的同型)。
    """
    # 🔴 门控:这条判据的分母是**写死的 sonnet 官方价**,换模型臂上算出来的
    # 比值与 2/3 无关(A1 实测散在 0.006–0.034),再拿 `_RATIO_TOL` 去比
    # 就是 54/54 全部命中 —— 一个在整条臂上恒真的"缺陷判据"什么也没判。
    # docstring 末尾那句"⛔ 别在那里用这一条"原先只是**注释**,靠调用方记得,
    # 而调用方(`w3-summary.py`)没有分支 ⇒ 2026-09-12 在 A1 归档里如实发生了。
    # ⇒ 把纪律落进代码:族不对就返回 None(= 判不出来),⛔ 不返回一个数。
    if observed_model_family(trial_dir) != "anthropic":
        return None
    tok = normalized_tokens(result, trial_dir)
    if not tok:
        return None
    cost = (result.get("agent_result") or {}).get("cost_usd")
    if not isinstance(cost, (int, float)) or cost <= 0:
        return None
    predicted = sum(tok[k] * _SONNET_PRICE[k] for k in _SONNET_PRICE) / 1e6
    if predicted <= 0:
        return None
    return cost / predicted


def token_undercount_suspected(result: dict, trial_dir: str) -> bool | None:
    """True = 这一题的 **token 低报**(cost 仍可信)。**None = 判不出来**。

    判据:`pricing_ratio` 偏离 2/3 超过 1%。见 `pricing_ratio` 的 docstring ——
    仅对 sonnet 定价成立,**换模型臂上 `pricing_ratio` 自己返回 None**
    (2026-09-12 起门控落进代码),所以这里会如实给出 None = 判不出来,
    ⛔ 不再像 A1 首版归档那样输出一个恒真的 True。
    """
    r = pricing_ratio(result, trial_dir)
    if r is None:
        return None
    return abs(r - _EXPECTED_RATIO) > _RATIO_TOL


def cache_hit_ratio(tokens: dict[str, Any] | None) -> float | None:
    """cache_read ÷ 总入。**None = 拆不出 token**。

    口径与 `CLAUDE.md`「更省」那节一致:分母是**总入**(fresh+read+write),
    ⛔ 不是 fresh。归一化之后这个比值两臂才可比 —— 归一化之前 cc 的分母
    自带 cache 而 sid 的不带,算出来的两个「命中率」不是同一个量。

    ⚠️ 阈值别套同一个:Anthropic 族显式缓存目标 >70%,两臂**都是** sonnet
    走同一个网关 ⇒ 这一格**确实可比**(与换模型臂比时才要分族)。
    """
    if not tokens:
        return None
    total = tokens.get("total_in") or 0
    if total <= 0:
        return None
    return (tokens.get("cache_read") or 0) / total
