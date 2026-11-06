---
Status: implemented
Date: 2026-11-06
---
# 命令上下文 sessionId 取逻辑会话 id，而非空串或进程 id

对应《20261106-无头模式斜杠命令放行-现状缺陷与分档方案》§六 **T1**（缺陷 D1）。

## 决定了什么

`packages/cli/src/app.ts` 两处 `CommandContext` 构造点的 `sessionId` 从空串改为
`this.getLogicalSessionId()`：

- `resolveHeadlessSlash` 的无头 cmdCtx（`-p` / stream-json / Bridge 三形态共用）；
- TUI `onSlashCommand` 的 cmdCtx。

改动只有这一行 ×2（加注释）。`trace` / `perf` / `insights` / `compact` 四个命令**保持**读
`ctx.sessionId`，一行没动。新增门禁 `packages/cli/tests/app/cmdctx-session-id-wiring.test.ts`
锁住正向（两处用逻辑 id）与反向（不得写空串、不得写 `this.sessionState.sessionId`；
四个命令不得改读 `ctx.sessionState.sessionId`），并锁住「逻辑 id = 轨迹目录口径」的论证链
（`getLogicalSessionId` 实现、`collector.ts` 的 `traceSessionId`、`writer.ts` 的目录名）。

受益面：`/trace` `/perf` `/insights` 能定位当前会话（不再回退 latest 或报「未找到会话」）、
`/compact` 的埋点带对 session_id、`/export` `/bug` `/status` `/fork` 不再丢会话 id。
无头三形态与 TUI 同时修好——TUI 原先也传空串，`/fork` 因此恒报「会话 ID 未知」。

## 放弃了什么（以及为什么不选）

- **方案文档 D1 表格里的「`trace`/`perf`/`insights`/`compact` 改读 `ctx.sessionState.sessionId`（进程 id）」——否决。**
  该表的前提「轨迹目录名 = 进程 id」经回源码核实不成立。实际口径是
  `collector.ts` SessionStart 的 `traceSessionId = isResume ? input.resumed_from! : input.session_id`，
  `writer.ts` 用它建 `sessions/<id>/`，`listSessions()` 返回的 id 就是目录名。`resume` 时它是
  **被恢复会话的旧 id**，非 resume 时才等于进程 id —— 恰好就是 `getLogicalSessionId()` 的取值。
  若按该表把四处改成进程 id：`-c` 恢复后 `/trace` 拿进程新 id 去比对名为旧 id 的目录，永远匹配
  不上，只能回退 latest（并发时会话选错），比修之前更隐蔽。反向门禁已把这条钉死。
- **只改四处命令、不改 app 层**：空串的源头在两处 cmdCtx 构造点，改消费端是治标——下一个新增
  命令照样拿到空串。而且 `ListCommandResult` 里没有任何东西会在空串时报错，缺陷会继续静默。
- **把 `getLogicalSessionId` 拆成两个 id 供不同命令取用**（方案文档 2026-11-06 首版修订的思路）：
  核实后没有必要。8 个受影响命令要的都是同一个「逻辑会话 id」——`export`/`bug`/`status`/`fork`
  写会话 jsonl 口径（`app.ts` 拼 jsonl 路径用的就是它），`trace`/`perf`/`insights`/`compact`
  写轨迹目录口径（同上）。一个 id 覆盖两种用途，拆开反而制造两套事实。
- **顺带修 `/debug`**：`debug.ts:19` 用 `ctx.sessionState.sessionId`（进程 id）定位快照，
  按同一论证应当也是逻辑 id 更对。但它不在 T1 的 8 个命令范围内、且 `/debug` 属 C 档不放宽，
  本次不动，留给后续单独核实（避免顺手扩大 PR 范围）。

## 拿什么证明它生效了

- `bun test ./packages/cli/tests/app/cmdctx-session-id-wiring.test.ts` → **12 pass / 0 fail**。
- 变异自证两轮（仓库铁律）：
  1. 把 app.ts 两处 `sessionId: this.getLogicalSessionId(),` 改回 `sessionId: "",` → 该文件
     **10 pass / 2 fail**（「两处都注入 getLogicalSessionId」与「两处都不再是空串」变红），
     随后恢复、`grep -c 'sessionId: ""'` 为 0；
  2. 把 `trace.ts` 的 `ctx.sessionId` 全量替换为 `ctx.sessionState.sessionId` → 反向门禁
     「trace.ts 读 ctx.sessionId，不读 ctx.sessionState.sessionId」**变红**，随后恢复。
- 「轨迹目录名 = 逻辑 id」这一前提由既有测试独立覆盖：
  `packages/core/tests/trace/writer.test.ts:32-33`（目录名 = 传入 id）、
  `packages/core/tests/trace/collector.test.ts:1998-2041`（resume 复用 `resumed_from` 目录、
  不建新进程 id 目录）。
- `bun run affected-tests:run` 与 `make build` 结果见 PR 正文。
- ⚠️ 未做：真实 `-c` 会话下跑 `/trace` 观察命中（需要一条已落盘的 resume 链）。端到端行为
  验证留到 T3 放行这批命令后，用方案文档 §7.1 的 stream-json 两轮命令一并验。
