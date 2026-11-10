---
Status: implemented
Date: 2026-11-10
---
# swarm 的 escalate 包装器补齐 Checker 契约：透传 options、leader 裁决落审计、保留出参元数据

## 决定了什么

`packages/core/src/swarm/team.ts` 的 `createEscalateChecker` 此前只实现 `check(req, tool, toolContext)`，
把 `Checker` 接口当成「只有三个形参」，由此产生三个同源缺陷（缺陷编号 B33）：

1. **丢掉第 4 个入参 `PermissionCheckOptions`**。它装着 PreToolUse hook 的
   `hookPermissionDecision`（`allow` / `ask`），底层 checker 在管线末尾消费它
   （`permission/checker.ts` 的 `hook-allow` / `hook-ask` 分支）。丢掉之后：
   - hook `ask` 本该强制升级/拒绝的操作，底层返回 `allowed` → 包装器直接放行，
     **连 leader 都不会问**（安全方向：静默绕过 hook 的拦截）；
   - hook `allow` 本该放行的操作，底层返回 `needsConfirmation` → 转 leader →
     无仲裁者时 fail-closed deny（功能方向：白拦）。
2. **leader 裁决不落审计**。包装器既不转发底层的 `auditConfirmationOutcome`，也不在
   `PermissionSync` 裁决后自己记一行。B20 引入的 `confirm_source` 在 swarm 路径上取不到值，
   审计里看不出「这次确认是 leader 给的」。
3. **出参元数据丢失**。leader 分支直接返回 `{ allowed, reason }`，底层的 `step` /
   `decisionReason` / `mode` 全丢；轨迹里看不出「是在 leader 阶段做的决定」。

修法：包装器按 `Checker` 的完整契约透传——`check` 补第 4 形参并原样下传；leader 裁决后
调用 `baseChecker.auditConfirmationOutcome?.(req, { source: "leader", ... })`；出参用
解构保留底层元数据、清掉 `needsConfirmation`（不清会让上层继续走确认/降级分支，
把 leader 的结论覆盖掉）、把 `step` 标成 `leader-allow` / `leader-deny`。
另外转发 `auditConfirmationOutcome` 作为可选能力（上层在确认终局后调的就是它）。
`permission/types.ts` 的 `confirm_source` 取值注释补上 `leader`。

改动文件：`packages/core/src/swarm/team.ts`、`packages/core/src/permission/types.ts`、
新增 `packages/core/tests/swarm/team-escalate-checker.test.ts`（7 个用例）。

## 放弃了什么（以及为什么不选）

- **不整体转发所有可选方法**（`rememberDecision` / `recordUserDenial` / `getDenialTracking` /
  `getShadowedRulesForTool`）。它们会改变 swarm 的行为（会话记忆按资源命中、denial tracking
  熔断计数、UI 阴影规则提示），而当前没有任何上层经包装器调用它们。B33 是「契约被收窄」，
  修法是补齐被遮住的入口，不是顺手把整条链路的行为都打开。将来若有调用方，逐个补转发
  并各自带回归测试。
- **不让 leader 裁决写 `user_confirmed: true`**。`PermissionSync` 只回传 verdict，
  包装器无法区分 leader 背后是「用户点了弹窗」还是「--yes / auto 自动批准」；
  把 `confirm_source` 记成 `leader`、`user_confirmed` 保持 `false` 是保守且可解释的口径。
  要精确到「人」，得让 `PermissionArbiter` 把结果来源一并回传，那是另一处契约改动。
- **不改底层 checker 的 `hookPermissionDecision` 语义**。本次只修「决策没到达底层」，
  不改 hook allow/ask 的护栏规则（安全类确认不可被 hook allow 越过等），那是另一层契约。

## 拿什么证明它生效了

1. **先复现再修**（修前打在 `/tmp/b33-repro.ts`，未入仓）：
   - 场景 A：`read` + `hookPermissionDecision: "ask"` → 直接调子代理 checker 是
     `allowed=false step=hook-ask`；经包装器是 `allowed=true step=10`（hook 拦截被绕过）。
   - 场景 B：`write` + `hookPermissionDecision: "allow"` → 直接调是 `allowed=true step=hook-allow`；
     经包装器是 `allowed=false reason=工具 "write" 需要用户确认`。
   - 场景 C：包装器上 `auditConfirmationOutcome` 等 5 个可选能力全 `undefined`。
2. **回归测试**：`bun test ./packages/core/tests/swarm/team-escalate-checker.test.ts` → 7 pass / 0 fail。
   覆盖：options 原样透传、hook ask 仍拦截、hook allow 仍放行、leader 批准/拒绝各写一行
   `confirm_source=leader` 审计（按 `tool_use_id` 可 join）、元数据保留、可选入口转发。
3. **变异自证**（改坏 → 跑红 → 恢复）：
   - 把 `baseChecker.check(req, tool, toolContext, options)` 改回三参 → 3 fail（options 相关三条）；
   - 把审计 `source: "leader"` 改成 `"auto"` → 2 fail（两条审计断言）；
   - 删掉 `auditConfirmationOutcome` 转发块 → 1 fail（转发断言）。
4. `bun run affected-tests:run` 与 `make build` 结果见 PR 正文。
