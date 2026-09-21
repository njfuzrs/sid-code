---
Status: implemented
Date: 2026-09-21
---
# M1 客户端身份最小可用档：deviceId + 四方落盘 + 凭据文件

## 决定了什么

sid-code 侧落地规划 PR-1.1 / 1.2 / 1.4（客户端可先于平台合入，fail-open）：

1. **PR-1.1**：本机持久 `deviceId`（`~/.sid-code/device-id`，UUIDv4，`0o600`）。损坏 / 为空 / 缺失都重新生成并告警，不静默。`IdentityConfig { userId, orgId, teamId }` 可从 user settings、`managed-settings.json`、环境变量 `SID_CODE_IDENTITY_{USER,ORG,TEAM}_ID`、CLI 按字段 coalesce；项目级 settings 不可覆盖（进 `SECURITY_SENSITIVE_FIELDS`）。`SID_CODE_TRACE_USER_ID` / `_DEVICE_ID` 并存：只覆盖轨迹上传，未显式配时回落到全局 identity。
2. **PR-1.2**：身份与 `ver` 一次落到同一批点——事件 metadata（`_PROTECTED_*`）、轨迹 metadata（`ver` 与 `app_version` 同值并存）、用量账本、hook payload。顺手加 `git_head` / `git_dirty`（离线补不回来）。假后端 `stripProtected: true` 看不到身份字段。
3. **PR-1.4**：`device-credential.json`（文件 + `0o600`，与 API Key 同档，不进 keychain）。过期 / 损坏 fail-open：告警、不带 `Authorization`、不阻断主流程。签发（enroll）仍是平台 PR-1.3 的事。

四方落盘共用 `getIdentity()`，不跟 trace 上传专用变量混，切片才守恒。

## 放弃了什么（以及为什么不选）

- **登录 / 自建账号**：规划明确不做。企业已有账号，多一个密码 = 多一个攻击面。
- **进 keychain**：诚实说明档位是文件 + 权限位。假装进了 keychain 会让运维以为凭据有 OS 级保护。
- **删 `SID_CODE_TRACE_*`**：旧变量是已对外契约。并存 + 回落，不静默换语义。
- **身份走 `getSettings()` 的 policySettings**：那条链仍指向 `/etc/sid-code/policy.json`，跟规划写的 `managed-settings.json` 不是同一份文件。单独读 `sidPaths.managedPolicyCandidates()`。
- **控制面请求现在就带凭据**：enroll 对端（PR-1.3）已合入平台，但 flag / policy 拉取仍是 M2/M3。本 PR 只提供 `applyDeviceAuth()` 与凭据落盘，不把 Bearer 接到还没有的端点上——接到空端点上等于零触发的死接线。enroll 客户端调用留给合入后的跟进，避免本 PR 同时承担签发协议。
- **把 `ver` 改成替换 `app_version`**：消费侧已经在读 `app_version`。两个写同一份值，存量 traj 没有 `ver`。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/identity/ ./packages/core/tests/analytics/feature-flags.test.ts ./packages/core/tests/analytics/sink-privacy.test.ts ./packages/core/tests/hook/g11-events.test.ts ./packages/core/tests/trace/builder.test.ts ./packages/core/tests/trace/collector.test.ts ./packages/core/tests/telemetry/usage-ledger.test.ts ./packages/core/tests/config/settings.test.ts ./packages/core/tests/permission/rule-loader.test.ts ./packages/core/tests/config/sid-home-path-derivation.test.ts` → **258 pass / 0 fail**
- `bun run affected-tests:run` → **3843 pass / 0 fail**（277 files）
- `make build` 成功；`./sid-code --help` 列出 `SID_CODE_IDENTITY_{USER,ORG,TEAM}_ID`
- `bun run docs:gen-reference` 后 `website/ref/env.md` / `settings.md` 含 identity 字段
- `bun run lint` / `lint:boundary` / `format:check` 绿
