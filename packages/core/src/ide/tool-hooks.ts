/**
 * IDE 工具执行集成
 *
 * 在文件编辑工具执行后，于 IDE 中展示 diff 视图。
 *
 * 注意（与原 spec §5.2.7 的差异）：
 * sid-code 的 PostToolUse hook 载荷（PostToolUseInput）不携带文件的
 * 原始/新内容，且 hook 系统不暴露程序式 `.on()` 注册接口。因此本模块
 * 提供可被调用的 diff 展示函数，由持有 old/new 内容的一方（编辑工具或
 * 其上层）显式调用，而非通过 hook 事件被动触发。
 */

import type { MCPManager } from "../mcp/manager.ts";
import { showDiffInIDE, closeAllDiffTabs, type DiffResult } from "./diff.ts";
import { IDE_SERVER_NAME } from "./integration.ts";

/**
 * 文件编辑后在 IDE 中展示 diff（非阻塞，IDE 未连接时静默跳过）。
 * @returns diff 展示结果；IDE 未连接返回 unsupported
 */
export async function showEditDiffInIDE(
  mcpManager: MCPManager,
  filePath: string,
  oldContent: string,
  newContent: string,
): Promise<DiffResult> {
  if (!mcpManager.isConnected(IDE_SERVER_NAME)) {
    return { action: "unsupported" };
  }
  return showDiffInIDE(mcpManager, filePath, oldContent, newContent);
}

/**
 * Agent 循环结束时清理 IDE 中残留的 diff 标签页。
 * 在主循环 end_turn / abort 时调用。
 */
export async function cleanupIDEDiffTabs(mcpManager: MCPManager | undefined): Promise<void> {
  if (!mcpManager) return;
  await closeAllDiffTabs(mcpManager);
}
