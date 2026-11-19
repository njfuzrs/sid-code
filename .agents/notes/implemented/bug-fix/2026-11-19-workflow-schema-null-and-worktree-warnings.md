---
Status: implemented
Date: 2026-11-19
Source: Dynamic Workflows 子代理编排缺陷复核（A1/A3，2026-11-19）
---
# workflow 子代理：schema 非 JSON 输出按失败返回 null，worktree 创建期告警拼进 prompt

## 决定了什么

`packages/core/src/workflow/sub-agent-runner.ts`：

- **A1（P0）**：`run()` 的 schema 分支里 `JSON.parse(result.output)` 失败时，从
  `return result.output` 改为 `return null`。与同函数上一分支（StructuredOutput 重试耗尽、
  output 为空 → `return null`）统一口径，也与 `packages/core/src/agent/sub-agent.ts` 的约定
  一致：「返回值被上游视为 null（编排器可判定失败）」。修复前返回字符串会让
  `results.filter(r => r.status === "done")` 静默得到 `undefined`、不抛错，汇总静默漏掉一个单元。
- 该分支的 WARN 日志同时带两样东西：可判定失败的字样「按失败返回 null」+ 原文片段
  `result.output.slice(0, 500)`。**弃用 ≠ 丢掉证据**——只返回 null 而不留原文，非 JSON 输出
  事后连日志都查不到，无法回答「模型到底吐了什么」。
- 删掉该分支上方的错误注释「理论上 StructuredOutput 工具已保证是合规 JSON」，改写成真实机制：
  校验只在注入 schema 时由 StructuredOutput 工具做，而该工具只有在**进过 StructuredOutput
  重试轮次**时才被强制调用；模型直接吐文本 / 文本兜底解析失败时，`output` 是原文
  （`sub-agent.ts` 的 `finalOutput = rawText`），不是 JSON。
- **A3（P2）**：`setupWarnings` 从 worktree 的 `if` 块内局部变量提升到 `run()` 作用域
  （初值 `[]`，创建成功后赋值）。新增 `withWorktreeWarnings(prompt, warnings)`：非空时拼
  「原 prompt + 空行 + `[Worktree 环境告警]` + 逐条 `- ` 告警 + 一行处置要求」，作为
  `sub.execute` 的 prompt；**空告警时逐字节返回原 prompt**，不无条件拼接。
- 原有逐条 `log.warn` 保留，行为不变。

## 放弃了什么（以及为什么不选）

- **否决「schema 非 JSON 时返回一个带错误字段的对象」**：schema 是用户给的，往用户的结果里
  塞实现自定义字段等于伪造数据，而且编排脚本仍然要额外判断。null 是 runtime 已经定义好的
  「失败」语义（`runtime.ts` 只缓存非 null 结果，`parallel/pipeline` 把 null 当失败），复用
  既有契约，不新增一种失败形态。
- **否决「只记原文片段、不记失败字样」或反之**：只记片段时，人扫日志看不出这是失败还是
  普通输出；只记失败字样时，原文彻底消失。两条都进日志才能既判定又溯源。
- **否决「无条件把告警段拼到所有 prompt 上」**（甚至是「无告警时拼一个空段」）：会让所有
  既有 workflow 的 prompt 都发生变化，连带影响子代理看到的任务内容与任何按 prompt 做的比对；
  无告警时保持逐字节相同，把改动面压到「确实坏了的环境」这一种情形。
- **否决「把 setupWarnings 挂到 SubAgentResult 上让编排脚本自己看」**：那要改 runner 契约与
  runtime 的结果形态（`run()` 返回的是 agent() 的最终值），而且**子代理自己仍然不知道**——
  缺陷的本质是干活的那个 agent 看不到自己的环境告警，只能在 pre-commit 失败时反推。
- **与方案文档的一处不一致（按实际代码写）**：方案文档称「追加的告警文本参与
  `computeFingerprint`」，实际不是。`runtime.ts` 约 :334 的
  `computeFingerprint(prompt, opts)` 用的是**脚本传入的原始 prompt**，而拼接发生在
  `SubAgentRunner.run()` 内部（`runtime.ts` 约 :351 `runner.run(prompt, opts, ctx)`），
  resume 缓存键看不到拼接后的文本。后果：同一 (prompt, opts) 的 agent 在「上一次环境没告警、
  这一次有告警」时仍会命中旧 journal 条目并回放旧结果。本次**没有**为此改缓存键——那属于
  runtime 的缓存契约，改它需要单独评估 resume 语义与缓存破坏面，不在本 PR 范围。这是已知残留，
  记录在此供后续排查。

## 拿什么证明它生效了

新增 `packages/core/tests/workflow/sub-agent-runner-schema-warnings.test.ts`（5 条）：

```bash
bun test ./packages/core/tests/workflow/sub-agent-runner-schema-warnings.test.ts
# 5 pass / 0 fail / 12 expect() calls
bun test ./packages/core/tests/workflow/
# 197 pass / 0 fail（12 files）
make build    # 编译产物自检通过
```

日志捕获方式：`initLogger({ enabled: true, level: WARN, logFile: <tmpdir>/debug.log, fileOnly: true })`
后 `getLogger().flush()` 再读盘，并在 `afterEach` 里 `initLogger({ enabled: false })` 复原。
**没有**用 `mock.module` 拦 `getLogger`：logger 是全局单例，`initLogger` 就地 reconfigure 同一实例，
`sub-agent-runner.ts` 每次 `run()` 都现取 `getLogger()`，落盘方案不需要拦模块，也不会与同批
其它测试的 mock 生命周期互相污染；代价只是要显式 `flush()`（`WriteStream` 是用户态缓冲）。

三处变异自证（edit 改坏 → 跑测试 → edit 改回 → 重跑）：

| 变异 | 改法 | 变红的断言与收到的实际值 |
| --- | --- | --- |
| a | schema 非 JSON 分支 `return null` → `return result.output` | `expect(result).toBeNull()`：`Received: "## 汇总\n\n单元 2 已完成，下面是 markdown 而不是 JSON。"` |
| b | 日志去掉 `原文片段: ${result.output.slice(0, 500)}` | `expect(log).toContain(raw.slice(0, 500))`：`Expected to contain: "## 汇总\n\n单元 2 已完成，下面是 markdown 而不是 JSON。"`，`Received: "...[WORKFLOW] [t] schema 输出非 JSON，按失败返回 null。\n"` |
| c | `prompt: withWorktreeWarnings(prompt, setupWarnings)` → `prompt: prompt` | `expect(prompt).toContain("依赖未安装：@sid-code/tui")`：`Received: "原始 prompt 内容"` |

三次改回后均重跑为 5 pass / 0 fail，工作区无残留 `MUTATION` 标记。

已知环境噪音（与本次改动无关，无本文改动文件相关类型错误）：
`bun run typecheck:gate` 在本 worktree 报 27 项新增错误，全部是 worktree 里同一模块被解析成
两种路径（主仓绝对路径 vs `<root>`）导致的类型不等价 + `packages/tui` 依赖未装；
`bunx tsc --noEmit -p packages/core | grep workflow/sub-agent-runner` 为空。
