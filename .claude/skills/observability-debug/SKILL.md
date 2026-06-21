---
name: observability-debug
description: "排查 sid-code 自身运行时问题(bug / 性能 / 异常退出 / 成本异常 / Agent 跑偏)时,先用确定性脚本把会话轨迹嚼碎成结构化摘要,再据此定位到具体可观测性数据文件,而不是从头啃 12 个可观测性子系统。把'定位 session→解析轨迹→找异常点'从 AI 推理固化为脚本执行。"
when-to-use: "当排查 sid-code 这个 coding agent 自身的问题时触发: 用户说'刚才那次跑崩了/为什么报错/这次怎么这么慢/成本怎么这么高/Agent 在原地打转/帮我看下上次会话出了什么问题/分析一下这个 session';或自测中遇到 sid-code 异常退出、工具调用失败、循环、缓存命中骤降。**仅针对 sid-code 自身的运行轨迹排查**,不用于排查用户业务代码的 bug。"
allowed-tools: bash, read, grep, glob, sub_agent
user-invocable: true
argument-hint: "[sessionId|latest] —— 不传默认分析最近一次会话"
---

# observability-debug Skill

你在排查 **sid-code 这个 coding agent 自身的运行时问题**。sid-code 有一套完整的可观测性体系(轨迹三文件 + 遥测 Span + 用量账本 + 协议违规 + 崩溃验尸快照),但有 12 个子系统、文档 2285 行。**不要从头啃文档**——先用确定性脚本把目标会话嚼碎,再按需深挖。

## 第一步(永远先做):拿结构化摘要

**在 sid-code 交互界面里(零摩擦,首选)**——直接敲内置命令:

```
/trace            分析当前正在跑的会话(进程内拿 sessionId,比 mtime 猜测准)
/trace latest     分析最近一次结束的历史会话
/trace <id前缀>    指定会话,如 c857
/trace --list     列出最近 20 个会话(异常会话优先排查)
/trace --full     附带更多思维链/参数细节
```

**在 claude code / 终端里**——跑等价脚本(与 `/trace` 共用 `src/trace/digest.ts` 核心逻辑):

```bash
bun scripts/trace-digest.ts --list            # 不知道是哪个会话时,先列最近 20 个(异常会话标红)
bun scripts/trace-digest.ts latest             # 分析最近一次会话
bun scripts/trace-digest.ts <id前缀>            # 分析指定会话,如 c857
bun scripts/trace-digest.ts <id> --full        # 需要更多思维链/参数细节时
bun scripts/trace-digest.ts <id> --json        # 需要程序化处理时
```

无论哪个入口,都会一次性给你:

- **退出状态**(end_turn 正常 / error / abort / user_interrupt)+ 是否异常
- **异常信号分两层呈现**(环节①摘要分层):
  - **L0 事实层**:机器可验证的客观量(exit_status 字面值 / tool_use 无 result 的计数 / 工具形状连续次数…),**每条带 provenance 出处**(来源文件 + 行号/字段路径 + 原始值 + 文件 mtime + 是否有损)。L0 不含任何判断词。
  - **L1 假设层**:由事实推断出的假设(运行时异常终止 / 中途崩溃 / 原地打转 / 定价表缺失…),**每条带证伪条件(falsifier)**——"看到什么证据就推翻它"。
- **工具序列**:每次调用标记 `·` 正常 / `✗` 报错 / `○` 孤儿,带关键参数预览
- **思维链要点**:Agent 当时怎么想的(回答"它为什么做这个决定")
- **崩溃归因**:异常退出时的 attribution
- **深挖指针**:session.traj / raw.jsonl / messages.json / events.jsonl 的绝对路径 + 各自该看什么

**读完这份摘要,你通常已经知道问题出在哪一类、该深挖哪个文件。不要在摘要够用时还去翻原始 jsonl。**

