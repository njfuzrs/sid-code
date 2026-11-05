---
Status: implemented
Date: 2026-11-05
---
# trace-digest 认出幽灵超时与泄漏流，eval-session skill 的报告路径与对照方法一并修正

## 决定了什么

会话 `20261103-213816-f5beebde` 的复盘（方案 §6 T1–T10）落地。核心不是"加两个统计"，
而是**把一个长期被当成正面指标的数（`TimeoutFired`）拆成"真生效"与"空转"两类** ——
那次会话 10 次超时全部是幽灵触发，按旧口径读，结论与事实相反。

改动落点：

| 文件 | 改了什么 |
| --- | --- |
| `packages/core/src/trace/digest.ts` | T1 删结论性提示；T2 `detectGhostTimeouts`（新）；T3 `detectLeakyStreams` + `countStallWarnLines`（新）；T4 `groupProviderHealth`（新）+ 渲染改走它；T5 `SubAgentSpan` 加 `transcriptPath` / `failureFamily` / `failureReason` 并在 `subagent_execution_outcome` 输出；T6 `aggregateSessionMetrics` 加 `e2e_no_hitl_*` / `turn_hitl_wait_*`；T7 `describePathology` 加 `crossRefs` 参数做交叉引用 |
| `packages/core/src/trace/collector.ts` | T5：`SubagentStop` 落 `agent_transcript_path`（有则落，缺失不伪造） |
| `packages/core/src/trace/uploader.ts` | T5：把该字段加进 `LOCAL_ONLY_EVENT_DATA_FIELDS`（绝对路径含用户名，上传前剥掉） |
| `.claude/skills/eval-session/SKILL.md` | T8 报告目录改到仓库同级的 `docs-research/.../eval/`（含 `done/`）且不许回退仓内；T9 `git stash` 对照改为 `origin/main` 临时 worktree；T10 铁律加第 8 条 + 陷阱补两条 |
| `.claude/skills/eval-session/references/analysis-cookbook.md` | 补两段查询：按 `(agentId, turnIndex)` 统计 stall 存活期；`TimeoutFired` 与尝试终点的时间戳对齐 |
| `packages/core/tests/trace/digest-ghost-timeout-leaky-stream.test.ts` | 新增 22 条（含 T1 的源码字面量门禁） |

### 实施时与方案有出入的四处（都已按实测改掉，不是偷懒）

1. **T2 的配对键只能是 `turnIndex`，不能用 `pair_index` / `agent_turn`。**
   `TimeoutFired.index` 来自 `emitTimeoutFired(index, …)`，取值是 `state.turnCount` /
   `obsCtx.turnIndex`；`stream_completed` 落盘时保留原始 `turnIndex`，`pair_index`
   与 `agent_turn` 是 collector 事后派生的**另一套**映射。用派生字段配对会张冠李戴 ——
   这正是本仓铁律 7 反复警告的那类错误，所以 key 的选择写进了函数注释与 skill 的陷阱节。
2. **T3 单靠方案给的判据会漏掉主循环那一条，必须两条互补。**
   方案写的是「stall 晚于该流的 `stream_completed`，或会话快照时刻仍未见 `stream_completed`」。
   实测 9 条泄漏流里 8 条符合第一条，而主循环 `index=11` 那条**不符合任何一条**：
   它被放弃后一直报到用户重试（2.85h），而重试成功落的 `stream_completed` 在最后一条
   stall **之后**。于是补了第二条 `frozen_span`（跨度 > 180s 且 `totalEvents` 全程冻结），
   用它抓到那条。少了这条，报出的"泄漏流数量"会比实际少 1，而这一类恰好是最贵的
   （跨度 12 小时级）。
3. **T4 不做数值合并，只做视觉归并。** 同 provider 下多协议各占一行、缩进示归属；
   把 `responses` 的 TTFT 并进 `openai` 的 P50 会违反「分位数不可再平均」，等于用修 T4
   换一条新的假结论。零请求行不输出的代价是「请求 0 次但有超时计数」这类无分母异常
   不再单列 —— 它们本来也无法从成功率看出来，由 `retry_timeout` / `timeout_fired` 那条线报。
