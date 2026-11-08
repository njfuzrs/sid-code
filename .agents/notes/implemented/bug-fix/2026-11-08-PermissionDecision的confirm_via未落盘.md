---
Status: implemented
Date: 2026-11-08
---
# `PermissionDecision.confirm_via` 从未落进 events.jsonl：collector 漏了字段映射

## 决定了什么

`TraceCollector.handlePermissionDecision` 补一行 `...(e.confirmVia ? { confirm_via: e.confirmVia } : {})`。

缺陷形态是「上下游全对，断在中间那一行」：

- 生产端：`App.requestUserConfirmation` 按通道 `setConfirmVia("bridge" | "tui" | "sdk" | "headless")`；
- 消费端：`logPermissionAllow` / `logPermissionDeny` 在 `needsPrompt && source === "user"` 时 `consumeConfirmVia()`，放进 `PermissionDecisionEvent.confirmVia`；
- collector 把事件转成 `events.jsonl` 时逐字段映射，**唯独没映射 `confirmVia`**。

`permission-confirm-via.test.ts` 的 6 条用例都断言到观察者入参为止，所以全绿。2026-11-08 写 G2 用例 A12（bridge）时，用桩 WS 服务跑构建产物探针，发现 allow 和 deny 两个方向的 `PermissionDecision` 都没有 `confirm_via`。触发清单 A12 的判据「`PermissionDecision.confirm_via=bridge`」此前从未成立过。

新增 `packages/core/tests/trace/permission-decision-confirm-via-landing.test.ts`，走真 collector 落盘：人工确认的 allow / deny 带 `confirm_via`，规则放行的不带这个 key。

## 放弃了什么（以及为什么不选）

- **改 `permission-confirm-via.test.ts` 让它读 events.jsonl**：不改。那份测的是 App 层「走哪条分支设哪个通道」，换成落盘断言要起完整 collector，会把两层判据搅在一起。落盘单独一个文件，各守一段。
- **在本 PR 里一起落 A12 G2 用例**：拆开。A12 要改 `tests/smoke/lib/runner.ts`（加 WS 桩），与在途的 #667 同文件；先合这条一行修复，A12 等 #667 合入后再做。A12 用例会把这条修复再守一遍（端到端）。

## 拿什么证明它生效了

- 新单测：修复后 1 pass；删掉这一行 → 1 fail（落盘的 `confirm_via` 为 undefined）。
- 构建产物 + 桩 WS bridge 探针（`--bridge ws://127.0.0.1:<port> --bridge-insecure`，预置 `state/trusted-bridge-urls.json`）：
  - 修复前：`BridgePermission{decision=allow|deny}` 有，`PermissionDecision` 无 `confirm_via`；
  - 修复后：allow / deny 两向都是 `PermissionDecision{prompted=true,source=user,confirm_via=bridge}`，allow 时 `trash.txt` 被删，deny 时仍在。
- `bun run affected-tests:run`、lint、typecheck:gate 全绿（见 PR 描述）。
