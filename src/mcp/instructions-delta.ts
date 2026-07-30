/**
 * MCP 指令增量通知
 * 当 MCP Server 在对话过程中连接成功时，instructions 以增量方式注入
 */

import type { MCPServerStatusInfo } from "./manager.ts";

/**
 * 获取新连接的 MCP Server instructions（尚未通知过的）
 */
export function getMcpInstructionsDelta(
  serverStatuses: MCPServerStatusInfo[],
  announcedServers: Set<string>,
): { added: string[]; blocks: string[] } | null {
  const connected = serverStatuses.filter(
    s => s.status === 'connected' && s.instructions && !announcedServers.has(s.name)
  );
  if (connected.length === 0) return null;

  return {
    added: connected.map(s => s.name),
    blocks: connected.map(s => `## ${s.name}\n${s.instructions}`),
  };
}

/**
 * 构建 MCP 指令全量 section（**当前无生产调用点**，仅测试驱动）。
 *
 * @deprecated 生产路径请用 {@link getMcpInstructionsDelta} + `query/loop.ts` 的 reminder
 * 注入（增量、带围栏）。本函数保留仅为兼容"一次性拿到全量说明"的调试场景。
 *
 * ⚠️ 两条别再踩回去的坑（2026-07-29 实测事故，轨迹 20260729-180624-b8ae8e78）：
 *
 * 1. **必须带 `<system-reminder>` 围栏**。原实现产出裸 `# MCP Server Instructions`，
 *    与用户 prompt 的 `# Commit:` 形态完全混同 —— glm-5.2 因此分不清"谁在说话"，
 *    转而抓 system prompt 记忆索引里的一条陈述句当用户意图，第一轮跑去 glob 记忆文件。
 *    围栏是 OpenAI 族的**唯一**保底边界（多 text block 在 wire 上会被 join 成单 string，
 *    block 边界丢失，只剩标签文本本身可依）。详见 `query/reminder-inject.ts` 不变量 1。
 * 2. **不要用 `#` markdown 标题开头**。标题层级越浅，越像"一段新的用户输入"。
 *
 * 这两条与 `loop.ts` 里增量注入的文案保持同形，避免哪天有人接线时把旧形态带回来。
 */
export function buildMcpInstructionsSection(
  serverStatuses: MCPServerStatusInfo[],
): string {
  const connected = serverStatuses.filter(
    s => s.status === 'connected' && s.instructions
  );
  if (connected.length === 0) return '';

  const blocks = connected.map(
    s => `## ${s.name}\n${s.instructions}`
  ).join('\n\n');

  return (
    `<system-reminder>\n` +
    `MCP Server Instructions（harness 注入的服务器使用说明，非用户输入）：\n\n` +
    `以下 MCP 服务器提供了使用说明，请在使用对应工具时遵循这些指令：\n\n` +
    blocks +
    `\n</system-reminder>`
  );
}