4. **T5 的 sidechain 路径需要一个新埋点，方案没提这一层。**
   `SubagentStop` 此前不落 `agent_transcript_path`，digest 拿不到路径就只能靠猜目录结构。
   改法是从**源头**落（`sub-agent.ts` 本来就把该字段给了 hook，只是 collector 没存），
   而不是在 digest 里拼 `~/.sid-code/sessions/<project>/<sessionId>-<agentId>.jsonl` ——
   后者会在目录规则变化时静默失配。该字段是绝对路径含用户名，与 `agent_cwd` 同口径
   进 `LOCAL_ONLY_EVENT_DATA_FIELDS`，上传前剥掉。

### 另外两件顺手查出来的事

- **T5 里 `agentId === "main"` 的过滤是冗余的**，是变异自证抓到的：删掉它测试仍然全绿，
  因为回填走的是 `giveUpByAgent.get(span.agentId)` 精确匹配，主循环的 `"main"`
  结构上匹配不到任何子代理。已删掉该行（并换了个能咬住的变异点：把精确匹配改成
  「取 map 里第一个」，此时 2 条用例立刻变红）。**留着一段永不生效的排除代码，
  会让后来者以为它在下防御。**
- **T1 的源码字面量门禁被自己的注释命中过一次**：我原本在注释里逐字复述了被删的那句话，
  门禁立刻变红。这说明该门禁是有效的（也说明写注释时别复述被禁的文案）。

## 放弃了什么（以及为什么不选）

- **只在 digest 里给 `TimeoutFired` 加一句「注意可能是幽灵触发」的提示**：那是把判断
  推给读者。上一版提示就犯了这个错（"若同 index 无 TimeoutIneffective 说明超时正常生效"），
  而本会话 10 次全不满足该判据、全被误导。结论性提示必须能由机器核实，否则就是噪声。
- **T2 只按 `index` 匹配、不看「终点之后是否开了新一代」**：会把「重试后的新尝试上正常开枪」
  误报成幽灵。实测会话里 `index=10` 有 6 次 `StreamRestart`，不设这道保护就会多报。
  宁可漏报也不误报 —— 被刷屏的告警最后没人看。
- **T3 用「stall 总条数超过阈值」当判据**：条数与泄漏时长不是一回事，慢流也会报很多条。
  改成看「相对流终点的位置」与「进度是否冻结」，这两个才是泄漏的因果证据。
- **T6 把 `TurnComplete.hitl_wait_ms` 与弹窗级 `hitl_wait_total_ms` 合并成一个数**：
  两者不同源（轮级 vs 单次弹窗），一轮可能弹多次，合并后既不能做轮级扣减、
  也看不出单次体验。两个都留，注释写明不可相加。
- **T8 让 skill 报告"写到仓内也行，只要记得删"**：那依赖使用者记得。报告落在未跟踪路径上
  碰一次 `git add .` 就进开源仓 —— 这是发生过的事实，不是假设。改成"路径本身就在仓外"。
- **T9 用 `git stash` + `git stash pop` 做对照并加一句"记得 pop"**：仓规明确禁止
  （卷走并行任务在途工作、真实丢过数据），加提醒不改变它的破坏性。改成临时 worktree。
- **给 T10 的 skill 改动写自动化测试**：skill 是 markdown 指令，断言其"内容正确"只能靠
  字符串匹配，会锁死措辞而抓不到真实缺陷。验收方式按方案定的：下一次 eval-session
  执行时报告落在 docs-research、跨报告 grep 命中本报告。

## 拿什么证明它生效了

**新增单测 22 条，全绿**：

```bash
bun test ./packages/core/tests/trace/digest-ghost-timeout-leaky-stream.test.ts
# 22 pass / 0 fail / 52 expect() calls
```

**九项变异自证，逐项改坏 → 确认变红 → 恢复**（脚本 `/tmp/pr5-mutation-check.sh`，
恢复用 `/tmp` 备份而不是 `git checkout`）：

