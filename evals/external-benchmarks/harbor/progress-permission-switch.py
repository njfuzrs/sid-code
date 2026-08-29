#!/usr/bin/env python3
"""跑到哪了:每题一行 reward + subtype + deny + **verifier 判分了没有**。

最后那一格是这个脚本存在的理由:2026-08-29 那轮 reward 全 0 而
`sid_subtype` 全 `success` —— verifier 下不到 uv 就放弃,分数是假的。
进度里必须**当场**报 verifier 健康,否则要等跑完 4 小时才发现整轮白跑。

⚠️ 判据来自 `verifier_health.py`,与复算脚本**同一个定义处**。

用法:  python3 progress-permission-switch.py [run目录]
"""
import collections
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verifier_health import verifier_note  # noqa: E402

RUN = sys.argv[1] if len(sys.argv) > 1 else "runs/permswitch-r2"

for f in sorted(glob.glob(os.path.join(RUN, "*", "result.json"))):
    tdir = os.path.dirname(f)
    task = os.path.basename(tdir)
    try:
        d = json.load(open(f))
    except Exception as e:
        print(f"{task} RESULT-UNREADABLE {type(e).__name__}")
        continue
    reward = ((d.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    md = ((d.get("agent_result") or {}).get("metadata")) or {}
    deny = md.get("sid_permission_denials")
    if deny is None:  # metadata 缺就直接数日志,别报 None
        a = os.path.join(tdir, "agent", "sid-home", "logs", "permissions-audit.log")
        if os.path.isfile(a):
            c = collections.Counter()
            for line in open(a, errors="replace"):
                try:
                    c[json.loads(line).get("decision")] += 1
                except Exception:
                    pass
            deny = f"{c.get('deny', 0)}(日志)"
    print(
        f"{task} reward={reward} subtype={md.get('sid_subtype')} "
        f"turns={md.get('sid_num_turns')} deny={deny} "
        f"verifier={verifier_note(tdir)} "
        f"cost={(d.get('agent_result') or {}).get('cost_usd')}"
    )
