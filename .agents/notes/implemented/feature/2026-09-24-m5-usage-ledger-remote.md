---
Status: implemented
Date: 2026-09-24
---
# M5 PR-5.1：账本远程 upsert 出口 + 对账 --threshold

## 决定了什么

把本地 `upsertUsageLedger` 做成远程账本的**唯一漏斗**：写盘成功后 fire-and-forget `POST $SID_CODE_USAGE_ENDPOINT`，body 是整行 `UsageLedgerEntry`。

- 鉴权抄 M4：`applyDeviceAuth` + `isNonLocalHttp`。无凭据 / 明文非本地 / 401 **不写失败盘**。5xx / 网络按 sessionId **覆盖**写 `failed-usage-ledger.jsonl`（不是 append），且**不 24h 过期**。
- 失败盘跨会话重放挂在 `initTelemetrySystem`（与 events `recoverFromDisk` 同款 fire-and-forget）。
- 成功路径暴露 `onUsageLedgerRemotePushed`，给 PR-5.2 刷新预算用；本 PR 不接 loop。
- `pricing-reconcile.ts` 加 `--threshold`（缺省仍 0.1）；untrusted host 进「可解释排除」段，打印 n 与 host 名单，不进偏差分子分母。

## 放弃了什么（以及为什么不选）

- **复用 events `HttpExporter`**：body 是 `{events:[]}`、失败盘 append。账本 latest-wins，重放旧快照会把云端 `used_usd` 回退。
- **在 `app.ts` 两处调用点各发一次**：漏一处 = 长驻 REPL 云端永远 $0（本地账本曾经的缺陷）。
- **改默认阈值 10%→5%**：会把既有用法变成失败。验收显式传 `0.05`。
- **失败盘 24h 过期**：events 丢一条是计数 -1；账本丢一行是该会话云端永久 $0。
- **本 PR 改 `loop.ts` / 远程预算**：那是 5.2 的回滚粒度。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/telemetry/usage-ledger-remote.test.ts ./packages/core/tests/telemetry/usage-ledger.test.ts ./tests/scripts/pricing-reconcile.test.ts` → **40 pass / 0 fail**
- `bun run affected-tests:run` → **4775 pass / 0 fail**（344 files）
- `make build` 成功；`bun run lint` / `lint:boundary` / `format:check` / `verify:agent-note` 绿
- `bun scripts/pricing-reconcile.ts --help` 含 `--threshold`；`website/ref/env.md` 含 `SID_CODE_USAGE_ENDPOINT`
