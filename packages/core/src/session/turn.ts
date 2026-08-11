/**
 * Turn 级别管理
 * 将对话拆分为 Turn（单轮对话），每个 Turn 包含用户输入、LLM 响应、工具调用等
 */

import type { Message, Usage } from "../llm/types.ts";

/** 工具调用信息 */
export interface ToolCallInfo {
  /** 调用 ID */
  callId: string;
  /** 工具名称 */
  name: string;
  /** 工具参数 */
  args: Record<string, unknown>;
  /** 工具结果 */
  result?: any;
  /** 状态 */
  status: "pending" | "success" | "error";
  /** 时间戳 */
  timestamp: string;
  /** 耗时（毫秒） */
  durationMs?: number;
}

/** Turn 上下文 */
export interface TurnContext {
  /** Turn ID */
  turnId: string;
  /** 所属会话 ID */
  sessionId: string;
  /** 开始时间戳 */
  startTime: number;
  /** 使用的模型 */
  model: string;

  // 请求信息
  /** 用户消息 */
  userMessage: Message;

  // 响应信息
  /** 助手消息 */
  assistantMessage?: Message;
  /** 工具调用列表 */
  toolCalls: ToolCallInfo[];
  /** 结束原因 */
  finishReason?: string;

  // 统计信息
  /** Token 用量 */
  usage?: Usage;
  /** 总耗时 */
  durationMs?: number;
  /** API 耗时 */
  apiDurationMs?: number;
  /** 工具耗时 */
  toolDurationMs?: number;
}

/**
 * Turn 类
 * 管理单轮对话的完整生命周期
 */
export class Turn {
  readonly turnId: string;
  readonly sessionId: string;
  readonly startTime: number;
  readonly model: string;

  private userMessage: Message;
  private assistantMessage?: Message;
  private toolCalls: ToolCallInfo[] = [];
  private finishReason?: string;
  private usage?: Usage;
  private apiStartTime?: number;
  private apiEndTime?: number;

  constructor(sessionId: string, model: string, userMessage: Message) {
    this.turnId = crypto.randomUUID();
    this.sessionId = sessionId;
    this.model = model;
    this.startTime = Date.now();
    this.userMessage = userMessage;
  }

  /**
   * 开始 API 调用
   */
  startAPICall(): void {
    this.apiStartTime = Date.now();
  }

  /**
   * 结束 API 调用
   */
  endAPICall(): void {
    this.apiEndTime = Date.now();
  }

  /**
   * 添加工具调用
   */
  addToolCall(toolCall: ToolCallInfo): void {
    this.toolCalls.push(toolCall);
  }

  /**
   * 更新工具调用状态
   */
  updateToolCall(
    callId: string,
    updates: Partial<Omit<ToolCallInfo, "callId" | "name" | "args" | "timestamp">>
  ): void {
    const toolCall = this.toolCalls.find((tc) => tc.callId === callId);
    if (toolCall) {
      Object.assign(toolCall, updates);
    }
  }

  /**
   * 设置助手响应
   */
  setAssistantMessage(message: Message, finishReason: string): void {
    this.assistantMessage = message;
    this.finishReason = finishReason;
  }

  /**
   * 设置 Token 用量
   */
  setUsage(usage: Usage): void {
    this.usage = usage;
  }

  /**
   * 获取 Turn 上下文
   */
  getContext(): TurnContext {
    const now = Date.now();
    const durationMs = now - this.startTime;
    const apiDurationMs =
      this.apiStartTime && this.apiEndTime
        ? this.apiEndTime - this.apiStartTime
        : undefined;
    const toolDurationMs = this.toolCalls.reduce(
      (sum, tc) => sum + (tc.durationMs || 0),
      0
    );

    return {
      turnId: this.turnId,
      sessionId: this.sessionId,
      startTime: this.startTime,
      model: this.model,
      userMessage: this.userMessage,
      assistantMessage: this.assistantMessage,
      toolCalls: this.toolCalls,
      finishReason: this.finishReason,
      usage: this.usage,
      durationMs,
      apiDurationMs,
      toolDurationMs,
    };
  }

  /**
   * 获取总耗时
   */
  getDuration(): number {
    return Date.now() - this.startTime;
  }

  /**
   * 获取 API 耗时
   */
  getAPIDuration(): number | undefined {
    if (this.apiStartTime && this.apiEndTime) {
      return this.apiEndTime - this.apiStartTime;
    }
    return undefined;
  }

  /**
   * 获取工具耗时
   */
  getToolDuration(): number {
    return this.toolCalls.reduce((sum, tc) => sum + (tc.durationMs || 0), 0);
  }

  /**
   * 是否已完成
   */
  isCompleted(): boolean {
    return this.finishReason !== undefined;
  }

  /**
   * 获取工具调用数量
   */
  getToolCallCount(): number {
    return this.toolCalls.length;
  }

