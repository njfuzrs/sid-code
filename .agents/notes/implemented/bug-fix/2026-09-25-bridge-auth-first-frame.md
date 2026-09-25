---
Status: implemented
Date: 2026-09-25
---
# Bridge token 迁出 query，改连接后首帧 auth

## 决定了什么

`WebSocketBridgeTransport.connect()` 不再把 `authToken` 拼进 URL。连接前用 `stripTokenQuery` 剥掉调用方误写进 URL 的 query/hash（路径与大小写不动），`onopen` 后发送 `{type:"auth", token, role:"cli"}`。`auth_ok` 之前：不触发 `onConnect`、不启动心跳、`isConnected()` 为 false、其它入向帧丢弃。无 token 仍允许连，由中继 4001。`auth` / `auth_ok` 不进 `BridgeOutMessage` / `BridgeInMessage`。

`BridgeRunner` 订 `setOnPermanentFailure`。`start()` 在 4001/4003/1008 时抛错；常驻期间 `waitForPermanentFailure()` 通知 `App.runBridge`，stderr 打关闭码人话并以 exit code 1 结束。`stop()` 取消尚未完成的等待，避免 Ctrl+C 后 Promise 挂住进程。

## 放弃了什么（以及为什么不选）

- `Sec-WebSocket-Protocol`：子协议值仍在握手头里，S1 要修的就是凭证进 access log。见 M6 `01-契约.md` §2.2。
- query 与首帧双栈：双栈期间日志里照样有 token，等于没修。
- 客户端在无 token 时先拒绝：拒的职责在中继。客户端多一道会让「中继没开鉴权的开发回环」连不上，而今天无 token 本来就允许连。
- 复用 `normalizeBridgeUrl` 当连接 URL：它还做尾斜杠与小写归一，是信任键，拿来握手会连到另一个路径。
- 在 `onopen` 就算已连接：对端还没验完，`BridgeCore.send` 会把业务帧提前送出去。
- 250ms 轮询永久失败：把「立刻退出」变成「最多等 250ms」，且正常退出要记得清 timer。改成 waiter，`stop()` 取消。
- 把 `auth` 加进消息闭集：加上就会有人从 `BridgeCore.send` 再发一次握手帧。

## 拿什么证明它生效了

在 worktree `fix/bridge-auth-first-frame` 跑：

```
bun test ./packages/core/tests/bridge/ws-transport-auth-frame.test.ts \
  ./packages/core/tests/bridge/ws-transport-resilience.test.ts \
  ./packages/core/tests/bridge/ws-transport.test.ts \
  ./packages/core/tests/bridge/bridge-runner-permanent-failure.test.ts
```

32 pass / 0 fail（1.4.2，2.06s）。新用例锁住：握手 URL 不含 `token=` 与 secret；第一帧 `type==="auth"`；`auth_ok` 前的 `user_message` 不进 `onData`；4001 后 1.3s 内只有一次握手；`BridgeRunner.start()` 对 4001/1008 拒绝；`types.ts` 闭集不含 `"auth"`。真实中继抓包不在本 PR（中继是 PR-6.4，见 `05-验收.md`）。
