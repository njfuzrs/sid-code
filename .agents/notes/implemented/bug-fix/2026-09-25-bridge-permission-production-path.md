---
Status: implemented
Date: 2026-09-25
---
# Bridge 权限确认接到 App.requestUserConfirmation

## 决定了什么

`PermissionChecker` 增加 `hasBridgePermissionDelegate()` 与 `requestBridgePermission()`。`App.requestUserConfirmation` 在有代理时先问它，返回值决定 confirmed，remember 仍为 false；没有代理才走原来的 TUI 回调，再否则 `permissionMode === "always-allow"`。`tool-executor` 的调用点不动。

`PermissionProxy` 超时 `resolve(false)` 之后再写一条 `status`，`data.status = "permission_expired"`，`request_id` 等于原请求 id。写出失败吞掉。

`checkBridgeAdmission` 每个拒绝结果调用 `recordDefenseTrigger("bridge_admission", "blocked", { reason })`。`DefenseLayer` 加上 `bridge_admission`。放行不记。reason 只用闭集，不带 URL。

## 放弃了什么（以及为什么不选）

- 复活 `requestConfirmation` 当生产入口：全仓零调用。去修它是在修死代码，tool-executor 仍不会进来。
- 改 `tool-executor` 去调 `checker.requestConfirmation`：那是热路径，本里程碑要的是 Bridge 分支，不是重接确认策略。
- 把放行也记成 `recovered`：那个 outcome 是「从拦截态恢复」。准入放行不是防线动作，记进去会把允许伪装成触发。
- 为 admission 新开第四类 analytics 事件：M4 只批了三类。`recordDefenseTrigger` 已经会发 `guardrail_triggered`，layer 名够区分。
- 把 raw URL 写进事件：调用方传入的 URL 可能还带着 token。

## 拿什么证明它生效了

worktree `fix/bridge-permission-wiring` 先 `bun install`（否则 `@sid-code/core` 向上解析到主仓，新方法是 undefined）再 `bun run vendor:fetch`。然后：

```
bun test ./packages/cli/tests/app/bridge-confirmation.test.ts \
  ./packages/core/tests/bridge/permission-proxy.test.ts \
  ./packages/core/tests/bridge/admission.test.ts
```

31 pass / 0 fail。App 用例：delegate 返回 true/false 决定 confirmed，且 always-allow 盖不过 false；无 delegate + default 仍立刻 false。代理超时用例看到 `permission_expired` 与 request id 对齐。准入用例：明文拒绝记一条 `blocked` / `insecure-scheme`，属性里没有 URL 与 token；已信任的 wss 放行不再加一条。真实会话「管理台点拒绝」不在本 PR（要中继，见 `05-验收.md`）。
