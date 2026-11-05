# 轨迹分析 cookbook:脚本层 vs 手写查询层

本文件是 eval-session 的 **L0 事实层**参考:什么时候用现成的 `trace-digest`,什么时候自己写查询,以及经过验证的查询片段(省去每次摸索数据格式)。

## 分层速查:这件事该谁做

| 想知道的东西 | 用什么 | 为什么 |
| --- | --- | --- |
| 单会话的异常首过(整套内置检测) | `trace-digest`（现成) | 别重造;它是 L0 权威 |
| 跨会话聚合(如"X% 会话缺 SessionEnd") | 手写 bash/python | trace-digest 只能单会话 |
| 没指定会话、要挑"高产候选"评 | 手写批量分诊(见下"批量分诊") | 系统性找 bug 的选样,单会话大概率干净 |
| 某个具体假设的定向验证 | 手写查询 + read 源码 | 脚本假设需 L1 验证 |
| 自定义切片(按工具/按时间/按 agent) | 手写查询 | 脚本输出是固定视图 |
| "这是缺陷/取舍/优化点""严重度或收益多少" | 大模型判断(L2) | 任何脚本都做不了 |

**铁规则**:数字类事实由脚本/查询产出,大模型不口算;结论由大模型下,不停在脚本未验证的输出上。

## 一、trace-digest(现成,首过必用)

```bash
bun scripts/trace-digest.ts <完整-id>          # 人读摘要
bun scripts/trace-digest.ts <完整-id> --json    # 机器可读,给下游程序/进一步处理
bun scripts/trace-digest.ts <完整-id> --full    # 附更多思维链/工具参数
bun scripts/trace-digest.ts --list             # 列最近 20 个会话
```

已知局限(核实后别当真缺陷,详见 SKILL.md "陷阱"):
- 只单会话,无跨会话聚合;
- shape 检测不看时间戳 → 并行子代理误报 `stuck_loop`;
- SessionEnd 缺失误判 hang(交互会话常态);
- id 只支持**日期前缀**(`20260723`),不支持 hash 后缀(`5ca82fd3`);
- `--list` 只列**最近 20 个**会话,更早的会话列不出来(需用完整 id 或去 sessions 目录 grep);
- `--json` 是它唯一的结构化出口,需要程序化处理时优先用它,而不是解析人读输出。

## 二、手写查询(补脚本做不到的,经验证片段)

> `session.traj` 是**单个顶层 JSON**(键:`trajectory`/`history`/`info`/`metadata`),**不是 JSONL**——用 JSONL 逐行解析会失败。`events.jsonl` 才是逐行 JSONL。

> **多语句 python 用 heredoc,别用 `python3 -c "..."`。** 单行 `-c` 里写多语句极易 typo(实证 20260723-140029:一轮里 `or {}` 打成 `or `、`observation') or` 断行,连翻 3 次车),而且报错信息还被 shell 引号搅得难读。多语句一律用下面的 heredoc 模板,一次过:
>
> ```bash
> cd ~/.sid-code/trajectories/sessions/<完整-id>
> python3 << 'PYEOF'
> import json, collections
> o = json.load(open('session.traj'))
> traj = o.get('trajectory') or []
> # …在这里写多行分析,缩进/引号都不受 shell 干扰…
> for i, s in enumerate(traj):
>     obs = s.get('observation') or {}
>     if isinstance(obs, dict) and obs.get('is_error'):
>         print(i, s.get('tool_name'))
> PYEOF
> ```
>
> 用 `'PYEOF'`(带引号)阻止 shell 对 heredoc 体做变量展开。只有真正的单表达式(如 `json.load(open(f))['metadata']`)才值得用 `-c`。

### 跨会话:统计某信号的分布(如 SessionEnd 缺失率)

```bash
cd ~/.sid-code/trajectories/sessions
# 用 202*/ 覆盖所有会话;别写死单月前缀(如 202607*/)——跨月后会静默漏采。
# 要限定时间窗时,显式收窄 glob(如 20260[6-7]*/)并在报告注明口径。
total=0; missing=0
for d in 202*/; do
  f="$d/events.jsonl"; [ -f "$f" ] || continue
  total=$((total+1))
  grep -q '"SessionEnd"' "$f" 2>/dev/null || missing=$((missing+1))
done
echo "总数=$total 缺失=$missing"
```

### 单会话:解析 session.traj 的步骤/动作序列

```bash
python3 -c "
import json
o=json.load(open('session.traj'))
for i,s in enumerate(o['trajectory']):
    print(i, s.get('message_type'), s.get('tool_name'),
          (s.get('tool_input') or {}).get('description','')[:40])
"
```

### 单会话:events.jsonl 事件类型分布 + 末事件(判断收尾方式)

