---
Status: implemented
Date: 2026-10-21
---
# 子代理权限检查器漏注入修复：workflow 与 send_message 两处 + skip 泄漏收紧

## 决定了什么

修掉缺陷方案「20261021-子代理权限检查器漏注入」的 P0-1 / P1-1 / M-1，外加复核 5.2 时新发现的 skipPermissions 泄漏：

1. **P0-1**：`SubAgentRunnerOptions` 加 `permissionChecker` 字段，runner 在 `fromRegistry` 之后注入；`WorkflowTool` 实现 `setPermissionChecker` 并透传给内部 runner。`isolation:'worktree'` 的子代理额外按 worktree 目录 `deriveForWorkspace` 派生（对齐 agent/tool.ts 的 W22 先例）。
2. **P1-1**：`SendMessageTool` 实现同样 setter，resume 分支在 `fromRegistry` 之后注入。
3. **M-1（防复发）**：`ToolCapabilityFields` 加可选 `needsPermissionChecker` 声明（对齐 `exemptFromLoopDetection` 自报范式），7 个子代理入口工具全部自报；`App.wireToolPermissionChecker` 对账——声明了却没实现 setter 就 `log.warn`（此前鸭子类型探测静默跳过，正是两个漏注入能发生的结构性原因）。静态侧由 `needs-permission-checker-audit.test.ts` 双向对账（无缺声明/无假声明/锚定集合）。
4. **5.2 设计决策（用户拍板）**：wire 层统一传 `inheritBypassMode: true`——主会话在 always-allow / skip 档时子代理跟随继承放行面，其余档维持 dontAsk（ask→deny）。判据：继承不是裸奔，deny 规则（Step 1）、危险命令（Step 2）、safetyCheck（Step 6，bypass-immune）全排在 Step 8 bypass 早退之前。
5. **skip 泄漏收紧（顺手，用户拍板）**：`createSubAgentChecker` 不再复刻主会话的 `skipPermissions` 布尔（其消费点在 `checker.check()` 最顶端早退，排在危险命令之前——复制过去等于子代理连 `rm -rf /` 都放行）；skip 档归一为 always-allow 派生，全放行保留、deny/危险/safety 恢复生效。

## 放弃了什么（以及为什么不选）

- **共享主 checker 实例而不是派生**：主 checker 带会话记忆、denialTracking 等可变状态，子代理并发共享会互相污染；既有 5 个调用点全是派生模式，不引入第二种形态。
- **只给 workflow/send-message 派生 inherit 版 checker、其余工具维持 dontAsk 版**：会让同一会话里 `sub_agent` 与 `workflow` 子代理权限不一致，且 wire 逻辑复杂一档。用户选了统一改（对齐 forked-command 的 P4 先例：用户显式选了 always-allow，子代理没理由降档）。
- **保留 skipPermissions 布尔的继承、只做注入修复**：skip 布尔早退排在一切检查之前，保留等于「后台子代理无审批可写全仓且连危险命令都不拦」——主会话选 skip 授权的是主循环跳过，不是派生链路裸奔。用户选了顺手收紧。
- **把「workflow 子代理强制只读」作为替代方案**（方案 5.2 的另一分支）：会让 `isolation:'worktree'` 永远是死能力（它的用途就是并行改码），文档与行为继续两头不落地。
- **行为级测试覆盖 send_message resume 路径**：需要装配 terminated agent task 注册表状态，成本高收益低；改为源码结构锚定 + M-1 审计保证 setter 存在，注入行为由同构的 runner 测试覆盖。

## 拿什么证明它生效了

- 新增测试 11 条全绿：`sub-agent-checker.test.ts` 追加 5 条（默认档不继承 / always-allow 继承且 deny+危险命令照拦 / skip 布尔清除且危险命令拦截、普通写放行 / 不带 inherit 的调用方语义不变）、`sub-agent-perm-injection.test.ts` 3 条（注入链路断言：patch execute 捕获实例，`getPermissionChecker()` 返回注入的 checker；不注入时为 null）、`needs-permission-checker-audit.test.ts` 3 条。
- 变异自证（先改坏再恢复）：删 runner 注入行 → 注入断言红；删 `skipPermissions: false` → skip 两条红；删 workflow 透传 → 由锚定覆盖。恢复后 18/18 全绿。
- 门禁：`bun test` 全量 5881 pass / 0 fail（468 文件）；`make build` 自检通过；`bun run lint` 0 error；`format:check` / `lint:boundary` / `lint:command-system` / `typecheck:gate`（66/66 无新增）全绿。
- `typecheck:gate` 曾报 `packages/tui/src/ink.tsx` TS1192，举证与本 diff 无关：① diff 不含 tui 且无 import 关系；② 干净 clone 的 origin/main 上 66/66 绿；③ 成因是本机 root `node_modules/signal-exit` 存在不符合 bun.lock（3.0.7）的 4.1.0 孤儿副本，删除后门禁恢复绿——非本 PR 引入。
