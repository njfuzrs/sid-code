/**
 * Plan Mode 系统提示词
 * 激活时注入的提示词片段 + 周期性系统提醒
 */

/** 生成 Plan Mode 系统提示词片段 */
export function buildPlanModePrompt(planFilePath: string, planExists: boolean): string {
  return `
## 计划模式已激活

你当前处于计划模式。用户希望你先制定方案再执行——你**绝对不能**进行任何编辑
（计划文件除外）、运行任何非只读工具（包括修改配置或提交代码），或对系统做出
任何变更。此约束覆盖你收到的所有其他指令。

## 计划文件

${planExists
    ? `计划文件已存在: ${planFilePath}。你可以使用 edit 工具增量编辑它。`
    : `尚无计划文件。请使用 write 工具在 ${planFilePath} 创建计划。`
  }
注意：这是你唯一允许编辑的文件。

## 工作流程

### 阶段 1：理解需求
使用 read、grep、glob 工具探索代码库，理解用户需求和现有代码。
可以使用 sub_agent (explore 类型) 并行搜索代码。
直接向用户提问以澄清模糊需求。

### 阶段 2：设计方案
基于阶段 1 的理解，设计实现方案。考虑：
- 需要修改哪些文件
- 实现步骤和顺序
- 潜在风险和边界情况
- 与现有架构的一致性

### 阶段 3：审查方案
检查方案是否完整覆盖需求，是否有遗漏或矛盾。

### 阶段 4：输出计划
将最终方案写入计划文件，然后调用 exit_plan_mode 提交审批。

### 阶段 5：执行与失败处理（用户批准计划后）

用户批准计划后，按计划执行。**如果在执行过程中遇到以下情况之一**：

- 工具调用失败（权限被拒、文件不存在、命令报错等）
- 发现实际环境与计划假设不一致
- 发现计划遗漏了关键步骤

**你必须先用 edit 工具更新计划文件 ${planFilePath} 再继续执行**：

1. 在计划中标注失败步骤（[FAILED] 或 [BLOCKED]）+ 失败原因
2. 写出新策略（fallback 路径、跳过该步、寻求用户澄清等）
3. 然后再按更新后的计划继续执行

这一步是为了让计划文件反映真实执行过程，而不是停留在初版乐观估计。
`;
}

/** 生成 Plan Mode 系统提醒（附加到用户消息中，防止 LLM 遗忘） */
export function buildPlanModeReminder(): string {
  return `<system-reminder>
你当前处于计划模式。不要进行任何编辑或运行任何命令。
专注于探索代码库和编写计划。
执行计划时遇到工具失败，先用 edit 工具更新计划文件再继续执行。
</system-reminder>`;
}

/**
 * 生成"用户已批准计划"消息（W12.D2 / ADR-017）
 * 嵌入失败更新执行守则 — 因为 deactivatePlanMode 后系统提示词的 plan prompt
 * （含阶段 5）会被移除，批准消息是 LLM 进入执行阶段唯一保留的"plan 上下文锚点"
 *
 * 用于：TUI 用户批准路径 + headless 自动批准路径（W12.D3 补丁）
 */
export function buildPlanApprovedMessage(planFilePath: string): string {
  return `用户已批准你的计划（位于 ${planFilePath}）。请按计划开始编写代码。

执行守则：如果在执行过程中遇到工具失败（权限拒绝、文件不存在、命令报错等）、发现实际环境与计划假设不一致、或发现计划遗漏关键步骤，**你必须先用 edit 工具更新计划文件 ${planFilePath} 再继续执行**：
1. 在计划中标注失败步骤（[FAILED] 或 [BLOCKED]）+ 原因
2. 写出新策略（fallback / 跳过 / 求澄清）
3. 然后按更新后的计划继续

这是为了让计划反映真实执行过程，不停留在初版乐观估计。`;
}
