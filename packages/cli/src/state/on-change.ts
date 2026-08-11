/**
 * AppState 变更的集中副作用处理
 * 所有 AppState 变更都经过这个函数，避免副作用散布在各处导致遗漏
 */

import type { AppState } from "./app-state.ts";
import { setMainLoopModelOverride } from "./bootstrap.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";

export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState;
  oldState: AppState;
}): void {
  const log = getLogger();

  // 模型变更 → 同步到 BootstrapState
  if (newState.model !== oldState.model) {
    setMainLoopModelOverride(newState.model || null);
    log.debug("STATE", `模型变更: ${oldState.model} → ${newState.model}`);
  }

  // 权限模式变更 → 日志记录
  if (newState.permissionMode !== oldState.permissionMode) {
    log.info("STATE", `权限模式变更: ${oldState.permissionMode} → ${newState.permissionMode}`);
  }

  // 流式状态变更 → 性能追踪
  if (newState.streamingStatus !== oldState.streamingStatus) {
    log.debug("STATE", `流式状态: ${oldState.streamingStatus} → ${newState.streamingStatus}`);
  }

  // 成本变更 → 预算检查
  if (newState.costUSD !== oldState.costUSD) {
    if (newState.costLimit > 0 && newState.costUSD >= newState.costLimit) {
      log.warn("STATE", `成本已达上限: $${newState.costUSD.toFixed(4)} / $${newState.costLimit}`);
    }
  }

  // MCP 连接状态变更 → 日志
  if (newState.mcpConnections !== oldState.mcpConnections) {
    const connected = newState.mcpConnections.filter(c => c.status === "connected").length;
    const total = newState.mcpConnections.length;
    log.debug("STATE", `MCP 连接: ${connected}/${total}`);
  }
}
