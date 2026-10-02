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
- **顺手把 schema.ts 里其它手写 `new Set([...])`（budget period/action、search backend 等）一起派生**：
  它们目前与 Zod 一致、不在本任务范围，且部分名单刻意对齐的是实现分支而非 Zod
  （如 telemetry exporter），混进来会扩大 review 面。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/config/schema.test.ts`：46 pass / 0 fail，新增哨兵遍历
  `MCPTransportEnum.options` 逐个过 `validateConfig` 断言无 `mcpServers.*` error。
- 变异自证：把集合改回 `new Set(["stdio","http","sse"])`，4 条新测试变红
  （http-json、ws、提示文案缺值、缺 url 校验），恢复后全绿。
