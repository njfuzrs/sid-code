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
from arm_health import sid_denials  # noqa: E402
from verifier_health import (  # noqa: E402
    agent_ran,
    externally_killed,
    llm_fatal,
    self_reported_success,
    verifier_note,
)

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
    # 🔴 计数与清单是**两个键**(2026-11-04 拆分)。走共享归一化函数,不再直接
    # `md.get("sid_permission_denials")` —— 覆盖期那批产物里它是 list/None,
    # 会被读成「没采到」,而真相是「计数被清单覆盖了,不可判」。
    deny, deny_list, deny_shape = sid_denials(md)
    if deny is None:  # metadata 缺/覆盖期就直接数日志,别报 None
        a = os.path.join(tdir, "agent", "sid-home", "logs", "permissions-audit.log")
        if os.path.isfile(a):
            c = collections.Counter()
            for line in open(a, errors="replace"):
                try:
                    c[json.loads(line).get("decision")] += 1
                except Exception:
                    pass
            tag = ",覆盖期" if deny_shape == "overwritten" else ""
            deny = f"{c.get('deny', 0)}(日志{tag})"
    # 清单回答的是「拒的是哪个工具」,与计数不是同一个数:一条清单可能带 count。
    # 只在采到且非空时附加,免得把「没有拒绝」读成「没采到」。
    if deny_list:
        deny = f"{deny} list={len(deny_list)}条"
    # ⚠️ agent 侧健康也要**当场**报,理由与 verifier 那格完全相同:
    # 本轮 `polyglot-c-py` 被网关 502 挡死、一次 API 调用都没成功,
    # 而它的 `reward=0.0` 与「真的没解出来」**逐字节一样**。
    # 进度里不报,就要等复算时才发现这一题白跑了。
    # 判据来自 `verifier_health.agent_ran`,与复算脚本**同一个定义处**。
    ar = agent_ran(d)
    agent_tag = {True: "", False: " ⛔agent零API调用", None: " ⚠️agent用量未采到"}[ar]
    # 第三种形态:跑起来了又被上游打断(`build-cython-ext` 8/40 轮就被 429 打空重试链)。
    # 它 `agent_ran` 判 True,所以上面那格是空的 —— 不单独报就会被当成一个真实 0 分。
    if ar is not False and llm_fatal(d, tdir):
        agent_tag += " ⛔上游打断(未用完轮预算)"
    # 第五种形态(2026-11-04,外部评测缺陷 3):result 事件从未发出 ⇒ 被 Harbor
    # 硬顶或墙钟超时**外部 kill**。它没走自己的终止路径,不是「模型没解出来」;
    # 与上面那格(重试链耗尽)是两类样本,⛔ 不许合并。
    if ar is not False and externally_killed(d):
        agent_tag += " ⛔被外部kill(结果事件缺失)"
    # 第四种形态:agent 自报做完了,而 verifier 判 0 分(「以为自己做完了」)。
    # ⚠️ 措辞刻意不用 ⛔ —— 那是"不进分母"的符号,而这一类**必须计分**。
    # 报它的理由与上面几格不同:不是"这题白跑了",而是"这题真失败了,但失败在最后一步",
    # 否则它会一直伪装成一个普通的 0 分(实测已三棒没人逐题去读 verifier stdout)。
    if self_reported_success(d):
        agent_tag += " 🙈自报成功却0分"
    print(
        f"{task} reward={reward} subtype={md.get('sid_subtype')} "
        f"turns={md.get('sid_num_turns')} deny={deny} "
        f"verifier={verifier_note(tdir)} "
        f"cost={(d.get('agent_result') or {}).get('cost_usd')}"
        f"{agent_tag}"
    )