  /**
   * 获取成功的工具调用数量
   */
  getSuccessfulToolCallCount(): number {
    return this.toolCalls.filter((tc) => tc.status === "success").length;
  }

  /**
   * 获取失败的工具调用数量
   */
  getFailedToolCallCount(): number {
    return this.toolCalls.filter((tc) => tc.status === "error").length;
  }

  /**
   * 序列化为 JSON
   */
  toJSON(): TurnContext {
    return this.getContext();
  }

  /**
   * 从 JSON 恢复
   */
  static fromJSON(data: TurnContext): Turn {
    const turn = new Turn(data.sessionId, data.model, data.userMessage);
    (turn as any).turnId = data.turnId;
    (turn as any).startTime = data.startTime;
    turn.assistantMessage = data.assistantMessage;
    turn.toolCalls = data.toolCalls;
    turn.finishReason = data.finishReason;
    turn.usage = data.usage;
    return turn;
  }
}

/**
 * Turn 管理器
 * 管理会话中的所有 Turn
 */
export class TurnManager {
  private turns: Map<string, Turn> = new Map();
  private turnHistory: string[] = [];

  /**
   * 创建新 Turn
   */
  createTurn(sessionId: string, model: string, userMessage: Message): Turn {
    const turn = new Turn(sessionId, model, userMessage);
    this.turns.set(turn.turnId, turn);
    this.turnHistory.push(turn.turnId);
    return turn;
  }

  /**
   * 获取 Turn
   */
  getTurn(turnId: string): Turn | undefined {
    return this.turns.get(turnId);
  }

  /**
   * 获取最近的 Turn
   */
  getLatestTurn(): Turn | undefined {
    if (this.turnHistory.length === 0) return undefined;
    const latestId = this.turnHistory[this.turnHistory.length - 1];
    return this.turns.get(latestId);
  }

  /**
   * 获取所有 Turn
   */
  getAllTurns(): Turn[] {
    return this.turnHistory.map((id) => this.turns.get(id)!).filter(Boolean);
  }

  /**
   * 获取 Turn 数量
   */
  getTurnCount(): number {
    return this.turnHistory.length;
  }

  /**
   * 回退到指定 Turn
   * 返回被移除的 Turn 列表
   */
  rewindToTurn(turnId: string): Turn[] {
    const index = this.turnHistory.indexOf(turnId);
    if (index === -1) {
      throw new Error(`Turn ${turnId} 不存在`);
    }

    // 移除后续 Turn
    const removedIds = this.turnHistory.splice(index + 1);
    const removedTurns: Turn[] = [];

    for (const id of removedIds) {
      const turn = this.turns.get(id);
      if (turn) {
        removedTurns.push(turn);
        this.turns.delete(id);
      }
    }

    return removedTurns;
  }

  /**
   * 回退 N 轮
   */
  rewindByCount(count: number): Turn[] {
    if (count <= 0) return [];
    if (count >= this.turnHistory.length) {
      throw new Error(`无法回退 ${count} 轮，当前只有 ${this.turnHistory.length} 轮`);
    }

    const targetIndex = this.turnHistory.length - count - 1;
    const targetId = this.turnHistory[targetIndex];
    return this.rewindToTurn(targetId);
  }

  /**
   * 清空所有 Turn
   */
  clear(): void {
    this.turns.clear();
    this.turnHistory = [];
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalTurns: number;
    totalToolCalls: number;
    successfulToolCalls: number;
    failedToolCalls: number;
    totalDurationMs: number;
    totalAPIDurationMs: number;
    totalToolDurationMs: number;
  } {
    const turns = this.getAllTurns();
    return {
      totalTurns: turns.length,
      totalToolCalls: turns.reduce((sum, t) => sum + t.getToolCallCount(), 0),
      successfulToolCalls: turns.reduce(
        (sum, t) => sum + t.getSuccessfulToolCallCount(),
        0
      ),
      failedToolCalls: turns.reduce(
        (sum, t) => sum + t.getFailedToolCallCount(),
        0
      ),
      totalDurationMs: turns.reduce((sum, t) => sum + t.getDuration(), 0),
      totalAPIDurationMs: turns.reduce(
        (sum, t) => sum + (t.getAPIDuration() || 0),
        0
      ),
      totalToolDurationMs: turns.reduce((sum, t) => sum + t.getToolDuration(), 0),
    };
  }

  /**
   * 导出所有 Turn 上下文
   */
  exportTurns(): TurnContext[] {
    return this.getAllTurns().map((turn) => turn.getContext());
  }

  /**
   * 导入 Turn 上下文
   */
  importTurns(contexts: TurnContext[]): void {
    this.clear();
    for (const context of contexts) {
      const turn = Turn.fromJSON(context);
      this.turns.set(turn.turnId, turn);
      this.turnHistory.push(turn.turnId);
    }
  }
}
