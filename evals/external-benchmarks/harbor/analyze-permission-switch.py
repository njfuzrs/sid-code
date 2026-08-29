#!/usr/bin/env python3
"""换档前后对照:按 §14.7 那三条分桶规则算 reward,并出四条判据。

## 它回答的问题(§17.5 第一优先)

第五棒那 10 题的 reward 均值 0.100 里,混着 **144 次权限拒绝**(§17.3)——
那是我们自己把 `acceptEdits` 配上去造出来的,不是能力差距。
换档(`--dangerously-skip-permissions`)后重测同 10 题,这个脚本负责把两轮拉平对照。

用法:
    python3 analyze-permission-switch.py runs/a11-sid          # 换档前基线
    python3 analyze-permission-switch.py runs/baton8-skipperm  # 换档后
    python3 analyze-permission-switch.py runs/permswitch-r2 runs/permswitch-r3  # 主 run + 补跑

## 多 job 合并:**后者补前者,且每题都标出处**

基础设施故障(上游额度耗尽 / 网关 502)会让某题一次 API 调用都没发生,
而它的 `reward=0.0` 与真的没解出来**逐字节一样**。补跑那几题会落在**新 job 目录**,
于是复算必须能把两批拼起来 —— 但拼的时候有一条不能省:

**同一题在多个 job 里都有 → 取最后一个给出的(命令行靠后的 job 覆盖靠前的),
并在表里标明它来自哪个 job。** 不标就是把两批不同时间、不同上游状态的数据
无声混进同一个分母,而**混完之后没有任何东西会报错**。

## ⚠️ 三条分桶规则必须机械执行(§14.7),否则分数失真

  ① **verifier 判分了没有**(正向证据:stdout 里有 pytest 结论行)—— 没判分就不进分母
     ⚠️ 这一条**取代**了 §13.2 那个字面写法(`reward=0` 且 `sid_is_error=False`)。
     照字面做会把 `configure-git-webserver` 错杀 —— 它的 verifier 跑得好好的,
     那是一例真实的「以为自己做完了」失败,必须计分。详见 `excluded()` 的 docstring。
  ② `reward` 缺失 → 不进分母
  ③ **不要只看均值**(§12.1.1)—— 逐题表才是结论,n=10 时均值极易被一题带偏

## ⚠️ 两处「空集恒真」的坑(都踩过)

  - `all(...)` 在空集上恒 True。旧 run 里 `sid_permission_denials` 全是 None,
    直接 `all()` 会报「一致 ✅」而其实**一个都没比**。所以先证明比过,再报一致性。
  - `md_deny=0` vs `deny=None`(日志缺失)**不是不一致**,是「没采到」。
    把它算成不一致会造假红,而假红会训练人忽略这条判据。
"""
import json, glob, sys, os, collections, statistics

# ⚠️ verifier 判据**只在 verifier_health.py 里定义一处**。
# 曾经进度脚本与本脚本各写一份(一份还多要求 uv 装上),于是同一题可能
# 一个报 ✅ 一个报 ⛔ —— 两处判据不一致,而分歧在无人看的时候发生。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verifier_health import agent_ran, verifier_ran  # noqa: E402

runs_arg = sys.argv[1:]
if not runs_arg:
    sys.exit("用法: analyze-permission-switch.py <run目录> [补跑run目录...]")
run = " + ".join(runs_arg)

# 同题去重:靠后的 job 覆盖靠前的(补跑语义)。**出处必须留下**,见上方 docstring。
by_task: dict[str, tuple[str, str]] = {}
for rd in runs_arg:
    for f in sorted(glob.glob(os.path.join(rd, "*", "result.json"))):
        by_task[os.path.basename(os.path.dirname(f)).split("__")[0]] = (f, os.path.basename(rd.rstrip("/")))

