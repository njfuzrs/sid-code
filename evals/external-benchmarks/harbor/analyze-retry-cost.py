#!/usr/bin/env python3
"""判据 ④:重试的墙钟代价与内层 attempt 上限。

源 = session 级 `events.jsonl` 里 `event == "RetryTelemetry"` 且
`data.type == "retry"` 的事件。墙钟**只累加 `delayMs`**(纯等待,不含生成耗时)。

用法:
    python3 analyze-retry-cost.py runs/a11-sid

## ⚠️ 基线数字不要照抄 §17.5

§17.5 记的「315s / attempt 4-5 of 11」是**一次观测到的单次故障**。
把 10 题全量扫一遍(本脚本)得到的是另一个分母:

    retry 164 次 / 故障链 45 条 / 内层 attempt 最大 7
    单链等待:最大 411.5s  中位 71.1s  合计 5465s(≈91 分钟纯等待)

**不是矛盾,是分母不同。** 换档后的对照必须与**全量数字**比 ——
拿 411.5s 去对 315s 会得出一个假的「变差了」。

## ⛔ 两轮直接比总量之前,先看 `重开原因` 构成(2026-08-30 实测)

本脚本输出的总量(链数 / 合计等待)**受上游当时的健康状况支配**,
而那与权限档毫无关系。实测两轮的成因构成几乎是反的:

    基线 runs/a11-sid    : {'server_error': 161, 'rate_limit': 3}
    本轮 runs/permswitch-r2: {'rate_limit': 26,  'server_error': 7}

本轮的 `rate_limit` 占了压倒多数,因为跑动中途**上游令牌额度耗尽**
(403 `pre_consume_token_quota_failed`)、恢复后又持续瞬时 429。
所以「本轮合计等待 479s 远低于基线 5465s」**不能读成 harness 变好了** ——
两轮面对的上游根本不是同一个上游。

**要拿判据 ④ 做换档对照,只能比同成因的分项**(如两轮都看 `server_error` 那部分),
或者干脆承认这一轮的判据 ④ 不可比并说明原因。总量是**上游健康度的读数**,
不是 harness 的读数。

## ⚠️ 盲区:零调用的题在这里是 0 事件,不是"没有重试"

`polyglot-c-py` / `regex-log` 这两题被基础设施故障挡死(一次 API 调用都没成功),
sid-code 的「清理空白轨迹」会把整个 session 目录删掉,于是它们在本脚本里
**贡献 0 个 retry 事件** —— 而它们恰恰是重试打得最凶的两题(各 30+ 次失败重试)。
形态:**代价最大的样本在代价统计里完全隐身**。

判它们的判据在 `verifier_health.agent_ran`(本脚本不重复实现),
读本脚本的数字时必须先看那里有几题是 False。
"""
import json, glob, sys, collections, statistics, os

run = sys.argv[1]
chains = []      # 每次故障链的总等待
attempts = []    # attempt 取值
by_reason = collections.Counter()
per_task = {}

for f in sorted(glob.glob(os.path.join(run, "*", "agent", "sid-home", "trajectories", "sessions", "*", "events.jsonl"))):
    task = f.split(os.sep + "runs" + os.sep)[-1].split(os.sep)[1] if os.sep + "runs" + os.sep in f else f.split(os.sep)[1]
    cur = 0
    local = []
    for l in open(f, errors="replace"):
        try: d = json.loads(l)
        except Exception: continue
        if not isinstance(d, dict) or d.get("event") != "RetryTelemetry": continue
        data = d.get("data") or {}
        if data.get("type") != "retry": continue
        a = data.get("attempt")
        if isinstance(a, int):
            attempts.append(a)
            # attempt 回到 1 表示上一条链结束
            if a == 1 and cur:
                chains.append(cur); local.append(cur); cur = 0
        dm = data.get("delayMs")
        if isinstance(dm, (int, float)): cur += dm
        by_reason[data.get("reopenReason") or data.get("error", "?")[:40]] += 1
    if cur: chains.append(cur); local.append(cur)
    if local: per_task[task] = local

print(f"=== 判据 ④  {run} ===")
print(f"  retry 事件总数 {len(attempts)}；故障链 {len(chains)} 条")
if attempts:
    print(f"  内层 attempt 最大值 {max(attempts)}   分布 {dict(collections.Counter(attempts))}")
if chains:
    cs = sorted(chains)
    print(f"  单链等待(秒): 最大 {max(cs)/1000:.1f}  中位 {statistics.median(cs)/1000:.1f}  合计 {sum(cs)/1000:.1f}")
    print(f"  (基线:单次故障 315s / attempt 4-5 of 11)")
print(f"  重开原因 top5: {dict(by_reason.most_common(5))}")

# ── 两条盲区必须**印在输出里**,不能只写在注释里 ────────────────────────────
# 写在 docstring 里的警告只有读源码的人看得到,而读数字的人往往只看输出。
# 上面两段注释记的正是这一轮真实发生的两件事,所以这里当场报出来。

# 盲区 1:零调用的题贡献 0 个 retry 事件(sid-code 会「清理空白轨迹」删掉整个
# session 目录),而它们恰恰是重试打得最凶的题 —— **代价最大的样本在代价统计里隐身**。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verifier_health import agent_ran  # noqa: E402

zero_call = []
for f in sorted(glob.glob(os.path.join(run, "*", "result.json"))):
    try:
        if agent_ran(json.load(open(f))) is False:
            zero_call.append(os.path.basename(os.path.dirname(f)).split("__")[0])
    except Exception:
        pass
if zero_call:
    print(f"\n  ⛔ 盲区:{len(zero_call)} 题一次 API 调用都没发生,在本统计里是 0 事件")
    print(f"     {', '.join(zero_call)}")
    print("     它们的重试打得最凶(各 30+ 次失败重试)却完全隐身 —— 上面的合计**低估**了真实等待。")

# 盲区 2:总量受上游健康度支配,与权限档无关。成因构成不同则两轮不可比。
if by_reason:
    top = by_reason.most_common(1)[0]
    share = top[1] / sum(by_reason.values())
    if share > 0.5:
        print(f"\n  ⚠️ 重开原因由 `{top[0]}` 主导({share:.0%})—— 总量是**上游健康度的读数**,不是 harness 的读数。")
        print("     与另一轮比总量前先核成因构成:基线是 server_error 主导,本轮是 rate_limit 主导,两轮面对的上游不是同一个。")
