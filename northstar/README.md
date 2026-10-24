# 北极星指标口径

> 从根 `CLAUDE.md` 搬来（2026-10-17）。根文件只留宗旨与通用铁律；改指标、加埋点、写 release 曲线时读本文件。
> 状态列（✅/⚠️/❌）会随埋点变化而过期，**引用前回源码核对**。

## 四大方向（能复算 · 按 release 出一条曲线）

每个方向都是**一个主口径（那条曲线）+ 一组辅助口径（曲线动了要能归因到哪一层）**。
只有主口径进 release 曲线，辅助口径是排查时的分解项——但**辅助口径缺失时主口径动了也说不清为什么**，
所以两者都列。三档标注按事实分：**✅ 轨迹里已有**（可直接复算）/ **⚠️ 有采集但口径要小心** / **❌ 尚未采集**（想用先补埋点，别拿它当结论）。

四条**跨方向通用铁律**（都是踩出来的）：

1. **一律看 p95/p99，均值会骗人**。慢尾巴才是用户流失点。
2. **每个指标必须能指到源字段**。说不出取数源的数字就是自我感觉，见自检第 2 问。
3. **分母比分子重要**。「命中率」「成功率」「触发率」的分母口径一变，曲线就整体平移——分母必须和指标一起写死。
4. **区分 stock 与 flow**。末次快照值（如 `total_tokens_sent`）除以累加值（如 `total_cost_usd`）得到的是错数，
   要用累积字段（`total_cumulative_prompt_tokens`）。

### 更快 —— 延迟类

| 层 | 指标 | 状态 / 取数源 |
| --- | --- | --- |
| **主口径** | **TTFT** p50/p95/p99 + **端到端耗时**（用户回车 → 最终答复） | ✅ `StreamPhase(first_content).ttft_ms` 是**唯一干净源** |
| 归因：卡在哪一段 | **TTFB**（首字节，拆「网关握手」vs「模型 prefill」） | ⚠️ `headers_received.ttfb_ms`：协议层同口径，**语义受网关缓冲策略影响，跨路由不可比**——必须按 model 分组看（`latencyByModel`） |
| | **纯生成耗时** gen p50/p95/p99（单次 fetch，不含重试） | ✅ `RetryTelemetry(stream_completed).elapsedMs` |
| | **整轮 API 耗时**（含握手 + 生成 + 重试） | ⚠️ `AfterModelRaw.elapsed_ms`，**别与 TTFB 混**，渲染必须标「整轮」 |
| | **工具执行耗时** —— 回答「慢在模型还是慢在工具」 | ✅ `PostToolUse.duration_ms` / `total_tool_duration_ms` |
| 体感 | **tokens/sec**（输出流速，比 TTFT 更贴「生成快慢」体感） | ✅ `output_tokens_per_sec` |
| | **TTFT 按缓存命中分桶** —— 缓存到底让首字快了多少的唯一对照口径 | ✅ `ttftByCache.hit/miss` |
| 缺口 | **TPOT / ITL**（token 间隔，决定打字流畅感）、**Goodput**（满足 SLO 的有效吞吐） | ❌ 全仓零命中；goodput 还需先定义 SLO |

**TTFT 的口径铁律**（这条有 P0 bug 教训）：必须是**首个任意内容 chunk**（含 thinking / tool_use），
且**每次 fetch 单独计、不跨重试累计**。只在可视文本上计 → 对 thinking 模型和纯工具调用轮系统性虚高数十秒。

**TTFB 的口径铁律：禁止跨网关路由汇总**（实测教训，上表那格原写「两族已同口径」是错的）。
同一底层模型走不同网关路由，`ttfb` 的**语义不同**：一路是「模型开始出字」，另一路是
「网关接单了」。实测 51 会话 / 1372 对：`deepseek-v4-pro` 的 `ttft − ttfb` gap 占比 p50 = **86.77%**
（ttfb 484ms → ttft 3983ms），而 `origin-deepseek-v4-pro`（**同底层模型、同属 provider `openai`**）
只有 **5.02%**——差 17 倍。按 provider 汇总出的 `ttfb p50 = 2665ms` 是个假数，
它既不描述前者也不描述后者，却会让人下「首字节很快」的结论。

