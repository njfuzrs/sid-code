/**
 * BootstrapState — 进程级全局状态（叶子模块，零业务依赖）
 * 对标 Claude Code 的 bootstrap/state.ts
 * 纯 getter/setter 函数访问，非响应式，任何模块可安全 import
 */

import { generateSessionId } from "@sid-code/core/session/id.ts";

/** 模型用量统计 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  requests: number;
  costUSD: number;
}

/** 进程级状态 */
interface BootstrapState {
  sessionId: string;
  originalCwd: string;
  cwd: string;

  totalCostUSD: number;
  totalAPIDuration: number;
  totalToolDuration: number;
  modelUsage: Record<string, ModelUsage>;

  turnToolDurationMs: number;
  turnToolCount: number;
  turnAPIDurationMs: number;
  turnAPICount: number;

  mainLoopModelOverride: string | null;
  initialMainLoopModel: string;

  isInteractive: boolean;
  startTime: number;

  errorLog: Array<{ timestamp: number; message: string; stack?: string }>;
}

const STATE: BootstrapState = {
  sessionId: generateSessionId(),
  originalCwd: process.cwd(),
  cwd: process.cwd(),
  totalCostUSD: 0,
  totalAPIDuration: 0,
  totalToolDuration: 0,
  modelUsage: {},
  turnToolDurationMs: 0,
  turnToolCount: 0,
  turnAPIDurationMs: 0,
  turnAPICount: 0,
  mainLoopModelOverride: null,
  initialMainLoopModel: "",
  isInteractive: true,
  startTime: Date.now(),
  errorLog: [],
};

// ═══ Getter ═══
export function getSessionId(): string { return STATE.sessionId; }
/**
 * @deprecated cwd 全局状态已收敛到 `bootstrap/state.ts`（持久 Shell 会话 P0-2）。
 * bash 工具写回、path-utils 读取的均为那一套。本套 cwd 无任何引用，保留仅为兼容，
 * 切勿在新代码中读写本套 cwd，否则与 `bootstrap/state.ts` 漂移。
 */
export function getCwd(): string { return STATE.cwd; }
export function getOriginalCwd(): string { return STATE.originalCwd; }
export function getTotalCostUSD(): number { return STATE.totalCostUSD; }
export function getTotalAPIDuration(): number { return STATE.totalAPIDuration; }
export function getTotalToolDuration(): number { return STATE.totalToolDuration; }
export function getModelUsage(): Record<string, ModelUsage> { return STATE.modelUsage; }
export function getMainLoopModelOverride(): string | null { return STATE.mainLoopModelOverride; }
export function isInteractive(): boolean { return STATE.isInteractive; }
export function getStartTime(): number { return STATE.startTime; }
export function getTurnMetrics() {
  return {
    toolDurationMs: STATE.turnToolDurationMs,
    toolCount: STATE.turnToolCount,
    apiDurationMs: STATE.turnAPIDurationMs,
    apiCount: STATE.turnAPICount,
  };
}

// ═══ Setter ═══
export function setSessionId(id: string): void { STATE.sessionId = id; }
/**
 * @deprecated 见 getCwd 的弃用说明。cwd 真相源为 `bootstrap/state.ts`，本套勿写。
 */
export function setCwd(cwd: string): void { STATE.cwd = cwd; }
export function setMainLoopModelOverride(model: string | null): void {
  STATE.mainLoopModelOverride = model;
}
export function setIsInteractive(interactive: boolean): void {
  STATE.isInteractive = interactive;
}
export function setInitialMainLoopModel(model: string): void {
  STATE.initialMainLoopModel = model;
}

// ═══ 累加器 ═══
export function addToToolDuration(durationMs: number): void {
  STATE.totalToolDuration += durationMs;
  STATE.turnToolDurationMs += durationMs;
  STATE.turnToolCount++;
}

export function addToAPIDuration(durationMs: number): void {
  STATE.totalAPIDuration += durationMs;
  STATE.turnAPIDurationMs += durationMs;
  STATE.turnAPICount++;
}

export function addToCost(model: string, cost: number, usage: ModelUsage): void {
  STATE.totalCostUSD += cost;
  STATE.modelUsage[model] = usage;
}

export function resetTurnMetrics(): void {
  STATE.turnToolDurationMs = 0;
  STATE.turnToolCount = 0;
  STATE.turnAPIDurationMs = 0;
  STATE.turnAPICount = 0;
}

// ═══ 错误日志 ═══
export function logError(message: string, stack?: string): void {
  STATE.errorLog.push({ timestamp: Date.now(), message, stack });
  if (STATE.errorLog.length > 100) STATE.errorLog.shift();
}
export function getErrorLog() { return STATE.errorLog; }
