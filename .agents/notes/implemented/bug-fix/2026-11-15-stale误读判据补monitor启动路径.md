---
Status: implemented
Date: 2026-11-15
Source: 20261112-收尾阶段重复挂监听-修复与验收方案（2026-11-12）
---
# `stale_notification_claims` 补上 monitor 启动路径

## 决定了什么

`packages/core/src/trace/digest.ts` 的 `WAIT_LAUNCH_RECEIPT_RE` 增加 monitor 的启动回执
（`已启动监控 m[a-z0-9]{8}`），使 R3 误读度量覆盖 R9 修法 3 要求的**三个**等待入口
（bash 后台 / monitor / schedule_wakeup），而不只是其中两个。

同时修正 4 处与实现矛盾的过时注释（纯注释，无行为变化）：
`tool/monitor.ts:52`、`tool/schedule-wakeup.ts:21` 说 `findWaitBySubject` / `extractWaitSubjects`
「已删」，实际两者仍在（前者查表、后者是委托窄口径的兼容入口）；`task/status-query-commands.ts:807`
仍写「命令是单行」、`:902` 仍写「`flattenCommand` 见到换行直接放弃」，与已改成「保留引号外换行」的实现相反。

## 放弃了什么（以及为什么不选）

- **不放宽成「任何提到后台任务的文本」**。启动回执本身也包含 `<task-notification>` 字样，
  放宽会把「通知已送达」的轮次也当成一次新的等待启动，把误读率算虚高。
- **不按 kind 拆成三份正则**。文案改动时的同步成本一样（三处都要改），但多一份状态要维护，
  而且匹配失败仍然是「静默变 0」，拆开只会让失败面变大。
- **不改用结构化字段（`tool_result` 上的 `kind`）**。度量要跑在**历史轨迹**上，那些轨迹产生时
  还没有这个字段；只认结构化字段等于放弃老轨迹的 4 条真实误读（验收 1 的夹具）。
- **不给 monitor 侧回执改文案去迎合正则**。回执文案是模型可见的产品文案，不该为离线度量让步。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/trace/digest-wait-source.test.ts ./packages/core/tests/task/status-query-real-shapes-r4.test.ts`
  → **35 pass / 0 fail / 72 expect**。新增三条：monitor 误读计入（期望 1）、monitor 正常不计（期望 0）、
  R2 生效后的轨迹形态（1 start + 3 duplicate → 并存峰值 1、duplicate 3、误读 0）。
- **变异自证**：把正则里的 `|已启动监控 m[a-z0-9]{8}` 删掉后重跑，
  只有新用例变红（`Expected: 1, Received: 0`），其余 14 条仍通过；恢复后回到 15 pass。
  说明这条用例锁的确实是 monitor 分支，不是「碰巧全绿」。
- 反向边界没有放松：`duplicateWaitReceipt`（「已有等待在盯同一个对象，本次未重复启动」）不匹配该正则，
  验收 2 用例里 3 次 duplicate 只算 3 次准入、不算 3 次启动（`registered` 仍为 1）。
- R4 补的两条：裸 `; date` → `gh:pr:780`（此前只测了 `date -u +…`）、`os.remove` → null
  （此前同正则组只测了 `os.system`），均在上述 35 pass 内。
