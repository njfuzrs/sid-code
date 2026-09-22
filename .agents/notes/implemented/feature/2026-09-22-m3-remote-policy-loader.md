---
Status: implemented
Date: 2026-09-22
---
# M3 客户端：RemotePolicyLoader 默认链 + 远程 permissions 进 checker

## 决定了什么

把规划里「死代码被记成资产」的四件一次做完，少一件都是假交付：

1. **`RemotePolicyLoader.load()` 真实现**：只读 `SID_CODE_POLICY_ENDPOINT`；非本地 `http://` 拒绝；无凭据 skip + 用缓存；Bearer + ETag/304；5s 超时；204 清缓存当 null；401/5xx/网络 fail-open 回缓存。sanitize 强制 `source=remote`、剥自举字段、`policyLimits` 只留 4 个有 gate 的 key。
2. **默认链** `[RemotePolicyLoader, ManagedFileLoader]`。`cli.ts` / `app.ts` 无参 `new PolicyManager()` 吃到新默认。
3. **远程 `permissions` 进 `RuleLoader.policySettings`**：进程内单例 `remote-policy-state.ts`（对标 policy-limits，避免 checker 环）。`applied` 与「有没有 permissions 对象」分开：空远程 `{source:"remote"}` 也挡住 `loadPolicyFile`，否则本地 managed 的 deny 会从 permissions 通道漏回来。
4. **`scripts/policy-trigger-rate.ts` 同期合入**：分子 `denies_by_rule`、分母 `decisions_same_tools`；B 无 metric 行打印「B 无数据，跳过」而不是 0.0%。

磁盘缓存走 `sidPaths.policyCache()`（`~/.sid-code/policy-cache.json`，0o600），禁止 `join(homedir(), ...)`。

## 放弃了什么（以及为什么不选）

- **轮询 / `setInterval`**：规划原文「轮询先不做」；`supportsPolling` 保留但不启动。生效延迟 = 下次重启。
- **把 endpoint 写进 `settings.json` schema**：减少「远程策略改本地 endpoint」的自举面。本里程碑只读环境变量。
- **checker 直接 import `policy.ts`**：会成环。独立 state 文件与 `policy-limits.ts` 同模式。
- **把远程 JSON 写进 `managed-settings.json`**：会改变文件权限语义，也让「远程 / 本地」分不清。
- **分母用 `listSessions()` 全量**：会稀释信号。A 的分母是同期同 tool 的 audit 决策；相关任务启发式只认 bash PreToolUse / curl|外网|执行命令，不用 defense-trigger-rate 那套「审计核查」词。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/config/remote-policy.test.ts ./packages/core/tests/permission/rule-loader.test.ts ./packages/core/tests/permission/p2-wiring-and-sandbox.test.ts ./tests/scripts/policy-trigger-rate.test.ts` → **51 pass / 0 fail**（空远程挡住 managed deny 后再跑 p2+rule-loader：**28 pass / 0 fail**）
- `bun run affected-tests:run` → **4076 pass / 0 fail**（270 files；空远程用例进集后 +2）
- `make build` 成功；`bun run lint` / `lint:boundary` / `format:check` / `verify:agent-note` 绿
- `bun run docs:gen-reference` 后 `website/ref/env.md` 含 `SID_CODE_POLICY_ENDPOINT`
