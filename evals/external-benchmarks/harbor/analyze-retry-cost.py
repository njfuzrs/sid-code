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
