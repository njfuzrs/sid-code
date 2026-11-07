---
Status: implemented
Date: 2026-11-07
---
# G2 锁缺陷用例 A2-settings-flag-no-hook：先锁住「--settings 注入的 hook 不生效」，不顺手修

## 决定了什么

新增 `tests/smoke/cases/A2-settings-flag-no-hook`（kind = `lock-defect`）。夹具和 hook 都与 `A2-post-tool-use` 一样，唯一的差别是配置来源：hook 放在 `--settings <file>` 里，不放项目级 settings。断言锁住当前行为：edit 照常执行，`HookExecuted` 为 0 条，也没有 `hook.log`。

根因已于 2026-11-07 回源码核实：`collectHookLayers`（`packages/core/src/config/hook-layers.ts`）只收集 managed 和 user/project/local 三个磁盘源。`--settings` 是 `cli.ts` 通过 `setFlagSettings` 注入的内存源，不在收集范围内。这与触发清单 A2「讲的时候留余地 (a)」2026-11-05 的人工实测结论一致：`hooks list --settings` 列不出条目、日志为空、轨迹里零 `HookExecuted`。

## 放弃了什么（以及为什么不选）

- **在本 PR 里顺手修掉**：不选。`--settings` 的 hook 该归到哪一层、要不要过信任门、在 `/hooks` 面板里显示成什么来源，都是行为变更，按 CONTRIBUTING 要先开 issue 讨论。本 PR 只负责让「哪天被改了」这件事可见。
- **不建这条用例，只在台账里备注**：不选。备注不会变红。有人改了 hook 收集逻辑、让 `--settings` 生效时，没有任何东西会提醒他去更新文档里「`--settings` 不生效」的说法。

修复时把这条的断言改成 1 条 `HookExecuted`，kind 改成 `guard`，不要删用例。

## 拿什么证明它生效了

- `make build && bun run smoke -- A2-settings-flag-no-hook`：通过，用时 0.4s。
- `bun run smoke:mutate -- A2-settings-flag-no-hook`：1/1 killed。变异的做法是在 `collectHookLayers` 里把 flagSettings 的 hooks 也收进来，模拟缺陷被修掉；变异后 `HookExecuted` 期望 0 条、实际 1 条。跑完后 `git status` 显示源码已还原。
