/**
 * Session Memory 模板与提示词（Task 4）
 *
 * 对齐 Claude Code 的 10 section 模板结构。Session Memory 是"被丢弃历史"的
 * 结构化替代品——压缩时注入，让模型在长会话里不失忆。
 *
 * ⚠️ 这里原本写「11 section」（两处），而模板实际是 **10 个** `# ` 标题、
 * `SESSION_MEMORY_SECTIONS` 数组也是 10 个、参考文档列的同样是 10 个 ——
 * 注释的「11」三处都错。之所以长期没人发现：那个常量表**零使用**
 * （P1-5 ③），既没被用来校验模板完整性，也没被用来做截断白名单，
 * 于是「模板 section 数」这件事没有任何断言看着它。
 * 现在 `assertTemplateSectionsMatch` 把两者钉在一起，改一边不改另一边会红。
 */

/** 10 section 默认模板 */
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

/**
 * 10 个固定 section 标题 —— 模板结构的**声明式事实源**。
 *
 * P1-5 ③：这张表此前是**纯挂件**（全仓唯一命中就是它自己的定义行）。
 * 注释写着用途是「用于按 section 截断，不切断语义单元」，但实际截断走的是
 * `splitSessionMemorySections`（正则动态切）—— 表既没被用来校验模板完整性，
 * 也没被用来做截断白名单。于是模板与它可以任意漂移而无人知情，
 * 上面那个「11 section」的错误注释就是这么活下来的。
 *
 * 现在它有两个真实消费者：
 * - `assertTemplateSectionsMatch()`：把模板与本表钉在一起（下方）；
 * - `isKnownSessionMemorySection()`：截断时判定「这是模板 section 还是模型自己加的」。
 */
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

/** 从模板文本里抽出 `# ` 一级标题（与 splitSessionMemorySections 同一条正则口径） */
function templateSectionTitles(template: string): string[] {
  return template
    .split("\n")
    .map((l) => l.match(/^#\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((t): t is string => Boolean(t));
}

/**
 * 校验默认模板的 section 与 `SESSION_MEMORY_SECTIONS` 完全一致（顺序也算）。
 *
 * P1-5 ③ 的落地点：常量表要有价值，就必须有人拿它去卡一件事。
 * 不一致时**抛错**而不是 warn —— 这是纯静态的、启动即可知的自洽性问题，
 * 两者不一致意味着截断白名单与真实模板对不上，让它静默通过就等于把
 * 「常量表是挂件」这个状态重新养出来。门禁见 `tests/session-memory/`。
 *
 * @returns 一致时返回 section 数（供调用方断言用）
 */
export function assertTemplateSectionsMatch(
  template: string = DEFAULT_SESSION_MEMORY_TEMPLATE,
): number {
  const actual = templateSectionTitles(template);
  const expected = SESSION_MEMORY_SECTIONS as readonly string[];
  const same = actual.length === expected.length && actual.every((t, i) => t === expected[i]);
  if (!same) {
    throw new Error(
      `Session Memory 模板与 SESSION_MEMORY_SECTIONS 不一致：\n` +
        `  模板 (${actual.length}): ${actual.join(" | ")}\n` +
        `  常量 (${expected.length}): ${expected.join(" | ")}\n` +
        `改模板时必须同步改常量表（两者是同一个契约的两半）。`,
    );
  }
  return actual.length;
}

/**
 * 判断一个 section 标题是否属于模板定义的那 10 个。
 *
 * 截断时用它区分「模板 section」与「模型自己加的 section」：后者违反了
 * 更新提示词第 4 条（"不要添加新的 section"），预算紧张时应当先牺牲它，
 * 而不是去截掉 `Current State` 这类模板 section —— 那才是压缩后模型最需要的部分。
 */
export function isKnownSessionMemorySection(title: string): boolean {
  return (SESSION_MEMORY_SECTIONS as readonly string[]).includes(title.trim());
}

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
