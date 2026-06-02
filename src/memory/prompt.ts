/**
 * 记忆系统提示词构建（Task 7）
 *
 * 生成注入系统提示词的"记忆系统指令"——告诉模型 4 类分类法、何时保存、
 * 不应保存什么，以及当前的 MEMORY.md 索引内容。
 */

import { MEMORY_TYPE_DESCRIPTIONS } from "./types.ts";

/** 记忆系统指令（静态部分，可缓存） */
export function buildMemoryInstructions(): string {
  const typeList = Object.entries(MEMORY_TYPE_DESCRIPTIONS)
    .map(([k, v]) => `- **${k}**: ${v}`)
    .join("\n");

  return `## 记忆系统

你可以用 save_memory 工具保存跨会话的长期记忆。记忆按 4 类封闭分类法组织：

${typeList}

何时保存：
- 用户明确要求"记住…"、"以后都…"、"我偏好…"
- 发现用户长期偏好、编码风格、项目约定、重要决策
- 用户对你的明确纠正（记录 Why 和 How to apply）

不应保存：
- 可从代码 / git / 文件内容直接推导的事实
- 临时会话状态、当前任务进展（这些由 Session Memory 自动维护）
- 敏感信息（API Key、token、密码等凭证明文）
- 已存在于 CLAUDE.md 的规则

记忆是"写入时的时间点观察"，不是实时状态——引用记忆中关于代码行为或 file:line 的断言前，先对照当前代码验证。`;
}

/**
 * 构建完整的记忆系统提示词（指令 + MEMORY.md 索引）。
 * @param indexContent MEMORY.md 索引内容（可为 null）
 */
export function buildMemorySystemPrompt(indexContent: string | null): string {
  const instructions = buildMemoryInstructions();
  if (!indexContent || !indexContent.trim()) {
    return instructions;
  }
  return `${instructions}

### 已保存的记忆索引（MEMORY.md）

下面是当前已保存记忆的索引。需要某条记忆的完整内容时，用 Read 工具读取对应文件：

${indexContent}`;
}
