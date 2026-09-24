---
Status: implemented
Date: 2026-09-24
---
# M5 PR-5.2：远程预算加载器与远程超限分支

## 决定了什么

新增 `packages/core/src/telemetry/remote-budget.ts`，形状对标 M3 的 `RemotePolicyLoader`，
但**完全独立于 `PolicySettings`**：端点只读 `SID_CODE_BUDGET_ENDPOINT`，缓存独立落
`~/.sid-code/budget-cache.json`（0o600）。

- `GET` + `applyDeviceAuth` + `If-None-Match`，超时 5s。200 写缓存；**304 沿用缓存的
  `used_usd`**，靠乐观估计补本会话增量；204 记负缓存；401 / 5xx / 超时 / 明文非本地 /
  无凭据一律 **fail-open（当没配远程预算）**。
- `enforcement` 只认 `alert | block`，其他值当 `alert` —— fail-open 方向是「不认识就不硬停」。
- **自举**：远程 body 里的 `budgetEndpoint` / `endpoint` / `SID_CODE_BUDGET_ENDPOINT`
  一律剥掉，远程不能改自己的端点。
- **双计窗口**（R6）落成纯函数 `estimateRemoteBudgetUsed`：
  `lastPushedSessionId === currentSessionId` 时 `used − lastPushedCost + currentCost`，
  否则 `used + currentCost`，为负当 0。`lastPushed*` 由 5.1 暴露的
  `onUsageLedgerRemotePushed` 钩子喂；每次成功 upsert 后节流 30s 再 GET 刷新 `used`。
- 接线三处：`cli.ts` 与 `init-helpers.ts` 启动各拉一次（未配 endpoint 时零操作）；
  `loop.ts` 在**本地 BudgetTracker 与 QuotaManager 之后**加第三段 ——
  `alert` 只 `yield` warning 不结束会话，`block` 才与本地 exceeded 同款 terminal + done。

## 放弃了什么（以及为什么不选）

- **把 `quota` / `costLimit` 塞进 `ALLOWED_REMOTE_KEYS`**（R4）：要改 M3 已验收契约，
  且与权限缓存绑死。独立 endpoint + 独立缓存换来的是「不配就等于没这功能」的回滚粒度。
- **把远程 `used_usd` 写进 `QuotaManager` 复用 `check()`**（R5）：`costLimit` 是会话级、
  远程是 org 月度，混进一个对象分母就没了。
- **经 `BudgetTracker.recordCost` 累远程 used**（R6）：服务端已 SUM 过账本，本地再加
  本轮就是双计。
- **改本地 `costLimit` 硬停默认**（R5）：评测容器与个人配置依赖它止血，远程默认只告警。
- **远程默认 `block`**：误配一个小数字会硬停全公司。`alert` 是 fail-open 方向的默认。
- **`裸 src.includes("loadEnterpriseBudgetOnce")` 作接线门禁**：变异自证时它在把调用改名成
  `loadEnterpriseBudgetOnceXXX` 之后**仍然绿**（子串命中）—— 已改成匹配调用形态的正则。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/telemetry/remote-budget.test.ts` → **22 pass / 0 fail**
- 五路测试合跑（remote-budget + usage-ledger-remote + usage-ledger + 路径派生 + identity
  + pricing-reconcile）→ **101 pass / 0 fail**
- **接线门禁变异自证 5/5 全红**（防死加载器）：① cli 调用改名 → `cli.ts 启动路径` 红；
  ② loop 的 `checkLoadedRemoteBudget(` 改名 → 红；③ 把 `enforcement === "block"` 分支
  改成 `if (false)` → 红；④ init-helpers 去掉 `await loadEnterpriseBudgetOnce()` → 红；
  ⑤ 把 `成本配额检查` 标记改名（顺序变异）→ 红。复原后 22 pass / 0 fail。
- `bun run affected-tests:run` → **4797 pass / 0 fail**（345 files，56.06s）
- `make build` 成功，`grep -iE "will always be undefined|warn|error"` **零命中**；
  `strings sid-code | grep -c "checkLoadedRemoteBudget\|loadEnterpriseBudgetOnce"` = **5**
  （新导出确实进了产物，不是被 tree-shake 掉的死码）
- `bun run lint` / `lint:boundary`（越界 0 处）/ `format:check` 全绿
- `website/ref/env.md` 含 `SID_CODE_BUDGET_ENDPOINT`（`docs:gen-reference` 重新生成）