> ⚠️ **消费 L1 假设的纪律(环节①核心)**:摘要生成器**不替你下诊断**。L0 是事实,L1 只是"待验证的假设清单"。**采信任何一条 L1 假设前,先消解它的证伪条件**——去查 falsifier 指向的证据。fdb47f30 的教训正是把 L1("孤儿 tool_use → 崩溃")当成了 L0(事实),没去查进程是否还活着(falsifier),就写进了"会话崩溃"的结论。**叙事服从证据,不是证据服从叙事。**

## 轨迹文件语义表(环节②:先懂文件语义,再读它)

不同轨迹文件的语义天差地别,**读错语义 = 把症状当病因**。深挖前先对照这张表,别凭文件名猜:

| 文件 | 写入时机 | 含什么 | **不含什么(易误读处)** |
|---|---|---|---|
| `session.traj` | 每步累积 | TAO 步骤数组(action/observation)+ metadata(model/cost/exit_status) | — |
| `raw.jsonl` | 每次 API **响应到达后** | 逐次完整 request/response/usage/stop_reason | 末次请求若无响应(hang),则**没有**它那一行 |
| `raw_preview.jsonl` | 每次 API **请求发出前**(BeforeModel) | 该次请求的预览行(index/model/msg_count/total_tokens_est) | **设计上就不含 response**。"preview 有 index 23 但无响应"是正常的,**不等于**响应丢失/崩溃 |
| `messages.json` | 仅异常退出时 | 崩溃验尸快照(exit_status + attribution + 完整消息历史) | 正常结束的会话**没有**此文件,缺失≠异常 |
| `events.jsonl` | 每个 Hook 事件 | 会话级事件时间线(BeforeModel/AfterModel/Pre/PostToolUse) | BeforeModel 比 AfterModel 多 1 = 末次请求**已发出但响应未到**(hang),非崩溃 |
| heartbeat(events 内) | 主循环每 ~10s | 进程存活心跳 | 心跳在跳 = **进程自己还活着**。别把"历史会话目录里有新心跳"误读成"被别的会话污染"——那就是它自己在跳 |

**结构化文件必须用 JSON 解析,禁用会破坏语义的工具**(环节②核心教训):

- ❌ `strings session.traj | tail`:`strings` 按字节边界切割,会把 UTF-8 中文撕成乱码 → 别据此判定"编码 bug"。
- ❌ `grep -i 'error' debug.log`:grep 返回的行**不带时间戳、不带归属**。捞出一条 error 后,**先 `stat` 看文件 mtime、`grep -c <sessionId>` 看是否属于本会话**,再决定它是否相关。fdb47f30 误把 5/23 的旧日志当成本会话的 smoking gun,就是漏了这一步。
- ✅ 读 jsonl 用 `bun -e` / `jq` 做真正的 JSON 解析,逐行 `JSON.parse`,字段按 key 取,中文不会乱码。

## 第二步(按需):根据异常信号深挖原始数据

摘要给的指针已经指明文件。下面是"异常信号 → 看哪个文件 + 看什么"的映射表,只在摘要不足以定论时用:

