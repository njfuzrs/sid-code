---
Status: implemented
Date: 2026-10-22
---
# workflow 按名复用打通、失败回传 runId、/workflows 可见磁盘历史 run、自定义子代理 spawn 模型口径对齐

## 决定了什么

来源：官网 `website/extend/workflows.md` 逐条核查反向发现的代码缺陷（C1–C4、F1），先对照 main@0350d17d 源码复核过再改。

- **C1**：`tool/workflow.ts` 的 `resolveScript` 注释改为 `script_path > script > name`，与实现、schema 描述一致（旧注释已误导出一份写反的官网文档）。
- **C2**：新增 `resolveSavedScriptPath(name)`，`{name}` 参数与内联 `workflow("name")` 共用：先精确 `<name>.js`，找不到再在 `<safeName>-wf_<12hex>.js` 里按 mtime 取最新。`persistScript` 与它共用 `safeScriptName`，两边清洗规则不会再漂。
- **C3**：workflow 失败时工具输出也带 `{workflow, runId, script_path, error}` JSON 和 resume 提示（与成功分支共用 `buildResumeHint`）；`failWorkflowTask` 的通知 summary 带 runId。
- **C4**：核查发现原文档定位错了——workflow 走的 `execute()` 两条路径（spawn `:1184` / 进程内 `:2016`）都按 `task.type`，是一致的。真正分叉的是**自定义子代理** `executeCustom`：spawn 路径无 override 时按 `"task"` 类型解析（读 `subAgentModels.task`），进程内路径用主模型。统一到主模型（编译二进制只走进程内，即线上现状），不改变线上行为。
- **F1**：`/workflows` 无参时把「磁盘 journal 里有、当前会话 task 注册表里没有」的 run 列为「历史（仅磁盘）」（最多 20 条）；带 runId 在内存查不到时回退读 journal，渲染进度树并给出可直接粘贴的 `{script_path, resume_from_run_id}`。用户输入的 runId 先过 `^wf_[0-9a-f]{12}$` 再拼路径，防 `../` 越出目录。

## 放弃了什么（以及为什么不选）

- **C2 落盘时额外写一份 `<name>.js`（最新覆盖）**：会静默覆盖用户手动命名的同名脚本，同名不同内容的 workflow 也会互相替换。按 mtime 回退只读不写，没有这个副作用。
- **C2 按 runId 排序取最新**：runId 是随机 hex，没有时间序，只能用 mtime。
- **C4 统一到 `"task"` 类型**：会让配了 `subAgentModels.task` 的用户线上的自定义代理 / forked 命令换模型、计费跟着变；而这条路径的语义（自定义代理不是 task 类型）本就没理由读 task 的配置。
- **F1 历史 run 推断成功/失败状态**：journal 只记成功的 agent()，不记 run 终态，推断必然有错，宁可如实写「最终状态未知」。也没有做 journal 自动清理，那是另一项产品决策。

## 拿什么证明它生效了

- 新增 `packages/core/tests/workflow/workflow-tool-name-and-failure.test.ts`（7 例，用不调 agent() 的脚本驱动真实 `WorkflowTool.execute`，SID_CONFIG_DIR 指向 tmpdir）：跑一次 `{script}` 后不改名直接 `{name}` 能加载并返回同一结果；内联 `workflow("child-wf")` 同样可用；抛错脚本的输出能解析出 runId，`script_path` 等于 `<name>-<runId>.js`，通知里含 runId。
- `sub-agent-provider-routing.test.ts` 新增 1 例：`subAgentModels.task=haiku-like`、无 override 时 `executeSpawnedCustom` 的 init 是 `main-model` + 主连接。
- `packages/cli/tests/command/workflows.test.ts` 新增 1 例：历史区只出现磁盘独有的 run、不重复内存 run、忽略非 runId 文件；详情给出正确 resume 参数；`../../etc/passwd` 按未找到处理。
- 变异自证：分别用环境开关把 C2 回退、C3 失败输出、C4 解析、F1 历史合并改回旧行为，对应 3 / 2 / 1 / 1 个用例变红；撤掉开关后 25/25 绿。
