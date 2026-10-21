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
6. **review 跟进：子 checker 的 config 改为主会话 config 的只读活视图**（`sub-agent-checker.ts` `createLiveSubAgentConfig`，Proxy）。第 4 条把 wire 层改成继承全放行后，快照式 config 暴露出一个安全问题：wire 只在启动 / settings 重载 / 工作区切换时下发，Shift+Tab 切档（`cyclePermissionMode`）与企业策略中途收回 bypass（`applyEnterprisePolicyInSession`）只改主 config ⇒ 主会话降回 default 后子代理仍是 always-allow 全放行（修复前实测 `main:false / sub:true`）。现在 `permissionMode` / `skipPermissions` 每次读取都按主 config 现算，`yesMode` 等其余字段直读主 config；写入一律抛 TypeError，防止写穿到主会话。`deriveForWorkspace` 改为共享 config 引用而不是展开快照，worktree 子代理同样能跟上切档。
7. **review 跟进：send_message 续跑回到原工作区**。`LocalAgentTaskState` 加 `cwd`，`SubAgent.execute` 在显式 cwd 时记下来；resume 时带上同一个 cwd，并按该目录 `deriveForWorkspace`；原工作区已不存在（无改动的隔离 worktree 跑完即删）就返回 `cannot_resume`，不降级到主工作区。否则第 2 条解锁写能力后，一个隔离 agent 续跑一次就会直接写主仓。
8. **文档**：`website/extend/workflows.md` 去掉「切到 acceptEdits 即可写」的错误说法（acceptEdits 不在可继承集合里，实测子代理仍被拒），补充实时跟随切档的说明，allow 规则示例补上 `Write(src/**)`（`Edit(...)` 不覆盖 write 工具，实测）。

## 放弃了什么（以及为什么不选）

- **共享主 checker 实例而不是派生**：主 checker 带会话记忆、denialTracking 等可变状态，子代理并发共享会互相污染；既有 5 个调用点全是派生模式，不引入第二种形态。
- **只给 workflow/send-message 派生 inherit 版 checker、其余工具维持 dontAsk 版**：会让同一会话里 `sub_agent` 与 `workflow` 子代理权限不一致，且 wire 逻辑复杂一档。用户选了统一改（对齐 forked-command 的 P4 先例：用户显式选了 always-allow，子代理没理由降档）。
- **保留 skipPermissions 布尔的继承、只做注入修复**：skip 布尔早退排在一切检查之前，保留等于「后台子代理无审批可写全仓且连危险命令都不拦」——主会话选 skip 授权的是主循环跳过，不是派生链路裸奔。用户选了顺手收紧。
- **把「workflow 子代理强制只读」作为替代方案**（方案 5.2 的另一分支）：会让 `isolation:'worktree'` 永远是死能力（它的用途就是并行改码），文档与行为继续两头不落地。
- ~~send_message resume 只做源码字面量锚定~~（初版做法，review 后撤回）：`toContain` 挡不住「注入写在 execute 之后」这类顺序错误，且实际装配成本不高（`createAgentTask` + `updateTask` 置终态即可）。已改为行为级测试。
- **各工具 execute 时从根 checker 重新派生（forked-command 的 `deriveForkChecker` 模式）来修切档过期**：要改 7 个入口，新增入口仍可能漏；而且只能做到「起跑时取当前值」，长跑子代理中途切档依旧过期。活视图一处改动覆盖全部入口，切档对正在运行的子代理也立即生效。
- **在 cyclePermissionMode / 策略收回之后补调 `wireToolPermissionChecker()`**：改权限模式的入口不止这两处（`tool-executor.ts` contextModifier、plan 进出、`app.ts` 规则加载时的 permissionMode 回填），逐个补调必然有漏；且已在运行的子代理拿着旧实例，重新下发对它们无效。
- **把 acceptEdits 加进可继承集合**：会扩大后台子代理的放行面（无审批写全部工作区文件），本 PR 不顺带做这个取舍；文档改为如实描述。
- **send_message 续跑时工作区已删就降级到主工作区**：这正是要消灭的「隔离 agent 静默写主仓」后果（与 agent/tool.ts W1「建不出隔离就失败、不降级」同一判据）。

## 拿什么证明它生效了

- 新增测试 11 条全绿：`sub-agent-checker.test.ts` 追加 5 条（默认档不继承 / always-allow 继承且 deny+危险命令照拦 / skip 布尔清除且危险命令拦截、普通写放行 / 不带 inherit 的调用方语义不变）、`sub-agent-perm-injection.test.ts` 3 条（注入链路断言：patch execute 捕获实例，`getPermissionChecker()` 返回注入的 checker；不注入时为 null）、`needs-permission-checker-audit.test.ts` 3 条。
- 变异自证（先改坏再恢复）：删 runner 注入行 → 注入断言红；删 `skipPermissions: false` → skip 两条红；删 workflow 透传 → 由锚定覆盖。恢复后 18/18 全绿。
- 门禁：`bun test` 全量 5881 pass / 0 fail（468 文件）；`make build` 自检通过；`bun run lint` 0 error；`format:check` / `lint:boundary` / `lint:command-system` / `typecheck:gate`（66/66 无新增）全绿。
- review 跟进（第 6/7 条）的验证：
  - 复现脚本：主会话 always-allow 派生子 checker 后把主 config 改成 default，修复前 `main:false / sub:true`，修复后 sub 与 worktree 派生的 checker 都是 `false`（mode=dontAsk）；子 checker 侧写 config 抛 TypeError。
  - `sub-agent-checker.test.ts` 新增 6 条（降档 / worktree 派生跟随 / 策略收回 skip / 升档 / 只读视图 / 展开与反射取值）。变异自证：permissionMode 冻结在派生时刻 → 4 条红；`deriveForWorkspace` 改回 `{...this.config}` → 1 条红；描述符漏算 skipPermissions → 1 条红。
  - `sub-agent-perm-injection.test.ts` 的 send_message 用例改为行为级 3 条，另加 cwd 记录 1 条。变异自证：删注入行 / 不传 cwd / 删工作区存在性守卫 / 不派生 worktree checker / 删 `SubAgent.execute` 的 cwd 记录，各自对应用例变红。
- `typecheck:gate` 曾报 `packages/tui/src/ink.tsx` TS1192，举证与本 diff 无关：① diff 不含 tui 且无 import 关系；② 干净 clone 的 origin/main 上 66/66 绿；③ 成因是本机 root `node_modules/signal-exit` 存在不符合 bun.lock（3.0.7）的 4.1.0 孤儿副本，删除后门禁恢复绿——非本 PR 引入。
