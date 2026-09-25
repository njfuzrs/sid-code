---
Status: implemented
Date: 2026-09-25
---
# daemon webhook 无 secret 拒绝，签名用 timingSafeEqual

## 决定了什么

`packages/core/src/daemon/server.ts` 的 `verifySignature`：`secret` 为空返回 false，不再当开发模式放行。期望值与请求头都先比长度，不等就 false（`timingSafeEqual` 在长度不等时会抛，不能让它变成 500）。长度相等才 `timingSafeEqual`。

`daemon.ts` 原有的「无 secret 且未显式开 → 不监听」不动。本文件 `import.meta.main` 仍可能裸起，裸起且无 secret 时所有 webhook 401，不再 fork agent。

## 放弃了什么（以及为什么不选）

- 继续 `expected === signature`：非常量时间，且和「无 secret 放行」绑在同一段。S4 点名的就是这两处。
- 把无 secret 的拒绝挪到 `daemon.ts` 就收工：那条已经在。裸起 `server.ts` 的路径不经过它，不改这里就还有一个 fail-open。
- 和 Bridge 绑同一个 PR：这是本地 GitHub webhook，不是中继。绑在一起，回滚 HMAC 会连带回滚遥控。
- 导出 `verifySignature` 单测纯函数：生产合同是 HTTP 401/202。只测函数会让「401 响应没接上」全绿。

## 拿什么证明它生效了

worktree `fix/daemon-webhook-hmac` 先 `bun install`，再：

```
bun test ./packages/core/tests/daemon/webhook-signature.test.ts
```

6 pass / 0 fail。无 secret 即使带了别的 secret 签出来的头也 401；空签名 401；`sha256=abcd`（长度不等）401 且进程不抛；错一位 401；别的 secret 401；正确签名 202。正确签名会让 worker 异步去 clone，测试在断言后 `stop(true)`，不等那个 promise。
