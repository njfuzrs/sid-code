---
name: observability-debug
description: "排查 sid-code 自身运行时问题(bug / 性能 / 异常退出 / 成本异常 / Agent 跑偏)时,先用确定性脚本把会话轨迹嚼碎成结构化摘要,再据此定位到具体可观测性数据文件,而不是从头啃 12 个可观测性子系统。把'定位 session→解析轨迹→找异常点'从 AI 推理固化为脚本执行。"
when-to-use: "当排查 sid-code 这个 coding agent 自身的问题时触发: 用户说'刚才那次跑崩了/为什么报错/这次怎么这么慢/成本怎么这么高/Agent 在原地打转/帮我看下上次会话出了什么问题/分析一下这个 session';或自测中遇到 sid-code 异常退出、工具调用失败、循环、缓存命中骤降。**仅针对 sid-code 自身的运行轨迹排查**,不用于排查用户业务代码的 bug。"
allowed-tools: bash, read, grep, glob
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
- **异常信号**(按高/中/低排序):异常退出、孤儿 tool_use、工具执行失败、疑似循环、成本归零存疑、协议违规、数据格式异常(schema 漂移)——**每条都附"该看哪个原始文件"指针**
- **工具序列**:每次调用标记 `·` 正常 / `✗` 报错 / `○` 孤儿,带关键参数预览
- **思维链要点**:Agent 当时怎么想的(回答"它为什么做这个决定")
- **崩溃归因**:异常退出时的 attribution
- **深挖指针**:session.traj / raw.jsonl / messages.json / events.jsonl 的绝对路径 + 各自该看什么

**读完这份摘要,你通常已经知道问题出在哪一类、该深挖哪个文件。不要在摘要够用时还去翻原始 jsonl。**

## 第二步(按需):根据异常信号深挖原始数据

摘要给的指针已经指明文件。下面是"异常信号 → 看哪个文件 + 看什么"的映射表,只在摘要不足以定论时用:

| 异常信号 | 深挖文件 | 看什么 |
|---|---|---|
| 异常退出 error | `{session}/messages.json` | `attribution` 字段(error_name / last_tool / has_orphan_tool_use);完整消息历史末尾 |
| 异常退出但无 messages.json | `{session}/raw.jsonl` 末行 | 最后一次 request/response/stop_reason,看 API 层面发生了什么 |
| 孤儿 tool_use / 协议违规 | `~/.sid-code/protocol-violations/*.json` | `summary`(哪个 tool_use 没配对)、`orphans`、`context_window`;provider 是谁 |
| 工具执行失败(✗) | `{session}/session.traj` 对应步骤的 observation.content | 工具报错的具体文本 |
| 疑似循环 | `{session}/session.traj` 的 trajectory | 确认是真打转还是合法的分段读/多点编辑;参考 `src/agent/loop-detection.ts` 的 shape 定义 |
| 成本异常(虚高/归零) | 优先 `{session}/raw.jsonl`(逐次 usage)+ `{session}/session.traj` 的 metadata | 大多数会话**没有** usage-ledger 条目(只有正常 SessionEnd 才写账本),所以别只依赖 ledger;raw.jsonl 每行的 usage 才是逐次真相。归零先查模型是否在定价表 `src/session/state.ts` |
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

## 关键纪律

1. **先摘要后人工**:任何 sid-code 自身问题排查,第一个动作就是 `/trace`(sid-code 内)或 `bun scripts/trace-digest.ts`(终端)。不要先去 `cat` 原始 jsonl,也不要先读 2285 行可观测性文档。
2. **顺着指针走**:摘要里每条异常都带了文件指针,按它深挖,别瞎找。
3. **ledger 覆盖率低是常态**:绝大多数会话没有 usage-ledger 条目(只有正常 SessionEnd 才写账本),所以"成本/账本"维度对多数历史会话是缺失而非异常。脚本已只对有账本条目的会话判成本归零,别把"没成本数据"当成 bug。
4. **只读不改**:本 skill 只用 bash/read/grep/glob 做诊断,定位到根因后再单独动手改代码。
5. **区分边界**:这是排查 **sid-code 自己**的运行轨迹。如果用户是在排查他自己业务项目的 bug,不适用本 skill。
