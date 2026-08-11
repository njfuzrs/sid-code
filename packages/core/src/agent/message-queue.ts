/**
 * Agent 消息队列
 * 支持向运行中的后台 Agent 注入消息
 */

/** Agent 的待处理消息队列 */
const pendingMessages = new Map<string, string[]>();

/** 向 Agent 注入消息 */
export function injectMessageToAgent(agentId: string, message: string): void {
  const queue = pendingMessages.get(agentId) ?? [];
  queue.push(message);
  pendingMessages.set(agentId, queue);
}

/** 消费 Agent 的待处理消息（在对话循环中调用） */
export function drainAgentMessages(agentId: string): string[] {
  const queue = pendingMessages.get(agentId);
  if (!queue || queue.length === 0) return [];
  return queue.splice(0);
}

/** 检查 Agent 是否有待处理消息 */
export function hasAgentMessages(agentId: string): boolean {
  const queue = pendingMessages.get(agentId);
  return !!queue && queue.length > 0;
}

/** 清理 Agent 消息队列 */
export function clearAgentMessages(agentId: string): void {
  pendingMessages.delete(agentId);
}
