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
`;
}

/** 生成 Plan Mode 系统提醒（附加到用户消息中，防止 LLM 遗忘） */
export function buildPlanModeReminder(): string {
  return `<system-reminder>
你当前处于计划模式。不要进行任何编辑或运行任何命令。
专注于探索代码库和编写计划。
</system-reminder>`;
}