rows = []
for task in sorted(by_task):
    f, src_job = by_task[task]
    d = json.load(open(f))
    tdir = os.path.dirname(f)
    md = ((d.get("agent_result") or {}).get("metadata")) or {}
    reward = ((d.get("verifier_result") or {}).get("rewards") or {}).get("reward")

    # ── 规则 ②:verifier 自己坏掉 ──────────────────────────────────────────
    #
    # ⚠️ **判据是「pytest 有没有出结论」,不是「有没有 command not found」。**
    # 后者是 2026-08-29 的初版写法,当天就被自己的数据打穿:三题里
    # `polyglot-c-py` 的 verifier 是在**下载 uv 的中途被超时杀掉**的 ——
    # 日志最后一行停在 `downloading uv 0.7.13`,`uv: command not found`
    # **压根没来得及打印**。于是规则 ② 对它不命中,它只是**恰好**因为
    # `reward=None` 才被排除 —— 那是运气,不是判据。
    #
    # 所以改成**正向判据**:verifier 跑成了 ⟺ stdout 里有 pytest 的结论行
    # (`N passed` / `N failed`)。它对「怎么坏的」不做假设 ——
    # 下载失败、超时被杀、镜像缺依赖、pytest 自己崩,全都落进「没结论」。
    # 这与本仓「别用裸子串代理判据」是同一条:`command not found` 是
    # **某一种坏法的症状**,而「没有结论行」才是「没判分」本身。
    verifier_broken = not verifier_ran(tdir)

    # 审计日志:观测值(不信 metadata,直接数,便于与旧 run 同口径对照)
    deny = allow = None
    a = os.path.join(tdir, "agent", "sid-home", "logs", "permissions-audit.log")
    if os.path.isfile(a):
        c = collections.Counter()
        for l in open(a, errors="replace"):
            try: c[json.loads(l).get("decision")] += 1
            except Exception: pass
        deny, allow = c.get("deny", 0), c.get("allow", 0)

    rows.append(dict(
        task=task, reward=reward, deny=deny, allow=allow,
        subtype=md.get("sid_subtype"), turns=md.get("sid_num_turns"),
        stolen=md.get("sid_num_turns_without_model_interaction"),
        is_error=md.get("sid_is_error"), cost=(d.get("agent_result") or {}).get("cost_usd"),
        cost_src=md.get("sid_cost_source"),
        req_mode=md.get("sid_permission_mode_requested"),
        md_deny=md.get("sid_permission_denials"),
        commit=(md.get("sid_commit") or "")[:12],
        verifier_broken=verifier_broken,
        # ── 规则 ④:agent 到底有没有跑过 ────────────────────────────────────
        # ⚠️ **判据本体在 `verifier_health.agent_ran`,这里只存它的结果。**
        # 曾经在这里自己写过一份 `tok_in == 0 and tok_out == 0` —— 那就是
        # 「同一判据两份拷贝」,而进度脚本还需要同一个判断。三态:
        # True 跑过 / False 零调用 / None 采集缺失(不可判,见该函数注释)。
        agent_ran=agent_ran(d),
        src_job=src_job,
    ))

def excluded(r):
    """None = 进分母。

    ## ⛔ 规则 ① 不能照 §13.2 的字面执行(2026-08-29 实测,前一棒已记在
    ## `analyze-prefix.py` 的 `VERIFIER_RAN_PAT` 注释里,我这次重犯了一遍)

    §13.2 的字面写法是「`reward=0` 且 `sid_is_error=False` → 判分未发生,不进分母」。
    照字面做会把 `configure-git-webserver` 排除掉 —— 而那题的 verifier
    **跑得好好的**(`1 failed in 22.79s`),真实情况是 sid-code 只写了一篇
    「怎么配置」的说明、没真的配好服务器,然后 `subtype=success` 收工。

    **那正是最该计分的一类失败**(「以为自己做完了」)。排除它等于给自己白送一分,
    而且送的恰好是最该被扣分的地方 —— 复算出来是 **0.111**,
    而文档基线是 **0.100**(分母 10)。差的那 0.011 就是这一分。

    形态:`reward=0 且 not-error` 同时覆盖两件**语义相反**的事 ——
      ① verifier 没跑成(判分未发生,该排除)
      ② verifier 跑了、判 0,agent 自我报喜(真实失败,**该计分**)
    只有去看 **verifier 自己的输出**才能分开。`sid_is_error` 是 agent 的自述,
    **拿它推断 verifier 的状态是跨主语推断**。

    所以这里只保留一条实质判据:**verifier 到底判分了没有**(正向证据)。
    `sid_is_error` 不再参与分母决策。

    ## 规则 ④:agent 一次 API 调用都没发生 → 排除(2026-08-29 本轮实测新增)

    本轮 `polyglot-c-py` 拿到 `reward=0.0`、verifier **判分正常**,
    于是上面三条规则全部放它进分母 —— 而它的真实形态是:

        [AUDIT:API] ✗ Anthropic 请求异常 err=502 Remote end closed connection
        [FALLBACK] S3:剩余预算 37543ms 不足以「退避 37043ms + 一次请求」,停止重试
        {"subtype":"error_during_execution","num_turns":0,"total_cost_usd":0,
         "usage":{"inputTokens":0,"outputTokens":0}}

    **网关 502 挡了 277 秒,agent 连第一次调用都没成功,压根没碰过这道题。**
    把它当成一个真实的 0 分,等于把**一次基础设施故障记进能力账** ——
    这与本 Note 主体在修的那件事(权限拒绝混进能力账)**是同一类错误**,
    只不过混进来的是网关而不是权限层。

    ⚠️ 判据用 **token 数**,不用 `turns`:
      - `turns == 0` 也可能是 agent 一轮就答完(理论上),而 in/out token 双 0
        只有「一次调用都没发生」这一种解释;
      - 且 token 来自 Harbor 侧的 `agent_result`,`turns` 来自 agent 自述的
        result 事件 —— **取观测方、不取自述方**。

    ⚠️ 必须是 `== 0` 而非 falsy:`None` 表示这两个键**没采到**
    (基线 `fix-code-vulnerability` 整份 metadata 缺失,但它 verifier 判了分、
    reward 有值,属于「采集缺失但题跑过了」),把 None 也排除会**改动文档基线 0.100**。
    这一条踩过:`if not r["tok_in"]` 会同时吞掉 None,让分母从 10 掉到 9。
    """
    if r["verifier_broken"]:
        return "verifier未判分(无pytest结论行)"
    if r["reward"] is None:
        return "无reward"
    if r["agent_ran"] is False:
        return "agent零API调用(基础设施故障,未碰过题)"
    return None


