---
Status: implemented
Date: 2026-11-18
---
# workflow 的 agent() 首参传错时立即报错，别让 8 个子代理静默收到 `[object Object]`

## 决定了什么

一次真实事故（runId `wf_421168c5d5aa`）：脚本把 `agent(prompt, opts?)` 写成单对象形态
`agent({agentType:'verify', prompt: ..., schema: RESULT_SCHEMA})`，整个对象成为 prompt，
8 个子代理全部只收到 `[object Object]`，白跑 6 分钟，运行时**零报错**。四处改动：

1. `packages/core/src/workflow/runtime.ts`：新增 `InvalidAgentPromptError`（继承 `TypeError`），
   `agent()` 入口在 `callCounter++` **之前**校验 `typeof prompt === "string"`。放进
   `isRunFatalError`，所以 parallel/pipeline 不把它吞成 null —— 参数写错是 100% 编写错误，
   落 null 只会让剩下的分支继续白烧。报错文案点明正确签名，并在收到带 `prompt`/`schema`
   字段的对象时直接点名真实误用形态。
2. `packages/core/src/tool/workflow.ts`：`usageGuide()` 里的简写 `agent({schema})` /
   `agent({agentType})` / `agent({model})` / `agent({isolation})` 全部改成 `agent(prompt, {schema})`
   形态。这几处简写是这次误用的**直接诱因**——它的字面形态就是「agent 接受一个对象」。
   同时补一条「并行多单元时传 label」的建议。
3. `packages/core/src/workflow/journal.ts`：`JournalEntry` 新增可选 `promptPreview`，由
   `summarizePrompt()` 生成（取**最后一段**首行——脚本常把共享上下文拼在前面，任务差异在末尾）。
   `runtime` 落盘时不再写默认 `agent#N` 这个 label（无信息量），只在脚本显式传 `opts.label` 时写。
4. `packages/cli/src/command/commands/workflows/workflows.ts`：进度树每行名字改为
   `业务 label > promptPreview > call#N`；标题改为「已落盘 N / 已发起 M」，并在差额 > 0 时
   说明「差额是运行中或返回 null——失败不写 journal」。此前用户看到「已发起 4 / 进度树 2 个」
   以为丢数据，实际是 journal 只记成功结果。

## 放弃了什么（以及为什么不选）

- **只在 sandbox 层加校验**（不放 runtime）：否。`runtime.buildApi()` 也被仓内测试与 SDK 直接调用，
  sandbox 只是其中一条入口；校验放 runtime 才覆盖全部调用路径。
- **让参数错误落 null、脚本继续跑**：否。这正是当前事故的放大机制——8 个 agent 全白跑还拿到
  「成功」的 run 终态。闸门错误穿透是既有设计（预算/上限/中止/phase 对账），参数错误同属这一类。
- **在 journal 里记录完整 prompt**：否。journal 是 append-only 且永久保留，完整 prompt 会让文件
  膨胀数倍；80 字摘要足够让人在进度树里认出「这个 agent 在干什么」。
- **`renderJournalTree` 里按 `agent#\d+` 正则判断默认 label**：是当前方案，作为兼容老 journal 的
  兜底（老记录里存着默认 label）。更干净的做法是只认新字段，但那会让历史 run 的面板继续显示编号。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/workflow/runtime.test.ts ./packages/core/tests/workflow/journal.test.ts ./packages/cli/tests/command/workflows.test.ts` → **60 pass / 0 fail**。
  新增 9 个用例，其中：单对象形态抛 `InvalidAgentPromptError`、parallel 内穿透不吞 null、
  参数错误不占 `callIndex`、`summarizePrompt` 取最后一段、落盘带 `promptPreview` 且默认 label 不写盘、
  面板回退 prompt 摘要并显示「2 个已落盘 / 已发起 4」+「差额 2 个」。
- `bun run affected-tests:run` → **5265 pass / 9 skip / 0 fail**（450 文件）。
- `make build` → 编译成功 + 产物自检 5 项全过。
- `bun run lint` 0 warning 0 error；`bun run typecheck:gate` 62/62 无新增；`bun run docs:gen-reference` 已重生成。
- 事故现场反证：`~/.sid-code/workflows/journals/wf_421168c5d5aa.jsonl` 的 7 条记录 `result` 全是字符串
  （schema 未生效），label 全是 `agent#N` —— 与「整个对象被当 prompt、opts 丢失」的推断一致。
