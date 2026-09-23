---
Status: proposed
Date: 2026-09-23
---
# M4 PR-4.2：三类审计事件门面与埋点

## 决定了什么

给 analytics 补三条企业审计漏斗，全部走门面、成功与失败路径都埋：

| 事件 | 回答什么 | 埋在哪 |
| --- | --- | --- |
| `policy_enforced` | M3 配的策略在真实会话里到底生效了吗 | `applyLoadedPolicy(policy, meta)`；outcome 从 loader 链记下的信封来，不从 `policy == null` 猜 |
| `guardrail_triggered` | 护栏拦了几次、其中多少是误报 | `recordDefenseTrigger` 瞬时 `unknown`；60s 同 tool 成功 → `suspected_false_positive`；SessionEnd(`exit`) → `confirmed_true_positive` |
| `context_assembled` | 压缩没发生的那些轮次（缺失的分母） | `query/loop.ts` 在 `getCompactionLevel` 之后、`if (isBlocking)` 之前 |

配套：

- `PolicyManager.load()` 返回值形状不变（测试 / loader 链不改），信封走模块级 `getLastPolicyLoad()` + `loadWithMeta()`。
- `ContextManager.isCalibrated()` 只读 private 字段，热路径禁止再调 `estimateTokens` / `getTokenBreakdown`。
- 哨兵密度 30→33，漏斗表扩成九条，`FACADE_EMITTERS` 加三个新名字。
- `scripts/event-coverage.ts`：分母来自独立信号，分母 0 打印「无数据，跳过」，采样率进 `context_assembled` 分母。

## 放弃了什么（以及为什么不选）

- **改 `PolicyLoader.load()` 返回信封**：会翻 `RemotePolicyLoader` / `ManagedFileLoader` 全部测试与 `runLoaders` 链。信封记在模块级，`load()` 形状不动。
- **给事件加 `event_id`**：幂等在服务端内容指纹（01-契约 §3），加 id 要动 http/disk-cache/otlp。
- **在 4.2 改 `app.ts` 信号路径去调 `runShutdownSequence`**：文件大、退出语义敏感。Ctrl+C 不 flush HTTP 缓冲是已知尾巴 T7，不塞进本 PR。
- **把 `limit.reason` 打进 `guardrail_triggered`**：管理员自由文本（验收文案甚至写 `"M4 验收"`），与 `logPermissionDeny` 同源硬约束。
- **为埋点调用 `getTokenBreakdown()`**：会再遍历一遍消息，热路径禁令。
- **把 4.2a 单独合成 PR**：哨兵「无生产调用点」会红，或阈值不提等于假门禁。
- **布尔误报标记**：客户端无法自动判定误报，用 boolean 会逼代码在不知道时猜一个值。三态 + 延迟回填。
- **60s 匹配挂在 tool-executor 各调用点**：主循环 / 子代理 / forked 三条路径，漏一条就隐身。挂在 `logToolSuccess` 门面里一处覆盖。

## 拿什么证明它生效了

- 故意删掉 `loop.ts` 的 `logContextAssembled` 调用：sentinel 2 fail
  （`uncalled: ["logContextAssembled"]` + 漏斗「上下文组装」缺失）。还原后 8 pass。
- `bun test ./packages/core/tests/analytics/m4-events.test.ts` 等 8 个文件：**117 pass / 0 fail**
- `bun run affected-tests:run`：**5181 pass / 0 fail**（378 files）
- `bun run lint` / `lint:boundary`（越界 0）/ `format:check` 全绿
- `make build` 成功；grep `will always be undefined` 无命中
- `SID_CONFIG_DIR=/tmp/... bun scripts/event-coverage.ts --limit 20` 三类均打印「无数据，跳过」，JSON `skipped: true` / `coverage: null`，不是 100%
