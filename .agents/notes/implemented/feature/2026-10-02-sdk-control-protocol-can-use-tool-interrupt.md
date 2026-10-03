---
Status: implemented
Date: 2026-10-02
---
# SDK 双向流接通 `can_use_tool` 与 `interrupt`，其余控制请求回明确错误（B25）

## 决定了什么

`--input-format stream-json --output-format stream-json` 下：

1. **`can_use_tool`（CLI → 宿主）**：权限检查判出 ask 时，不再按「非交互」就地 deny，
   而是经 `createSDKCanUseTool` 发 `control_request` 问宿主，带真实 `tool_use_id`。
   接法是复用既有的 ask 通道（`App.requestUserConfirmation`，与 Bridge 同一入口），
   `PermissionChecker.setExternalAskChannel(true)` 让 `isNonInteractive()` 返回 false。
   宿主 deny / 回 error / 60s 不答 / 关 stdin / 本轮被 interrupt，一律按拒绝闭合（fail-closed）。
   `always_allow` 记入会话内权限记忆。
2. **`interrupt`（宿主 → CLI）**：abort 当前轮（reason `user-cancel`，已在 `ABORT_REASONS`），
   立即换新 `AbortController` 让会话继续，回 `control_response: success`。
3. **其余请求**（`initialize` / `set_model` / `get_context_usage` / `mcp_message`）回
   `control_response: error`「未实现」，不再静默丢弃。

两处连带修复，不修则上面两条在生产里仍不会发生：

- `runHeadlessStreaming` 改成**后台泵并发读 stdin**。旧实现先跑完初始 prompt 才开始读，
  第一轮里的 `control_response` 与 `interrupt` 都要等这一轮结束才被读到，等于永远读不到。
- `StructuredIO.read()` 在 EOF 时 reject 全部未决请求，之后的 `sendRequest` 直接 reject，
  宿主断开时不必挂满 60s 超时。
- `cli.ts` 的空 prompt 校验对 stream-json 输入放行：宿主常常先发控制请求、再经 stdin 发首条消息。

## 放弃了什么（以及为什么不选）

- **实现 `set_model` / `get_context_usage` / `mcp_message` / `initialize`**：价值低，按整改清单只做两个；
  回明确错误让宿主知道，比假装支持好。
- **把 PreToolUse Hook 传给 `createSDKCanUseTool` 做竞速**：走到 ask 通道时 PreToolUse 已在
  tool-executor 里 fire 过（`preToolUseCache`），再传会 fire 两次。函数保留 `hookSystem` 参数给直接嵌入方用。
- **只有 `--output-format stream-json`（stdin 不是 stream-json）也开 ask 通道**：没有回路，宿主读不到也答不了，
  会挂到超时再 deny。维持原 fail-closed。Harbor 适配器正是这种用法，因此不受影响。
- **interrupt 直接 abort 会话级 controller 不换新**：下一条 user 消息一开轮就拿到已 aborted 的 signal。

## 拿什么证明它生效了

- `packages/cli/tests/sdk/sdk-control-protocol-e2e.test.ts`：spawn 真实 `bootstrap.ts`，本地假 OpenAI 兼容服务，
  真实 NDJSON。3 pass：`can_use_tool` 发出且 `tool_use_id=call_deny_1`；deny 后文件不存在、模型收到拒绝；
  allow 后文件内容为 `hello`；`set_model` 回 error；不答就关 stdin 时很快退出且不写文件；
  interrupt 回 success、5s 内出 result、未触发重试、下一轮正常。
- 变异自证：注释掉 `this.sdkCanUseTool = createSDKCanUseTool(...)` → 1 pass / 2 fail；
  注释掉 `handlers.onInterrupt?.()` → interrupt 用例 fail。第二个变异最初**照样全绿**
  （挂住的流约 16s 后被心跳超时杀掉并重试，重试吃掉下一条回复也产出 result），
  所以补了「5s 内 + 只有 1 次请求 + result 不是下一轮文本」三条断言后才变红。
- 手跑：`set_model` + `interrupt` 两条控制请求 → 两行 `control_response`（error / success），rc=0。