| 异常信号(kind) | 深挖文件 | 看什么 |
|---|---|---|
| `exit_status_error` | `{session}/messages.json` | `attribution` 字段(error_name / last_tool / has_orphan_tool_use);完整消息历史末尾 |
| 异常退出但无 messages.json | `{session}/raw.jsonl` 末行 | 最后一次 request/response/stop_reason,看 API 层面发生了什么 |
| `tool_use_without_result` / 协议违规 | `~/.sid-code/protocol-violations/*.json` + `ps` 查进程 | `summary`(哪个 tool_use 没配对)、`orphans`、`context_window`;**先确认进程是否仍存活**(L1 证伪条件) |
| `tool_result_is_error`(✗) | `{session}/session.traj` 对应步骤的 observation.content | 工具报错的具体文本 |
| `repeated_tool_shape_run` | `{session}/session.traj` 的 trajectory | **逐条比对参数**:不同 offset/位置/命令 = 合法进展不是循环(L1 证伪条件);参考 `src/agent/loop-detection.ts` shape 定义 |
| `ledger_cost_zero_with_tokens` | 优先 `{session}/raw.jsonl`(逐次 usage)+ `src/api/cost-tracker.ts` 定价表 | 大多数会话**没有** usage-ledger 条目;raw.jsonl 每行 usage 才是逐次真相。归零先 `grep <model> src/api/cost-tracker.ts` 确认模型是否在表(L1 证伪条件) |
| 跨会话成本趋势 | `~/.sid-code/usage-ledger.jsonl`(grep sessionId)或 `/cache` 命令 | 仅对有账本条目的会话有效;promptTotal/cacheHit/costUSD |
| 缓存命中骤降 | `/cache --breaks`(运行时命令) | 最近缓存中断记录 + 归因(模型变 / system prompt 变 / 工具 schema 变 / TTL) |
| TTFT / 延迟问题 | `{session}/raw.jsonl` 逐次 + `/telemetry` 命令(运行中会话) | **注意**: `telemetry/traces.jsonl` 是全局聚合、当前不带 conversation.id 维度,**无法按 session 过滤**,别去那里找单会话 TTFT。单次延迟看 raw.jsonl 的 timestamp 间隔,或运行时用 `/telemetry` |
| 内存增长 | debug 日志(MEMORY 分类) | RSS 趋势;参考 `src/debug/memory-monitor.ts` |

## 第三步:定位到代码

异常归类后,可观测性子系统与代码的对应(只在需要改代码时查,详见 `docs/summary/可观测性.md`):

- 轨迹采集逻辑:`src/trace/collector.ts` `src/trace/builder.ts` `src/trace/writer.ts`
- 计量精度(成本/Token 可信度四道防线):`src/llm/types.ts`(normalizeCacheUsage/accumulateUsage)+ `src/session/state.ts`(calculateCost)
- 循环检测:`src/agent/loop-detection.ts`
- 协议违规检测:`src/agent/message-invariants.ts`
- 流式停滞/超时:`src/api/stream-watchdog.ts`
- 重试/降级:`src/llm/fallback.ts` + `src/llm/retry-telemetry.ts`
- 缓存失效归因:`src/api/cache-detection.ts`

## 第四步(根因/方案类必做,按任务类型 gate):独立对抗复核

> **门禁**:仅当本次是**排查 / 根因定位 / 出修复方案**这类高风险结论任务时执行本步。日常的"看一眼某会话状态""列个会话清单"等轻量查询**不必**开,避免无谓成本。判断标准:你**即将写下一个会被据此改代码或下结论的判断**时,就必须过这一关。

fdb47f30 的教训:deepseek 在 index 25 已推出正确结论("进程没崩"),却因沉没成本在 index 27 又把它丢弃、写成"崩溃"。它做了"覆盖率自检"(11 个问题都写进文档了吗),**没做"正确性自检"**(每条结论的证据成立吗)。光靠模型自律不行——它投入了 6.2 万字思考仍然错了。所以这一步要**外化成独立动作**:

1. **委托独立的 verify 子代理**:对每条 `高`/`中` 结论,调 `sub_agent` 工具、`agent_type: "verify"`(该类型已内置对抗式系统提示词:默认怀疑、读码举证、grep 调用方、不确定降级)。子代理是干净上下文,**只喂"结论 + 证据指针",不喂你的推理叙事**——它没有你的沉没成本,不会被早期叙事锚定。多条结论可在同一轮发起多个 `sub_agent` 并发证伪(受内核并发上限管控)。
2. **prompt 里给"举证责任反转"指令**:默认立场是**"这条结论是错的,除非证据把我说服"**。要求子代理逐条:
   - 按 `file:line` 指针**实际 read/grep** 核验:引用的内容真存在、真是这样吗?
   - 验证外部证据(日志行/报错)的**时效与归属**:`stat` 看 mtime 是哪天?`grep -c <sessionId>` 是不是本会话?
   - 找因果链的反例:进程真崩了吗?`ps` 查过 PID 吗?
   - 消解对应 L1 假设的**证伪条件**:falsifier 跑过了吗,还是被无视了?
   - 输出四档裁定之一:**CONFIRMED**(证据成立)/ **REFUTED**(附反例)/ **PARTIAL**(现象真但严重度/根因被高估)/ **UNVERIFIABLE**(证据不足),每档附 `file:line` 证据。
