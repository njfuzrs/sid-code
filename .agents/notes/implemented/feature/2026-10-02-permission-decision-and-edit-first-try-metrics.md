---
Status: implemented
Date: 2026-10-02
---
# 权限决策进轨迹（B11）与一次 edit 成功率（B12）

## 决定了什么

- **B11**：权限决策写进本地轨迹。`permission/decision-telemetry.ts` 是模块级观察者（与 `git-operation-tracking` 同模式），**挂在 `analytics/events.ts` 的 `logPermissionAllow` / `logPermissionDeny` 门面里**，collector 在 `registerHooks` 时注入。每次决策落一条 `PermissionDecision` 事件（工具 / allow·deny / 是否弹窗 / 决策来源 / 成因 reasonType / 执行路径 / 耗时），会话级累计进 `session-index.permission`（只存计数与原始耗时样本，不存比率，样本能跨会话合并、比率不能）。
- northstar 新增「更安全」段：HITL 介入率、规则命中率（分母都是**权限决策数**），确认耗时 p50/p95（只收弹过窗的样本）。
- **B12**：`session-index.edit_first_try = {files, first_try_ok}`，单位**文件 × 会话**；只看该文件本会话第一次 `PostToolUse`；参与工具是 `edit` / `notebook_edit`。northstar 新增 `edit_first_try_rate`。
- **B33 半项**：主循环权限拒绝时 fire `PermissionDenied` hook（弹窗被拒 / 超时 / 规则直拒），不 await、异常吞掉。`ref/hooks.md` 17 → 18 / 32。
- `compareSnapshots` 容忍旧快照缺新字段（落成 n=0、值 —），否则 `--weekly` 对上一版快照直接崩。

## 放弃了什么（以及为什么不选）

- **在 7 个鉴权调用点各补一行**：下一个新鉴权分支只会记得一半，漏的那条路径永久隐身且不会变红。挂在门面里，「发了遥测」⇔「进了轨迹」靠结构保证。
- **复用遥测 `permission_*` 事件当数据源**：它受隐私级别 / killswitch / 采样管辖，也没有会话维度，出不了按 release 的曲线。轨迹是本地数据，不该被遥测开关连带关掉。
- **把 write 算进一次成功率**：整文件覆盖没有匹配步骤，新建文件会白送一次成功，指标会被「新建了多少文件」主导。
- **按调用次数做分母**：反复返工的文件调用次数更多、权重更大，稀释的恰好是返工信号。
- **把 PostToolUseFailure 算作 edit 失败**：那一路是权限拒绝 / hook 阻止 / 参数校验失败，edit 根本没开始匹配，是别的方向的信号。
- **「权限规则匹配正确率」**：「正确」需要真值标注，轨迹给不出。只做规则命中率 + 按 reason 分桶，CLAUDE.md 标 ⚠️，没有冒充 ✅。
- **子代理 / forked 路径 fire PermissionDenied**：本次不接，它们的拒绝已经经过门面进了轨迹；hook 描述写明「子代理路径暂未接」。

## 拿什么证明它生效了

- 单测 `packages/core/tests/trace/decision-metrics.test.ts`（10 条）：口径、门面转发、真实 `HookSystem` 端到端落 `session-index` 与 `events.jsonl`、SessionStart 重置。`tests/scripts/northstar-snapshot.test.ts` 新增 4 条（合并口径、旧行不进分母、分母含增量行、旧快照对比不崩）。`bun run affected-tests:run`：3562 pass，唯一失败是 `ref/hooks.md` 漂移，重新生成后通过。
- **真实会话**（`sid-code-dev -p`，v0.1.606）：
  - default 档：`permission = {total:3, prompted:0, denied:1, …}`，`events.jsonl` 里 3 条 `PermissionDecision`，其中 edit 那条是 `deny / reason_type:"other"`（headless 把 ask 自动拒）。
  - acceptEdits 档：`edit_first_try = {files:1, first_try_ok:1}`，`by_reason.mode = 1`。
  - 在隔离 `SID_CONFIG_DIR` 里配 `permission_denied` hook，跑一次被拒的 edit：hook 输出 `denied edit`。
  - `bun run scripts/northstar-snapshot.ts`：`一次 edit 成功率 100.0% n=1`，`HITL 介入率 0.0% n=6`，确认耗时 n=0 并打印说明。
- 已知空洞：确认耗时要在**交互**会话里真弹过窗才有样本，本机 headless 恒 n=0；样本 n 还远小于 20，现在不能拿来下结论。
