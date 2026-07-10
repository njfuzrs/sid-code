/**
 * 按 agent 类型的持久记忆读取器（G13，对标 claude-code agentMemory.ts）
 *
 * 每个垂直子代理类型（code-review / security-audit / …）有独立记忆目录，
 * 跨会话沉淀领域经验。spawn 该类型子代理时，把它累积的 MEMORY.md 索引注入
 * 其系统提示词——让子代理带着"历史积累的领域经验"开工。
 *
 * 目录布局见 paths.ts：~/.sid-code/memory/agents/<agentType>/MEMORY.md
 *
 * 与 MemoryStore（global/project 私有 scope）、team/store（团队共享 scope）并列的
 * 第四条记忆线：agent-scope。单独走这里，不侵入 MemoryStore 的 global/project 语义。
 * 读取失败 / 目录或索引不存在 / 内容为空均返回 null（无 agent 记忆时行为不变）。
 */

import { existsSync } from "fs";
import { getAgentMemoryIndexPath } from "./paths.ts";

/**
 * 读取某 agent 类型累积的 MEMORY.md 索引内容（供 system prompt 注入）。
 * 目录或索引不存在、读失败、内容为空均返回 null。
 */
export async function getAgentIndexContent(agentType: string): Promise<string | null> {
  const indexPath = getAgentMemoryIndexPath(agentType);
  if (!existsSync(indexPath)) return null;
  try {
    const text = await Bun.file(indexPath).text();
    return text.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 构建"该 agent 类型历史积累记忆"的系统提示词片段。
 * 注入格式对齐主会话记忆注入（buildMemorySystemPrompt）：用 system-reminder
 * 包装，注明这是该 agent 类型跨会话沉淀的领域经验，需要完整内容时用 Read 读取。
 *
 * @param agentType    子代理类型（用于文案标注）
 * @param indexContent 该类型 MEMORY.md 索引内容（为 null / 空时返回空串）
 * @returns 可直接追加到子代理系统提示词的片段；无记忆时返回空串
 */
export function buildAgentMemorySection(
  agentType: string,
  indexContent: string | null,
): string {
  if (!indexContent || !indexContent.trim()) return "";
  return `<system-reminder>
### ${agentType} 类型的历史积累记忆（跨会话）

下面是「${agentType}」这一类子代理在过往会话中沉淀的领域经验索引。这些是同类任务反复积累的可复用知识（常见坑、领域约定、有效方法）。开始任务前先参考;需要某条记忆的完整内容时，用 Read 工具读取对应文件：

${indexContent}
</system-reminder>`;
}

/**
 * 便捷组合：读取 agent 类型记忆索引并构建注入片段。
 * 无记忆时返回空串（调用方拼接空串即为"行为不变"）。
 */
export async function buildAgentMemoryInjection(agentType: string): Promise<string> {
  const indexContent = await getAgentIndexContent(agentType);
  return buildAgentMemorySection(agentType, indexContent);
}