| 变异 | 结果 |
| --- | --- |
| M1 T2 判据方向反转（要求终点在 fire 之后） | 3 条 T2 用例红 |
| M2 T2 去掉「新一代已开始」保护 | 「不判幽灵」用例红 |
| M3 T3 泄漏阈值抬到不可能达到 | `frozen_span` 用例红 |
| M4 T3 `completed_after` 方向反转 | 3 条 T3 用例红 |
| M5 T4 去掉零请求过滤 | 3 条 T4 用例红 |
| M6' T5 把 agentId 精确匹配改成取第一个 | 2 条 T5 用例红 |
| M7 T6 去掉「非 HITL」分支条件 | T6 用例红 |
| M8 T7 去掉泄漏流交叉引用 | T7 用例红 |
| M9 T1 把那句结论性提示加回去 | T1 源码字面量门禁红 |

> M6 原本的变异点（删 `agentId === "main"` 过滤）**没有变红**，这才发现那段是冗余代码 ——
> 已按上面「顺手查出来的事」处理，换成 M6' 后正确变红。**这条是变异自证唯一抓到东西的地方，
> 也是它值得做的理由。**

**门禁**：

```bash
bun run affected-tests:run   # 1062 pass / 0 fail（73 files，trace 域）
bun run lint                 # 0 warnings 0 errors
bun run format:check         # All matched files use the correct format
bun run lint:boundary        # 跨包相对路径 0 处、端口直连 0 处
bun run lint:command-system  # 四道门禁通过
bun run lint:legacy-tool     # 58 == 基线 58
bun run typecheck:gate       # 62 处错误 / 基线 64，无新增
make build                   # 通过 + 产物自检 5/5
```

**用真实轨迹验证检测器（不是只跑单测）** —— 拿方案引用的那次会话的 events 直接跑
`detectGhostTimeouts` / `detectLeakyStreams` / `countStallWarnLines`：

```text
T2 幽灵超时命中: 10            # 方案说 10 次全是幽灵，对上
   index=10001 gap=211075ms … index=10 gap=169280ms   （gap 范围 78s~211s）
T3 泄漏流命中: 9               # 方案说 9 个流，对上
   sub-agpkum4v0#10001 stalls=413 span=44044s completed_after
   sub-a2pojjmqm#10006 stalls=1223 span=43912s frozen_span
   ...
   main#11            stalls=368  span=42692s frozen_span
   main#30            stalls=13   span=360s   completed_after
warn.log: {"stall":4084,"total":4265}   # 95.7%，与方案 §1.1 一致
```

**实测修正了一条方案里的预期**（第 5 处事实差异）：方案 §1.2 那句「间隔精确等于 idle
阈值 240s」是相对 `unrecognized_error`（漏斗放弃）算的，而 `unrecognized_error` **不带
`turnIndex`**，结构上无法与 `TimeoutFired.index` 配对。能配对的终点只有
`stream_completed` / `AfterModel`，它们早于放弃时刻，所以实测间隔是 78s~211s、**都不是**
240s。结论：命中判据只能是「晚于终点」，「间隔 ≈ 阈值」降级为加分证据（`thresholdNote`
在 |gap − thr| < 1s 时才标注），写进判据会让这 10 条全部漏报。这条已写进函数注释。

另一条实测修正：9 条泄漏流里 **7 条** `completed_after` + **2 条** `frozen_span`
（`main#11` 与 `sub-a2pojjmqm#10006`），不是方案暗示的「8+1」。`frozen_span` 这条判据
覆盖了两条最贵的泄漏（跨度 12 小时级），去掉它这两条会静默消失。

未做端到端真实会话验证（要复现「额度耗尽 → 生成器被丢弃」的场景）：T2/T3 的检测器
在修复前的轨迹上命中，等 PR1 的 `raceIterate` 生效后再跑同类会话，这两个 anomaly 应归 0 ——
那是这条链路的最终验收，本次只做到"能识别"。