```bash
python3 -c "
import json,collections
c=collections.Counter(); last=None
for l in open('events.jsonl'):
    l=l.strip()
    if not l: continue
    try: o=json.loads(l)
    except: continue          # 坏行跳过,不放弃整场
    c[o.get('event') or o.get('type') or '?']+=1; last=o
for k,v in c.most_common(): print(v,k)
print('LAST:', json.dumps(last,ensure_ascii=False)[:200])
"
```

### 定向验证:子代理是否真并行(比对派发时间戳,推翻/证实 stuck_loop 假设)

```bash
python3 -c "
import json
o=json.load(open('session.traj'))
for i,s in enumerate(o['trajectory']):
    if s.get('tool_name')=='sub_agent':
        print(i, s.get('timestamp'), (s.get('tool_input') or {}).get('description','')[:30])
"
# 时间戳相同/相近 = 并行 fan-out(合法),非空转
```

### 单会话:按 (agentId, turnIndex) 统计 stall 存活期(判「泄漏流」,区分「流很慢」)

> 用途:`warn.log` 里成百上千条「事件间隔 Ns(stall)」时,判断是**这条流真的很慢**(正常,有上限)还是**定时器没随流停止**(泄漏,会一直报到进程退出)。判据:`gapMs` 单调增长且 `totalEvents` 全程不变 = 流早已没有任何事件进展,定时器在空转。
> 实证锚点 `20261103-213816-f5beebde`:`warn.log` 4265 行里 4084 行是 stall(95.7%),9 条流一直报到会话快照时刻,最长 `gapMs=44016166`(12.2h)、`totalEvents` 恒为 2。

```bash
cd ~/.sid-code/trajectories/sessions/<session-id>
python3 -c "
import json,collections
g=collections.defaultdict(lambda:{'n':0,'first':None,'last':None,'gaps':[],'tot':set()})
for line in open('events.jsonl'):
    line=line.strip()
    if not line: continue
    try: o=json.loads(line)
    except: continue
    if o.get('event')!='RetryTelemetry': continue
    d=o.get('data') or {}
    if d.get('type')!='stream_stall': continue
    ti=d.get('turnIndex')
    if not isinstance(ti,int): continue
    k=(d.get('agentId') or 'main', ti)
    s=g[k]; s['n']+=1
    s['first']=s['first'] or o['timestamp']; s['last']=o['timestamp']
    s['gaps'].append(d.get('gapMs')); s['tot'].add(d.get('totalEvents'))
for (a,t),s in sorted(g.items(), key=lambda kv:-kv[1]['n']):
    print(f'{a}#{t} stall={s[\"n\"]} first={s[\"first\"]} last={s[\"last\"]} last_gap={s[\"gaps\"][-1]} totalEvents={sorted(x for x in s[\"tot\"] if x is not None)}')
"
# 判读:last_gap 远超 overall 阈值(默认 180s)且 totalEvents 只有单一取值 → 泄漏流
# digest 已内置同口径检测器:找 anomaly `leaky_stream_stall`(L0 [高]),不用手算
```

### 单会话:`TimeoutFired` 与「尝试终点」的时间戳对齐(判「幽灵超时」)

> 用途:回答「这些超时是真打断了活的流,还是在已经结束的尝试上空转」。做法 = 对每条 `TimeoutFired`,取同 `index` 的尝试终点(`stream_completed` 或 `AfterModel`),算间隔。
> **配对命名空间**(铁律 7):`TimeoutFired.index` 与 `RetryTelemetry.stream_completed.turnIndex` 同空间;`pair_index` / `agent_turn` 是 collector 派生的,**不要拿它们配**。
> 实证锚点 `20261103-213816-f5beebde`:10 次 `TimeoutFired` 与 `unrecognized_error`(漏斗放弃)的间隔为 239.998~240.003s,**恰好等于 idle 阈值 240s** —— 定时器是从「流被放弃那一刻」起算的。

```bash
cd ~/.sid-code/trajectories/sessions/<session-id>
python3 -c "
import json,collections
from datetime import datetime
def ms(ts):
    return datetime.strptime(ts,'%Y-%m-%dT%H:%M:%S.%fZ').timestamp()*1000
ends=collections.defaultdict(list)   # index -> [(ms,label)]
fired=[]
for line in open('events.jsonl'):
    line=line.strip()
    if not line: continue
    try: o=json.loads(line)
    except: continue
    ev=o.get('event'); d=o.get('data') or {}
    if ev=='RetryTelemetry' and d.get('type')=='stream_completed' and isinstance(d.get('turnIndex'),int):
        ends[d['turnIndex']].append((ms(o['timestamp']),'stream_completed'))
    elif ev=='AfterModel' and isinstance(d.get('index'),int):
        ends[d['index']].append((ms(o['timestamp']),'AfterModel'))
    elif ev=='TimeoutFired' and isinstance(d.get('index'),int):
        fired.append((ms(o['timestamp']), o['timestamp'], d['index'], d.get('layer'), d.get('threshold_ms')))
for tms,ts,idx,layer,thr in fired:
    prior=[e for e in ends.get(idx,[]) if e[0]<=tms]
    if not prior:
        print(f'{ts} index={idx} layer={layer} 无终点(可能是真超时)'); continue
    at,label=max(prior)
    gap=tms-at
    flag='  <== 间隔≈阈值,幽灵触发' if thr and abs(gap-thr)<1000 else ''
    print(f'{ts} index={idx} layer={layer} 终点={label} gap={gap:.0f}ms thr={thr}{flag}')
"
# 判读:gap 远大于 0 且≈阈值的那些,是在**已结束的尝试**上开的枪
# digest 已内置同口径检测器:找 anomaly `timeout_fired_after_attempt_end`(L0 [高])
```