print(f"=== {run}  ({len(rows)} 题) ===\n")
# 合并多个 job 时才加「出处」列 —— 单 job 时每行都一样,那列只是噪音。
# ⚠️ 但合并时它**不是可选的**:不标出处就是把两批不同时间、不同上游状态的
# 数据无声混进同一个分母,而混完之后没有任何东西会报错(见 docstring)。
MERGED = len(runs_arg) > 1
src_hdr = f'{"出处":<18}' if MERGED else ""
hdr = f'{"题":<28}{"rew":>5}{"deny":>6}{"allow":>6}{"turns":>6}{"stolen":>7}  {"subtype":<22}{"$":>8}  {src_hdr}'
print(hdr); print("-" * len(hdr))
for r in rows:
    # ⚠️ 这一格必须**从 `excluded()` 推**,不许照抄一份条件。
    # 刚刚就踩到:规则 ① 改完后,这里还留着旧条件,于是
    # `configure-git-webserver` 明明进了分母(10/10),表里却标着「⛔不进分母」——
    # **表与分母对不上,而两处都不报错**。判据只能有一个来源。
    flag = "  ⚠️verifier未判分" if r["verifier_broken"] else ""
    why = excluded(r)
    excl = f"  ⛔不进分母({why})" if why and not r["verifier_broken"] else ""
    print(f'{r["task"]:<28}{str(r["reward"]):>5}{str(r["deny"]):>6}{str(r["allow"]):>6}'
          f'{str(r["turns"]):>6}{str(r["stolen"]):>7}  {str(r["subtype"]):<22}'
          f'{(f"{r['cost']:.4f}" if isinstance(r["cost"],(int,float)) else "None"):>8}'
          f'{("  " + f"{r['src_job']:<18}") if MERGED else ""}{flag}{excl}')

# ── 分母(判据定义在文件上方的 `excluded()`,此处只消费,不重复条件)──
kept = [r for r in rows if not excluded(r)]
drop = [(r["task"], excluded(r)) for r in rows if excluded(r)]

print(f"\n=== 分母(三条规则筛后) ===")
print(f"  纳入 {len(kept)}/{len(rows)}")
for t, why in drop: print(f"  排除 {t}: {why}")

if kept:
    rs = [r["reward"] for r in kept]
    print(f"\n  reward 均值 {statistics.mean(rs):.3f}   解出 {sum(1 for x in rs if x==1)}/{len(rs)}")
    print(f"  (⚠️ 不要只看均值 —— 逐题见上表)")

# ── 四条判据 ──
d_tot = sum(r["deny"] for r in rows if r["deny"] is not None)
a_tot = sum(r["allow"] for r in rows if r["allow"] is not None)
print(f"\n=== 判据 ①:deny 总数(基线 144 deny / 178 allow) ===")
print(f"  本次 {d_tot} deny / {a_tot} allow")
print(f"\n=== 判据 ③:被偷轮数字段(基线读不到) ===")
print(f"  有值 {sum(1 for r in rows if r['stolen'] is not None)}/{len(rows)}；取值 {[r['stolen'] for r in rows]}")
print(f"\n=== 权限档自证 ===")
print(f"  requested: {set(r['req_mode'] for r in rows)}")
# ⚠️ 不能只写 all(...):旧 run 里 md_deny 全是 None,空集上的 all() 恒 True ——
# 那正是本仓「门禁绿着失效」那一类。所以先证明**真的比过**,再报一致性。
# ⚠️ 只在**两边都有值**时比。md_deny=0 vs deny=None(日志缺失)不是"不一致",
# 那是"没采到" —— 把它算成不一致会造一个假红,而假红会训练人忽略这条判据。
_cmp = [(r["task"], r["md_deny"], r["deny"]) for r in rows
        if r["md_deny"] is not None and r["deny"] is not None]
_nolog = [r["task"] for r in rows if r["md_deny"] is not None and r["deny"] is None]
if not _cmp:
    print("  ⚠️ metadata 里没有 sid_permission_denials —— 该键未生效(旧 run 预期如此)")
else:
    bad = [c for c in _cmp if c[1] != c[2]]
    print(f"  metadata deny 与实数比对 {len(_cmp)}/{len(rows)} 题；不一致 {len(bad)} 处 {bad if bad else ''}")
    if _nolog:
        print(f"  ⚠️ 另有 {len(_nolog)} 题 metadata 有值但审计日志缺失(未比对): {_nolog}")
print(f"\n=== 缺口 B:commit(期望 7f437eb84e7a,第五棒是 abb8233e9cd8) ===")
print(f"  {set(r['commit'] for r in rows)}")
tc = [r["cost"] for r in rows if isinstance(r["cost"], (int, float))]
print(f"\n=== 成本 ===\n  合计 ${sum(tc):.4f}；cost_source: {collections.Counter(r['cost_src'] for r in rows)}")
