---
Status: implemented
Date: 2026-10-02
---
# B33：15 个预留 Hook 事件定去留——PermissionDenied 补齐子代理路径，其余 14 个维持预留

## 决定了什么

- `PermissionDenied`：主循环已在 #135 接线；本次补齐**子代理**两条鉴权路径——
  进程内 `agent/tool-executor.ts`（检查器拒绝 + 未配检查器的 fail-closed 兜底）与
  spawn 路径 `agent/sub-agent.ts`。source 只有两档：deny 规则命中 `rule`，其余（dontAsk 降级 / fail-closed）`auto`。
  fire-and-forget + 吞异常，与主循环同名 helper 同策略。
- forked 路径（记忆提取 / dream / session-memory / `/btw`）**刻意不接**，理由写在 `forked-agent.ts` 调用点注释里。
- 其余 14 个预留事件**维持预留**，不删枚举，`hook/types.ts` 的「预留」注释与 `ref/hooks.md` 的 ✗ 照旧如实标注。
- `HookEventName.PermissionDenied` 注释去掉「子代理路径暂未接」，`ref/hooks.md` 重新生成。

## 放弃了什么（以及为什么不选）

- **删掉 14 个预留枚举**：已写进用户配置的事件名会从「不触发」变成「校验 warn」，以后接线还要加回来；页面标 ✗ 已是诚实状态。
- **forked 路径也 fire**：forked 的拒绝来自调用方注入的工具裁剪（`/btw` 每次全拒），是设计内行为，
  fire 出去会让「权限被拒通知到 IM」被内部 side-call 刷屏，信号被噪声淹没。
- **子代理细分 `user` / `hook` source**：子代理结构上没有弹窗通道，填这两档是编的。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/agent/permission-denied-hook.test.ts`：5 pass
  （规则命中=rule / dontAsk 降级=auto / fail-closed=auto / 放行不 fire / hook 抛错不影响拒绝回传）。
- 变异自证：把 `agent/tool-executor.ts` 里 `firePermissionDeniedEvent` 调用换成空操作 ⇒ 3 fail，恢复后全绿。
- `bun run docs:gen-reference` 后 `ref/hooks.md` 仍为 18 / 32 有触发点，`permission_denied` 描述已更新。
