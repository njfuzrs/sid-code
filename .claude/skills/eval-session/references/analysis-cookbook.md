# 轨迹分析 cookbook:脚本层 vs 手写查询层

本文件是 eval-session 的 **L0 事实层**参考:什么时候用现成的 `trace-digest`,什么时候自己写查询,以及经过验证的查询片段(省去每次摸索数据格式)。

## 分层速查:这件事该谁做

| 想知道的东西 | 用什么 | 为什么 |
| --- | --- | --- |
| 单会话的异常首过(29 类检测) | `trace-digest`（现成) | 别重造;它是 L0 权威 |
| 跨会话聚合(如"X% 会话缺 SessionEnd") | 手写 bash/python | trace-digest 只能单会话 |
| 某个具体假设的定向验证 | 手写查询 + read 源码 | 脚本假设需 L1 验证 |
| 自定义切片(按工具/按时间/按 agent) | 手写查询 | 脚本输出是固定视图 |
| "这是缺陷还是取舍""严重度多少" | 大模型判断(L2) | 任何脚本都做不了 |

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
- `--json` 是它唯一的结构化出口,需要程序化处理时优先用它,而不是解析人读输出。

## 二、手写查询(补脚本做不到的,经验证片段)

> `session.traj` 是**单个顶层 JSON**(键:`trajectory`/`history`/`info`/`metadata`),**不是 JSONL**——用 JSONL 逐行解析会失败。`events.jsonl` 才是逐行 JSONL。

### 跨会话:统计某信号的分布(如 SessionEnd 缺失率)

```bash
cd ~/.sid-code/trajectories/sessions
total=0; missing=0
for d in 202607*/; do
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

### 成本/账本:某会话是否入账本

```bash
grep -c "<id 后 8 位>" ~/.sid-code/usage-ledger.jsonl
```

## 三、把脚本自身的缺陷当 harness 发现

评估中若发现 trace-digest **误报/漏报/结果与原始数据矛盾**(如首过步数与 traj 实际不符、把并行标成循环),**这本身就是一条 §3 harness 缺陷**,按缺陷模板写进报告(根因定位到 `src/trace/digest.ts:行号` + 修复方向)。流程因此自我改进:每次评估都可能反哺脚本。

> 不要 vendor:trace-digest 引擎(`src/trace/digest.ts`)与内置 `/trace` 命令共用,**按路径调用仓库脚本,不要复制进本 skill 的 scripts/**(会分叉出双份真相)。skill 的 scripts/ 只放仓库里没有的新助手。