### 成本/账本:某会话是否入账本

```bash
grep -c "<id 后 8 位>" ~/.sid-code/usage-ledger.jsonl
```

### 批量分诊:从一批会话里挑"高产候选"(为"系统性找 bug"选样,SKILL Phase 0 第 5 点"适评性分诊"用)

> 单个会话大概率干净,直接深挖任意会话期望产出低。没指定会话时,先扫一批挑出**有异常信号**的会话再深挖。下面按"收尾方式 + 是否有 warn 错误 + 步数"粗筛,输出可疑会话清单供人选。

```bash
cd ~/.sid-code/trajectories/sessions
python3 -c "
import json,glob,os
rows=[]
for d in sorted(glob.glob('202*')):        # 全量;要限时间窗改 glob 并注明口径
    ev=os.path.join(d,'events.jsonl')
    if not os.path.isfile(ev): continue
    last=None; has_err=False; n=0
    for l in open(ev):
        l=l.strip()
        if not l: continue
        try: o=json.loads(l)
        except: continue
        n+=1; last=o
        et=(o.get('event') or o.get('type') or '')
        if 'Error' in et or 'error' in et: has_err=True
    wl=os.path.join(d,'warn.log')
    warn=os.path.getsize(wl) if os.path.isfile(wl) else 0
    le=(last or {}).get('event') or (last or {}).get('type') or '?'
    # 高产信号:有 error 事件 / 末事件异常 / warn.log 偏大(阈值按你机器调)
    if has_err or le not in ('SessionEnd','') or warn>4000:
        rows.append((d, n, le, 'ERR' if has_err else '', warn))
for r in sorted(rows,key=lambda x:-x[4]):
    print(f'{r[0]}  事件={r[1]:>4}  末={r[2]:<20} {r[3]:<4} warn={r[4]}')
print(f'--- {len(rows)} 个可疑会话(有异常信号),优先评这些 ---')
"
```

> 这是**粗筛**,不是判定——命中只表示"值得看",仍要走 Phase 1 首过 + 逐段核实。阈值(warn>4000 等)是启发式,按实际调;别把粗筛结果当结论直接写进报告。成本离群需结合账本另算(账本 sessionId 是 hash 后 8 位,与轨迹目录名的日期前缀是两套 key)。

**更快的主键分诊(有 session-summary.json 时优先用)**:

```bash
cd ~/.sid-code/trajectories/sessions
# 主键 = real_errors(诚实错误计数,仅 is_error/TurnError/errors.jsonl/退出error/侧调用失败/数据损坏),
# 或 high_severity_anomalies>0。不要再用 .errors(已弃用别名 = anomalies_count,含 watchdog 慢响应 /
# stuck_loop 等假阳性,会把干净会话误选成"高产候选")。
cat */session-summary.json 2>/dev/null | jq -c 'select(.real_errors > 0 or .high_severity_anomalies > 0)
  | {session_id, real_errors, anomalies_count, high_severity_anomalies, exit_status, anomaly_kinds}'
```

> 发现 3 修复后:`real_errors` 是新主键(诚实错误数),`anomalies_count` 是旧 `errors` 语义(含假阳性,仅供参考),`errors` 保留为 `anomalies_count` 的弃用别名。慢响应(`model_call_slow_response`)已降级为 [低],不再进 `high_severity_anomalies`。

## 三、把脚本自身的缺陷当 harness 发现

评估中若发现 trace-digest **误报/漏报/结果与原始数据矛盾**(如首过步数与 traj 实际不符、把并行标成循环),**这本身就是一条 §3 harness 缺陷**,按缺陷模板写进报告(根因定位到 `src/trace/digest.ts:行号` + 修复方向)。流程因此自我改进:每次评估都可能反哺脚本。

> 不要 vendor:trace-digest 引擎(`src/trace/digest.ts`)与内置 `/trace` 命令共用,**按路径调用仓库脚本,不要复制进本 skill 的 scripts/**(会分叉出双份真相)。skill 的 scripts/ 只放仓库里没有的新助手。
