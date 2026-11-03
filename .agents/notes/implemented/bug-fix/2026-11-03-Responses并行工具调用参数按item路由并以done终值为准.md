---
Status: implemented
Date: 2026-11-03
---
# Responses 并行工具调用：每个调用独占 index，参数以 done 终值为准

## 决定了什么

`packages/core/src/llm/openai-responses.ts` 的流式解析器改为按块路由：

- 每个 function_call 在 `output_item.added` 时分配**自己的** content block index（`ToolCallState.index`），
  参数增量按 `item_id`（缺席时回落 `output_index`）路由到该 index。正文块、思考块同样各自分配，
  不再共用一个全局 `blockIndex` 计数器。
- 收尾以**权威完整参数**为准：`function_call_arguments.done.arguments`，其次 `output_item.done.item.arguments`，
  两者都缺才用已累积增量（`response.completed` 时兜底收尾）。终值以已发增量为前缀时补发剩余后缀；
  不是前缀时经 `content_block_stop.tool_use.input_json` 让消费方整段替换并打 warn。
- `StreamEvent.content_block_stop.tool_use` 新增可选 `input_json`，四个消费方
  （`query/stream-processor.ts`、`agent/stream-processor.ts`、`agent/forked-agent.ts`、`cli/entrypoints/headless.ts`）
  在 stop 时优先采用它。
- 不再要求 `output_item.added` 的 `item.name` 非空才开块；done 先于 added 时补开块；同一调用两个 done 只收尾一次。

事故：会话 `20261103-153824-062a9640`（gpt-6.1-sol @ code.ppchat.vip）中，所有并行工具调用轮的参数都是 `{}`，
被 F1 空参数检测作废重试 3 次；单调用轮全部正常。实测该网关并行时**只发 `arguments.done`、不发 `arguments.delta`**，
而旧解析器从不读 done 上的 `arguments`。

## 放弃了什么（以及为什么不选）

- **请求里设 `parallel_tool_calls: false`**：能绕开症状，但牺牲「更快」（并行读文件/搜索变成串行多轮），
  而且没有修掉解析器丢数据这件事 —— 别的网关用同样形态发单调用（只发 done）时照样会丢。否决。
- **只在 done 时补发增量、保留全局 blockIndex**：修了「只发 done」的形态，但增量交错到达时多段 JSON
  仍被拼进同一个块（复现：`start#0 start#0 delta#0 delta#0 stop#0 stop#1`）。治标不治本，否决。
- **让消费方改用「按 tool_use id 累加」**：要改四个消费方的累加模型，牵连 stream_restart 契约；
  而问题出在 provider 层没遵守「一个块一个 index」的约定，应在 provider 层修。否决。
- **矛盾时以增量为准**：规范定义 done 的 `arguments` 是完整参数，增量只是流式预览；以预览为准没有依据。

## 拿什么证明它生效了

- 真实网关抓包：用 gpt-6.1-sol 的配置向 `code.ppchat.vip/v1/responses` 发并行调用请求，原始 SSE 为
  `added#0 → arguments.done#0 → item.done#0 → added#1 → arguments.done#1 → item.done#1 → completed`，零 delta。
  裁掉元数据后落为夹具 `packages/core/tests/fixtures/vcr/responses-parallel-tools-done-only.json`。
- 新测试 `packages/core/tests/llm/responses-parallel-tool-args.test.ts`（10 例，走 解析器 → 主循环/子代理两个消费方 端到端）：
  修复后 10/10 绿。
- 变异自证 ①：把解析器换回 `origin/main` 版本 → 8 fail / 2 pass（通过的 2 例是旧的逐个调用形态，修前就正常）。
- 变异自证 ②：主循环消费方去掉 `input_json ??` → 「增量与终值矛盾」一例变红。
- 既有 Responses / stream-restart / provider-parity 等 9 个测试文件 111 pass 0 fail。
- 端到端实跑：worktree 构建的二进制 `./sid-code -p -m gpt-6.1-sol`，提示词要求同一回复并行发 read×2 + glob。
  会话 `20261103-163842-c919c9b8` 第 1 轮 3 个 tool_use 参数全部完整（file_path / pattern 均在），第 2 轮 end_turn
  正确报告两份文件内容与匹配数；`warn.log` 中「F1：检测到空参数」0 次（修前事故会话 3 次）。
- 后续观测口径：gpt-6.1-sol 会话 `warn.log` 中「F1：检测到空参数 tool_use」应持续为 0。
