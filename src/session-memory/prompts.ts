/**
 * Session Memory 模板与提示词（Task 4）
 *
 * 对齐 Claude Code 的 11 section 模板结构。Session Memory 是"被丢弃历史"的
 * 结构化替代品——压缩时注入，让模型在长会话里不失忆。
 */

/** 11 section 默认模板 */
export const DEFAULT_SESSION_MEMORY_TEMPLATE = `# Session Title
_A short and distinctive 5-10 word descriptive title for the session_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context._

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? Failed approaches._

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid?_

# Key results
_If the user asked a specific output, repeat the exact result here._

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step._
`;

/** 11 个固定 section 标题（用于按 section 截断，不切断语义单元） */
export const SESSION_MEMORY_SECTIONS = [
  "Session Title",
  "Current State",
  "Task specification",
  "Files and Functions",
  "Workflow",
  "Errors & Corrections",
  "Codebase and System Documentation",
  "Learnings",
  "Key results",
  "Worklog",
] as const;

/**
 * 构建 Session Memory 更新提示词。
 * 提取代理通过 Forked Agent 模式已经看到完整对话上下文，这里只需告诉它
 * 如何把对话内容沉淀进 .session_memory.md。
 */
export function buildSessionMemoryUpdatePrompt(currentContent: string, template: string): string {
  return `你是一个会话笔记维护代理。根据当前对话内容，更新会话笔记文件。

## 规则

1. 使用 Edit 工具更新文件，不要重写整个文件
2. 保留模板的 section 结构和斜体描述
3. 只更新有实际内容变化的 section
4. 不要添加新的 section
5. 每个 section 内容控制在 ~2000 tokens 以内
6. 保持简洁，高信号密度，无填充
7. Current State 应反映最新的工作状态
8. Worklog 按时间顺序追加，每步一行

## 当前文件内容

${currentContent}

## 模板参考

${template}
`;
}
