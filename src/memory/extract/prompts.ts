/**
 * 后台记忆提取提示词（Task 3）
 *
 * 提取代理通过 Forked Agent 已看到完整对话上下文，这里只需告诉它：
 * - 4 类封闭分类法
 * - 应该 / 不应该保存什么
 * - 保存步骤（用 save_memory 工具）
 * - 现有记忆清单（避免重复）
 */

import { MEMORY_TYPE_DESCRIPTIONS } from "../types.ts";

/** 构建提取提示词 */
export function buildExtractPrompt(existingMemoriesManifest: string): string {
  const typeList = Object.entries(MEMORY_TYPE_DESCRIPTIONS)
    .map(([k, v]) => `- **${k}**: ${v}`)
    .join("\n");

  return `你是后台记忆提取代理。回顾上面的对话，提取值得长期记住的信息并保存。

## 记忆类型（封闭分类法，只能用这 4 种）

${typeList}

## 应该保存的内容

- 用户的长期偏好、编码风格、工作习惯
- 用户对你的明确纠正与确认（feedback 类，必须记录 Why）
- 无法从代码推导的项目上下文、决策、约束
- 外部系统的引用（URL、dashboard、ticket）

## 不应该保存的内容

- 可以从代码、git 历史、文件内容直接推导的事实
- 临时性的会话状态、当前任务进展（这些归 Session Memory）
- 敏感信息（API Key、token、密码）—— 绝对不要保存凭证明文
- 已经存在于 CLAUDE.md 的规则

## 保存步骤

1. 判断本轮对话是否有值得记住的新信息；没有就什么都不做
2. 对每条值得记住的信息，调用 save_memory 工具保存
3. feedback / project 类记忆，在 value 里附上 **Why** 和 **How to apply**
4. 检查现有记忆清单，避免重复保存已有内容；如需更新，用相同的 key

## 现有记忆清单

${existingMemoriesManifest}

## 约束

- 最多调用 save_memory 3 次（高信号优先）
- 没有值得保存的内容时，直接回复"无需保存"，不要强行编造
- 完成后简短说明保存了什么`;
}