- 判据：`(ttft − ttfb) / ttft` 的中位数就是**路由缓冲指纹**，**> 50% 即该路由在抢先回 header**。
- 因果方向别搞反：gap 大**恰恰发生在网关响应最快的时候**（gap>50% 的样本 ttfb p50 仅 483ms），
  所以这个差值**不是**框架开销，是「网关缓冲 + 模型 prefill」。别拿它做「框架 overhead 拆解」。
- 落地：单一事实源在 `packages/core/src/trace/latency-by-model.ts`，`digest.ts` 与
  `provider-health.ts` 共用。该模块**刻意不提供跨 model 汇总的 TTFB API**——提供了就会有人用。

### 更省 —— token / 成本 / 缓存 / 上下文

| 层 | 指标 | 状态 / 取数源 |
| --- | --- | --- |
| **主口径** | **单位任务的 token 与成本** | ✅ 账本 `usage-ledger.jsonl` + `metadata.total_cost_usd` |
| 缓存 | **cache 命中率** = cache_read ÷ 总 input | ✅ 目标 >70%（Anthropic 族显式缓存）；**OpenAI 族隐式缓存结构性上限 60–70%**，别拿同一阈值考核两族 |
| | **cache_read / cache_creation 拆分**、**cache break 次数与归因** | ✅ 归因要分清「本地前缀断裂」vs「服务端 TTL / 路由抖动」——只有前者是我们的 bug |
| 上下文（agent 特有） | **上下文占用率** used ÷ window（有效区 <50–65%）、**峰值与趋势** | ✅ `context_usage_peak_ratio` / `_peak_tokens` / `_trend` |
| | **turns per task** —— **会话长度是成本最大杠杆**：2× 轮数 ≈ 3–4× 成本 | ✅ `metadata.total_steps`（后段每轮更贵，第 N 轮 input ≈ N × 第 1 轮） |
| | **compaction 次数**（压缩丢信息 → 重读文件 → 重复付费） | ✅ `metadata.compactions` |
| 成本结构 | **reasoning / thinking token 单独计** | ✅ `total_reasoning_tokens`（OpenAI 族 >0；Anthropic 族恒 0，靠 `has_thinking` 区分） |
| | **side-call 成本**（标题 / 摘要 / recall 等辅助调用） | ✅ 影子调用绕过主埋点，是最易漏计的一块 |
| | **retry 白烧占比** + 白建连接数 | ✅ `retryWastedRatio`（>20% 判病态）/ `extraConnections` |
| 成本结构 | **output ÷ input 比**（输出单价是输入的 3–8×，成本主要由输出主导） | ✅ `metadata.output_input_ratio`（分母 = `total_cumulative_prompt_tokens`，flow 口径） |
| | **cost per successful task**（= 成本 ÷ 成功率）、**tasks-per-dollar** | ❌ 2026 公认唯一真正重要的成本指标；**需先定义「任务成功」信号**才能算 |

### 更准（内部口径叫「更少返工 / 一次做对」）

**「更准」不是「模型更聪明」**（那不由我们控制），准确主语是 harness：
**同一个模型，在 sid-code 里返工更少、一次做对的比例更高。** 四层从过程到结果：

| 层 | 指标 | 状态 / 取数源 |
| --- | --- | --- |
| ① 过程病态率 | retry 浪费比 / 白建连接、backtrack、步数比、**空转**（最长「重复调用且返回值不变」段） | ✅ `retryWastedRatio` / `extraConnections` / `maxUnchangedObservationRun`（≥3 判病态） |
| | **continue 路径收敛**：同一 continue 理由的连续游程是否超出该路径封顶；退化门（unanswered / empty_param / context_window）耗尽后是否仍被闸门续命。两项**恒为 0**，非 0 即某条路径没封住。分母 = 带 `continue_counts` 的 `TurnComplete` 条数（2026-10-24 起） | ✅ `TurnComplete.continue_counts` / `max_continue_streak` / `gates_exhausted` + `GateExhausted` → digest `continuePaths.overCapPrompts` / `continuedAfterChainEnd` |
| ② 工具层 | 工具调用成功 / 失败率 | ✅ `PostToolUse.is_error` |
| | **tool selection accuracy**（选对工具的比例，<90% 说明工具太多或描述差）、**tool retry rate**（同一步失败重试率） | ❌ 均未派生 |
| ③ eval 通过率 | 回归套件通过率，每次发布都跑 | ✅ `evals/` |
| ④ 编辑一次成功率 | 首次 edit 即成功的比例（**单位：文件 × 会话**，分母 = 真实执行过 edit 的文件数，不含 write） | ✅ `session-index.edit_first_try` → northstar `edit_first_try_rate` |
| 结果 / 归因 | 人工介入率 / 返工率、**exit status 分布**（end_turn / 中断 / 错误） | ✅ `metadata.exit_status` |
| | 子代理成败与串并行判定 —— 消灭「全部 SUCCESS」类误判 | ✅ `SubAgentSummary`（`concurrency: serial/parallel/mixed`） |

