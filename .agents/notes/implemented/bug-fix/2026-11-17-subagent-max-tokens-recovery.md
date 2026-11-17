---
Status: implemented
Date: 2026-11-17
Source: 只读子代理空转与过期清理重读循环-修复与验收方案（2026-11-16）
---
# 子代理撞输出上限改为两段恢复（升档 → 续写 → 拼接），与主循环共用同一份策略

## 决定了什么

子代理的 `max_tokens` 续写分支此前只有一句 `continue`：**不升档、不注入续写提示**。
后果是 4096 的输出预算一撞，模型对「为什么被打断、从哪里续」完全无感知 ——
下一轮经常重头再来或直接收尾，父代理拿到的报告只剩半句，且无从知道它少了什么。
主循环 `query/loop.ts` 早就有完整的两段恢复（升档 → 续写 → 递减收益让手），
子代理这边漂移了整整一段。

本次把恢复策略收成一份共用实现，四处接入：

- **新增 `packages/core/src/query/max-tokens-recovery.ts`**：`resolveMaxTokensEscalationTarget`
  （`min(模型物理上限, 窗口余量, 软顶)`）、`MaxTokensRecoveryState`（升档一次 / 续写计数 /
  递减收益先让手再停止）、`buildMaxTokensContinuationNotice` / `buildMaxTokensHandoffNotice`
  （文案构造器，主循环改为调用同一份）、`runRecoverableTurn`（请求级恢复循环）、
  `extractFinalTextWithContinuation`（按 origin 回溯拼接续写链）。
- **`packages/core/src/agent/agentic-loop.ts`**：主流的 `max_tokens` 分支改走
  `MaxTokensRecoveryState.decide()`；`sendParams.maxTokens` 用升档值并压过
  `sendParamsExtra`；强制总结轮改用 `runRecoverableTurn`，与主流**共用同一个恢复状态**
  （否则一个已续写 8 次的子代理会在收尾轮再烧 8 次）。
- **`packages/core/src/agent/sub-agent.ts`**：`extractFinalText` 委托给纯函数，
  按续写提示的 `_meta.origin` 回溯拼接，不再只取最后一条 assistant。
- **`packages/core/src/context/internal-message.ts`**：登记 `max-tokens-continuation`
  origin（整条隐藏类），使 TUI 不把它当用户输入渲染，同时给回溯拼接一个**结构化**
  的边界判据（不靠文案匹配 —— 文案改一次措辞就静默失配，而失配的表现是报告静默变短）。
- **`packages/cli/src/entrypoints/headless.ts`**（spawn 子进程）：接同一个
  `MaxTokensRecoveryState`。这是韧性最差的一条路径（没有 TUI、没有父进程兜底），
  此前它撞上限直接落到「未知 stop_reason → 退出」并标 `success: true`。

子代理专属的**软顶 `SUBAGENT_ESCALATED_MAX_TOKENS = 32_768`**：主循环升到物理上限，
因为它前面坐着一个人（跑偏了能 ESC）；子代理无人值守，flash 的物理上限 393,216 token
一次跑满约 ¥3.1，而它的产出只是给父代理消费的结论报告。软顶**不影响报告完整性**
（超过就进续写段，逐段补齐后拼回），只决定「一次跑偏最多烧多少钱」。

## 放弃了什么（以及为什么不选）

- **不给子代理做「升到物理上限、不做续写」**：把子代理当主循环。否决理由：
  无人值守 + 成本无上界，一次跑偏就是 ¥3 级别；而且报告并不需要几千行。
- **不做「直接续写、不升档」**：省掉一次重发。否决理由：升档通常一步解决，
  且**不改变对话语义**（历史里不多出任何消息）；先升档能把多数情况压在零额外消息上。
  顺序也刻意与主循环一致：递减收益 → 升档 → 续写（先判终止再花钱）。
- **不在 spawn 路径另写一套**：文档允许「给出不可达证据」来代替接入。否决理由：
  它完全可达 —— `isTruncationStopReason` 且无 tool_use 时就会落到「未知 stop_reason」
  出口，父进程收到半句话还被标成 success。这条恰恰是症状最难看的一条路径。
- **不把 `extractFinalText` 的回溯写进 `sub-agent.ts` 内部**：否决理由：它是 private
  方法，测试够不着，而这段回溯正是「报告少半截」的核心。抽成纯函数后可以
  在单测里直接断言「三段按顺序拼回、只有一个报告头」。
- **不给主循环的续写提示也打 origin**：否决理由：那会改变 TUI 对主循环历史的既有渲染，
  属于本次未讨论的行为变更。本次只做「文案构造器共用」，主循环的显示行为保持不变。

## 拿什么证明它生效了

**G1（新增 `packages/core/tests/agent/max-tokens-recovery.test.ts`，7 个用例）**：

```
bun test packages/core/tests/agent/max-tokens-recovery.test.ts
→ 7 pass, 0 fail, 25 expect() calls
```

覆盖：升档目标的四个分支（软顶/窗口余量/物理上限/模型未知不升档）、
状态机的「升档一次 → 续写 → 递减收益先让手再停止」、
以及主流集成（`requests[1].maxTokens === 32768` 且历史仍以 assistant 结尾、
`requests[2]` 的最后一条是带 origin 的 user、拼接结果为
`"## 报告\n第一段\n第二段第三段"` 且只有一个报告头、续写段独立成条）。

**变异自证**（按仓库要求把被测代码改坏，确认断言变红后恢复）：

| 变异 | 期望变红的断言 | 实测 |
| --- | --- | --- |
| `resolveMaxTokensEscalationTarget` 永远返回 `undefined` | 升档相关 6 条 | 6 fail / 1 pass（唯一 pass 是「模型未知→不升档」，符合预期） |
| `extractFinalTextWithContinuation` 去掉回溯、直接返回最后一段 | 拼接断言 | fail（`Expected -3 / Received +1`） |
| 续写分支去掉 `buildInternalMessage` 注入 | 「最后一条是带 origin 的 user」+ 拼接 | fail |

**门禁**（全部在 worktree 内跑）：

```
bun run typecheck:gate     → 当前 62 处错误 / 基线 62，无新增
bun run format:check       → All matched files use the correct format
bun run lint               → 0 warnings, 0 errors
bun run lint:boundary      → 跨包相对路径 0 处，渲染端口绕过 0 处
bun run lint:legacy-tool   → 57 = 基线 57
bun run lint:command-system→ 四道门禁通过
bun run affected-tests:run → 5687 pass, 9 skip, 0 fail（552 文件）
make build                 → 自检通过（skill 内联 / ripgrep 平台 / review 子命令）
bun run smoke              → 42 例全部通过（binary）
```

`affected-tests` 第一轮红了 2 条**源码形态断言**（`agentic-loop-p3-subagent-summary.test.ts`），
原因是本次重构改变了总结轮的代码形态（`processStream(...)` 变多行、总结轮块变长），
不是行为变化。按「防漂移哨兵红了要补清单而不是删断言」的口径，保留了三条断言的意图、
只调整定位方式（切片窗口 +6000 → +12000；`indexOf("}),")` → 固定 400 字符窗口），
重跑 6 pass。