3. **回填与门禁**:只有 **CONFIRMED** 的结论能进最终交付;**REFUTED** 从结论剔除(这是有价值的产出,不是失败);**PARTIAL** 保留但按证伪校准严重度;**UNVERIFIABLE** 降级为"待验证",不得作为根因写进交付物。
4. **降级回退**:若 `sub_agent` 不可用(工具未注册 / 达并发上限报错),则在主上下文内**自己扮演 verify**——换一个怀疑视角重读 `file:line` 上下文 + grep 调用方 + 跑一遍每条 falsifier,做一次显式证伪,**严禁跳过**。

verify 子代理提示词模板:

```
对下面这条排查结论做对抗式证伪。默认立场:它是错的,除非证据说服你。
逐条做:① 按 file:line 实际 read/grep 核验证据是否存在且属实;
② stat 看外部证据 mtime(时效)+ grep -c <sessionId> 看归属(是否本会话);
③ 找因果链反例(进程崩了吗?ps 查 PID);④ 跑一遍这条假设的证伪条件。
输出 CONFIRMED / REFUTED(附反例) / PARTIAL / UNVERIFIABLE + file:line 证据 + 证伪尝试记录。
【结论】:<贴这里>
【证据指针 + L1 证伪条件】:<贴这里,不要贴你的推理叙事>
```

> 这一步与"第一步摘要的 L1 假设层"闭环:L1 列出了假设和证伪条件,对抗复核就是真的把每个证伪条件跑一遍。也与 code-review / ci-self-heal 的对抗验证同源(同一套 `sub_agent` + `verify` 机制)。

## 关键纪律

1. **先摘要后人工**:任何 sid-code 自身问题排查,第一个动作就是 `/trace`(sid-code 内)或 `bun scripts/trace-digest.ts`(终端)。不要先去 `cat` 原始 jsonl,也不要先读 2285 行可观测性文档。
2. **L0 是事实,L1 是假设**:摘要的 L0 事实层可直接采信(带出处);L1 假设层**先消解证伪条件再采信**,绝不把假设当事实写进结论。
3. **先懂文件语义再读它**:对照"轨迹文件语义表"。raw_preview 不含 response、messages.json 缺失≠异常、心跳是进程自己在跳——这些语义错了就会把症状当病因。
4. **结构化文件走 JSON 解析**:禁用 `strings`(撕中文)、慎用 `grep`(去时效/归属)。捞到一条外部证据先验时效(mtime)和归属(sessionId)。
5. **顺着指针走**:摘要里每条异常都带了文件指针/出处,按它深挖,别瞎找。
6. **ledger 覆盖率低是常态**:绝大多数会话没有 usage-ledger 条目(只有正常 SessionEnd 才写账本),所以"成本/账本"维度对多数历史会话是缺失而非异常。脚本已只对有账本条目的会话判成本归零,别把"没成本数据"当成 bug。
7. **根因/方案类结论必过对抗复核**:即将写下会被据此改代码的判断时,开独立子代理做举证责任反转的正确性自检(第四步)。覆盖率自检("都写全了吗")替代不了正确性自检("证据成立吗")。
8. **只读不改**:本 skill 只用 bash/read/grep/glob 做诊断,定位到根因后再单独动手改代码。
9. **区分边界**:这是排查 **sid-code 自己**的运行轨迹。如果用户是在排查他自己业务项目的 bug,不适用本 skill。
