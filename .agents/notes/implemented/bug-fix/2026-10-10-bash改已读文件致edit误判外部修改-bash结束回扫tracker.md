---
Status: implemented
Date: 2026-10-10
---
# bash 改了已读文件致 edit 误判「外部修改」：bash 结束后回扫 tracker

## 决定了什么

- **根因**：`FileReadTracker` 只认 read/edit/write，bash 写盘（oxfmt、`perl -pi`、`sed -i`）对它不可见。
  agent 自己格式化完的文件，下一次 edit 被判「文件自上次读取后已被外部修改」拒绝。
- **F1**：`BashTool` 持有与 read/edit/write 同一个 tracker。前台、非只读命令结束后（含失败/超时）调
  `tracker.noteBashExecution()`：mtime 变且内容确实不同的已读文件，快照刷新为磁盘内容并打 `changedByBash`；
  被删的移除记录；清单追加到 bash 结果末尾告知模型（最多列 10 个）。
  - edit 因快照已刷新而放行。edit 本身从磁盘重读 + old_string 精确匹配，旧视图拼的 old_string 失效会被匹配失败拦下。
  - **write 看到 `changedByBash` 仍拒绝**，要求重新 read：整文件覆盖会冲掉 bash 的改动。只有重新 read 能清标记。
- 接线：主代理 `cli.ts`、`mcp-serve.ts` 传 tracker；子代理 / fork 用 `withFileReadTracker()` 绑定各自独立 tracker
  （`Object.create` 原型视图，不重建 shell 快照、保留已注入的 sandbox）。
- **F3**：真外部修改的拒绝文案说明来源（IDE / 保存时格式化 / 后台命令 / 其他进程）与下一步。
- **F4**：新事件 `file_freshness`（`rejected_unread` / `rejected_modified` / `rejected_changed_by_bash` / `bash_changed_tracked_files`），
  模块级 sink 由 `app.ts` 注入。
- 删掉 `file-state-cache.ts` 里零调用、口径漂移（`>` vs `!==`）的第二份 `validateForEdit`。

## 放弃了什么（以及为什么不选）

- **F2：edit 对所有 mtime 变化都降级为「old_string 仍唯一命中就放行」**。暂不做。F1 已消掉全部已观测误拦（3/3 来自自己的 bash）；
  剩下的「bash 之外的改动」正是这道护栏唯一的真阳性场景（IDE 并发编辑同一文件、old_string 仍命中但周边语义已变）。
  真阳性目前 0 例可能只是样本小，等 `file_freshness.rejected_modified` 攒出分母再决定。
- **edit 后清 `changedByBash`**：否决。edit 只交了片段，bash 改动的其余部分模型仍没看过，紧接 write 会冲掉。
- **按命令解析写目标（`bashWriteTargets`）只刷新那些路径**：否决。formatter / 脚本的写目标解析不出来，漏一个就是原样误拦；
  回扫 tracker 是 O(已读文件数) 次 stat，几十个文件的量级可以忽略。
- **后台命令结束时回扫**：不做。其完成不经过 execute 返回路径，改动仍按外部修改拦截（保守侧）。

## 拿什么证明它生效了

- 轨迹基线（修复前）：99 会话 / 118 次 edit 中 stale 拒绝 3 次，3/3 是自己 bash 改的，重读后 old/new_string 逐字相同。
  分析见 `docs-research/sid-code/bugfixes/todo/20261010-edit「文件自上次读取后已被外部修改」-轨迹定位与去留分析.md`。
- `packages/core/tests/tool/bash-tracked-file-refresh.test.ts`：复现轨迹 A（write → `perl -pi` 改写 → edit）与轨迹 B（read → `perl -CSD -pi` → edit），15 条全绿。
  另覆盖：write 仍拦、外部改动仍拦、只读/后台不回扫、touch 不算变更、删除、子代理视图隔离、埋点序列。
- 变异自证（逐个撤回修复点）：bash 不回扫 → 7 fail；write 不看标记 → 2 fail；只读也回扫 → 1 fail；touch 算变更 → 1 fail；视图不换 tracker → 1 fail。
- `bun run affected-tests:run` 3844 pass / 0 fail；`make build` 通过；lint / lint:boundary 干净。
- 上线后的验收口径：`file_freshness` 中 `rejected_modified ÷ edit 调用数` 应从 2.5% 降到接近 0；
  `bash_changed_tracked_files` 有非零样本，证明回扫真的被触发过，而不是一道「防线全在、调用全 0」的死功能。
