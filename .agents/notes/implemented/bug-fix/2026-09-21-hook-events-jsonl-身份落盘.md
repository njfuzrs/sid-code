---
Status: implemented
Date: 2026-09-21
---
# hook events.jsonl 身份落盘：从 HookInput 类型补到磁盘行

## 决定了什么

PR-1.2 把 `device_id` / `user_id` / `org_id` / `team_id` 写进了内存里的 `HookInput`，轨迹侧 `events.jsonl` 走另一套 `HookEvent`，序列化时把字段丢掉了。真实会话 17 行全空。

本 PR：

1. `HookEvent` 加与 `HookInput` 同名的可选顶层字段，不进 `data`。
2. collector 用私有 `appendHookEvent` 收口全部 `appendEvent`（含 stream-observer 回调、RetryTelemetry、TurnError），从 `this.metadata` 注入身份。writer 自己不调 `getIdentity()`。
3. 缺省不写空串，与账本一致。
4. 单测读磁盘行，不再只 assert 内存对象 / traj metadata。

不回填历史 `events.jsonl`。不新开外发通道。

## 放弃了什么（以及为什么不选）

- **19 处逐个抄身份字段**：会漏。stream-observer 回调是另一条总线，逐个抄正好漏掉崩溃诊断那几行。
- **writer.appendEvent 里调 getIdentity()**：writer 是 IO，身份是会话状态。放 collector 才能与 traj metadata 同一份（hook input 可覆盖）。
- **把身份塞进 `data`**：消费方要能一眼区分会话身份和事件附加数据。规划明确不做。
- **绑进 M2 Flag PR**：Flag 走控制面，不读 hook `events.jsonl`。本缺口是客户端小修复。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/trace/collector.test.ts` → **88 pass / 0 fail**
- `bun run affected-tests:run` → **636 pass / 0 fail**（33 files，`./packages/core/tests/trace/`）
- `make build` 成功（worktree 须先 `bun install`，不能软链主仓 `node_modules`：那会让 `bun build` 编进主仓 `@sid-code/core`，`strings` 里没有新收口，真实会话 16 行仍空）
- 真实会话 `20260921-151515-4669d35e`（worktree `./sid-code -p --max-turns 1`，注入 `SID_CODE_IDENTITY_{ORG,USER,TEAM}_ID`）：`events.jsonl` 16 行，SessionStart / BeforeModel / SessionEnd 顶层 `device_id` 全部 = `~/.sid-code/device-id`（`e95dc36f-a8eb-4e12-a072-ff3eec3bf4f1`），`org_id=e2e-lab` / `user_id=e2e@lab.local` / `team_id=probe`；`data` 里没有身份键
- 对照：补丁前会话 `20260921-134107-7426ff51` 17 行零身份，不回填