**hallucination rate（<5%）刻意不追**：在 coding agent 上没有可复算的 grounded 分母，
追它只会得到一个自己定义、自己达标的数字。它的位置由 ② 与 ③ 顶上。

### 更安全

**难点在度量**：安全是「坏事没发生」，负面事件天然稀疏，
**用事故数当指标则分母恒 0、曲线恒平，分不清是防线起作用还是运气好**。所以一律换成正面信号：

| 指标 | 状态 / 取数源 |
| --- | --- |
| **防线触发率** —— 分母限定在「审计核查类任务」，全量任务的分母会把信号稀释掉 | ✅ `scripts/defense-trigger-rate.ts`（实测审计类任务 0% 触发，即「防线全在、调用全 0」） |
| **HITL 介入率**（分工具 / 分规则）与确认耗时 —— 它同时是「更安全 ↔ 更快」这个 trade-off 的计价器 | ✅ `PermissionDecision` 事件 + `session-index.permission`（分母 = 权限决策数）；⚠️ 确认耗时只在交互会话真弹窗时有样本，headless 恒 n=0 |
| **权限规则匹配正确率**（该拦的拦住、不该拦的别拦） | ⚠️ 只有**规则命中率**（`permission.rule_hits` ÷ 决策数）与按 reason 分桶；「正确」需要标注真值，轨迹给不出，仍靠单测 / e2e 断言 |
| **policy e2e 拦截验证**、fail-closed 路径触发计数 | ⚠️ 有 e2e 断言，无长期趋势 |
| **模式越权哨兵**（plan / deny-write 下写类工具被放行的次数，计划文件除外）—— **恒应为 0**，防回归不证修复 | ✅ `session-index.permission.mode_guard_breaches`（求和；分母 = 带该字段的会话数）；源头是 checker 出口总闸 `enforceModeHardConstraint` |
| **决策可归因率**（带管线位置 step 的决策占比）—— 归因口径本身的健康度 | ✅ `session-index.permission.by_step`（分母 = 带 by_step 行的决策数）；逐条在 `PermissionDecision.data.step` / `.mode` |
| **规则暴露会话占比**（会话开始时配了 allow/deny/ask 规则或 disallowedTools）—— 规则类缺陷的**影响面分母** | ✅ `session-index.permission_config` / `SessionStart.data.permission_config`（只有条数 × 来源与开关，不含规则文本） |

**口径铁律（§4 审计踩出来的）**：

- **模式看 `sid_permission_mode` / `PermissionDecision.mode`，不看 `permission_mode`**。后者是 CC 映射值：
  always-allow 与 `--dangerously-skip-permissions` 合并成 `bypassPermissions`，deny-write 记成 `default`，
  且只在 SessionStart 记一次，会话中途切 plan 之后就失真。
- **规则类权限缺陷不靠轨迹证明存在**。2026-10-24 本机 400 会话里四类缺陷触发 0 次，原因是触发前提
  （有规则 / 处于 plan）本身不存在，不是缺陷不存在。存在性靠 `tests/permission/pipeline-order-matrix.test.ts`
  的「模式 × 规则 × 路径」矩阵；轨迹负责的是暴露面（规则暴露会话占比）与回归哨兵。

**新增防线时的验收判据**：不是「build 过 + 单测过」，而是**「真实会话里被触发过」**——
防线自己成了它当初要消灭的死功能，这事已经发生过一次。

## 主指标：四条方向必然互斥，需要一个仲裁者

对立关系是明确的：**更安全 ↔ 更快/更省**（HITL 确认拖慢速度；动态内容伤 cache 命中=伤省）；**更准 ↔ 更省**（多验证一步更准但更贵）。四个指标不可能同时拉满，**没有仲裁者时四条会互相欺骗**。

