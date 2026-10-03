---
Status: implemented
Date: 2026-10-02
---
# MCP transport 合法值改从 Zod 枚举派生（B36）

## 决定了什么

`config/settings/types.ts` 抽出导出常量 `MCPTransportEnum`（stdio / http / http-json / sse / ws），
作为合法值唯一事实源；`config/schema.ts` 的 `VALID_MCP_TRANSPORTS` 改为 `new Set(MCPTransportEnum.options)`，
删掉手写的 stdio/http/sse 三项名单。此前 Zod 与 `mcp/manager.ts` 都支持 ws / http-json，
校验器却报「无效值 "ws"」，照官网 `team/migrate.md` 填就报错（D129）。

顺带把「远程传输必须有 url」从只查 http/sse 扩到全部非 stdio 的合法值：
`manager.ts` 对 http-json / ws 缺 url 同样建连即抛错，校验器之前放行。

## 放弃了什么（以及为什么不选）

- **只在手写名单里补上 ws / http-json**：修了这一次，下一次新增传输方式还会漂移。
  这是继 Hook 事件名（`schema.ts` 注释记录的假告警）之后同一形态的第二例，补名单治不了形态。
- **改文档把 ws 删掉**：文档是对的（运行时真支持），错在校验器。
- **把 schema.ts 里剩下的手写名单全部派生**：只做了有 Zod 枚举的三份
  （`BudgetPeriodEnum` / `BudgetActionEnum` / `SearchBackendEnum`，从 `settings/types.ts` 导出），
  其余四份刻意不动，因为它们的事实源**不是 Zod**，硬套 Zod 反而是把名单对齐到错的源：
  - `VALID_PROVIDERS`：Zod 里 `provider` 是 `z.string()`，真源是 `llm/registry.ts` 的 switch + `replay` 特判；
  - `VALID_PERMISSION_MODES`：已在 B34 ① 处理，且 #145（B27）正在改同一段，动它必冲突；
  - `VALID_EXPORTER_TYPES`：Zod 里没有 telemetry 段，真源是 `telemetry/index.ts` 的 `createExporter` switch；
    `feat/otlp-export-closure` 正在改 `telemetry/types.ts`，现在抽常量会和它冲突；
  - `VALID_BACKEND_TYPES`：真源是 `query/init-helpers.ts` 的分派。
  这两份「对齐实现分支」的名单要派生，正确做法是在实现模块导出常量、switch 与校验器共用，
  属于另一件事，等 OTLP 那条线合入后再做。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/config/schema.test.ts`：46 pass / 0 fail，新增哨兵遍历
  `MCPTransportEnum.options` 逐个过 `validateConfig` 断言无 `mcpServers.*` error。
- 追加三份派生后：65 pass / 0 fail；新增哨兵遍历 period × action 全组合与全部 search backend。
  变异自证：三份集合缩小为子集 → 18 条红，恢复后全绿。
- 变异自证（MCP）：把集合改回 `new Set(["stdio","http","sse"])`，4 条新测试变红
  （http-json、ws、提示文案缺值、缺 url 校验），恢复后全绿。
