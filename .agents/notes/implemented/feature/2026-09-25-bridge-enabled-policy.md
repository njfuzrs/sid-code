---
Status: implemented
Date: 2026-09-25
---
# 远程 bridgeEnabled 经进程内单例关掉 Bridge

## 决定了什么

`PolicySettings.bridgeEnabled?: boolean`。`sanitizeRemotePolicy` 只收 boolean，并把它放进 `ALLOWED_REMOTE_KEYS`。`applyLoadedPolicy` 在来源是 remote 时调用 `setBridgePolicy(policy.bridgeEnabled, true)`，省略就是 undefined；来源不是 remote 时清掉远程结论。

新单例 `packages/core/src/bridge/bridge-policy.ts`：`isBridgePolicyEnabled()` 的顺序是远程值 > `setLocalBridgeEnabled`（本机 settings.json 的 `bridge.enabled`）> undefined。`cli.ts` 的 admission 读这个函数，不再读 `config.bridge?.enabled` 当企业关的来源。

## 放弃了什么（以及为什么不选）

- 写回 `config.bridge.enabled`：总览表里有这一句，执行页 R3 否掉了。`loadConfig` 读 managed-settings 只取 identity，远程字段到不了 Config；写回去还要在启动顺序上保证「先 policy 后读 config」，而单例没有这个时序。
- 把「关 Bridge」做成无认证 flag：flag 端点没有 Bearer。关是约束，走现有 policy 通道；开不需要远程字段。
- 非 boolean（字符串 `"false"`）当 false：和本文件其它布尔字段一样剥掉。字符串真值会被人写成关，实际没关。
- 远程省略时留着上一次的 false：同进程先拿到 false、再拿到一份没这个字段的 200，旧约束会活到进程结束。和 permissions.deny 那次「null 不拨状态」是同一类。

## 拿什么证明它生效了

worktree `feat/bridge-policy-enabled` 先 `bun install`，再：

```
bun test ./packages/core/tests/bridge/bridge-policy.test.ts \
  ./packages/core/tests/config/remote-policy.test.ts
```

30 pass / 0 fail。新用例：`{bridgeEnabled:false}` 对 `wss://` 返回 `policy-disabled`；省略字段 admission 放行；远程 false + 本机 true 仍拒绝；字符串 `"false"` 被剥掉且不丢整份；第二次省略清掉上一次的 false。平台 `ALLOWED_TOP_LEVEL` 不在本仓（见 `02-服务端.md` §6，可并进 6.4）。
