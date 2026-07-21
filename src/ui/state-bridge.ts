/**
 * 类型安全的状态桥接器
 * 用事件驱动替代 50ms 轮询，外部调用 update() 时立即触发 React 状态更新
 */

import { EventEmitter } from "events";
import type { TUIState, TaskDisplayInfo } from "./App.tsx";
import { getAllTasks, isAgentTask, isShellTask, isWorkflowTask, onTaskChanged, offTaskChanged } from "../task/index.ts";

export class StateBridge extends EventEmitter {
  current: TUIState;
  /** 任务变更监听器引用（用于清理） */
  private _taskChangeHandler: (() => void) | null = null;

  constructor(initial: TUIState) {
    super();
    this.current = initial;

    // M5: 订阅任务变更事件，自动同步到 TUI 状态（事件驱动刷新）
    this._taskChangeHandler = () => this.updateTasks();
    onTaskChanged(this._taskChangeHandler);
  }

  /** 取消任务变更订阅 */
  detach(): void {
    if (this._taskChangeHandler) {
      offTaskChanged(this._taskChangeHandler);
      this._taskChangeHandler = null;
    }
  }

  /** 更新状态并触发事件 */
  update(patch: Partial<TUIState>): void {
    this.current = { ...this.current, ...patch };
    this.emit("change", this.current);
  }

  /** 从 Task 注册表拉取最新任务列表并更新 TUI 状态 */
  updateTasks(): void {
    const all = getAllTasks();
    const taskInfos: TaskDisplayInfo[] = all.map(t => {
      const info: TaskDisplayInfo = {
        id: t.id,
        type: t.type,
        status: t.status,
        description: t.description,
        startTime: t.startTime,
        endTime: t.endTime,
        durationMs: (t.endTime ?? Date.now()) - t.startTime,
      };
      if (isAgentTask(t)) {
        info.agentType = t.agentType;
        if (t.progress) {
          info.progress = {
            toolUseCount: t.progress.toolUseCount,
            tokenCount: t.progress.tokenCount,
          };
          if (t.progress.lastActivity?.activityDescription) {
            info.lastActivity = t.progress.lastActivity.activityDescription;
          }
        }
        if (t.progressSummary) {
          info.progressSummary = t.progressSummary;
        }
        // 子代理 verbose 详情（Ctrl+O expandLevel≥1 展开）：透传最近工具活动序列。
        if (t.progress?.recentActivities?.length) {
          info.recentActivities = t.progress.recentActivities
            .map((a) => a.activityDescription || a.toolName)
            .filter((s): s is string => !!s);
        }
      }
      if (isShellTask(t)) {
        info.command = t.command;
      }
      if (isWorkflowTask(t)) {
        // workflow 任务:用 agentType 槽位展示 workflow 名,进度展示 agent 调用数 + 当前 phase
        info.agentType = `workflow:${t.workflowName}`;
        info.progress = {
          toolUseCount: t.agentCount ?? 0,
          tokenCount: t.progress?.tokenCount ?? 0,
        };
        if (t.currentPhase) {
          info.lastActivity = `phase: ${t.currentPhase}`;
        }
      }
      return info;
    });
    this.update({ tasks: taskInfos });
  }
}

/** /clear 后用于恢复空白会话视图的状态补丁 */
export function getConversationClearedPatch(): Partial<TUIState> {
  return {
    messages: [],
    displayItems: [],
    historyItems: [],
    toolName: null,
    toolInput: null,
    isToolExecuting: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    stockInputTokens: 0,
    costUSD: 0,
    cacheSavingsUSD: 0,
    contextPercent: 0,
    statusMessage: "",
    lastToolResult: null,
    streamingText: "",
    streamingThinking: "",
    isStreaming: false,
    streamingLine: "",
    permissionRequest: null,
    shellConfirmRequest: null,
    // P1-2：对照完整 TUIState 补齐遗漏字段——否则 /clear 时若有待审批计划，
    // 审批框不消失（planApprovalRequest 最该修）；加载态/Copy 模式/plan 模式标志亦可能残留。
    planApprovalRequest: null,
    askUserQuestionRequest: null,
    isLoading: false,
    copyModeEnabled: false,
    isPlanMode: false,
    // /clear 后本轮输出基线归零——否则 Composer 用旧 turnStartOutputTokens 作差，
    // 清空会话后首条消息的"本轮输出 token"会算出负数或虚高（App.tsx:160 字段，Composer.tsx:177 作差）。
    turnStartOutputTokens: 0,
    activeDialog: null,
    // /clear 后 goal 状态栏列归零：否则旧 /goal 目标进度残留
    goalDisplay: null,
    // /clear 后流式思考时间戳归零：否则下次思考计时起点漂移
    streamingThinkingStartMs: undefined,
    // /clear 后滚动位置重置：回到底部
    scrollPercent: undefined,
    // /clear 后会话标题重置：新对话不应沿用旧标题
    sessionTitle: null,
    todos: [],
    tasks: [],
    retryStatus: null,
    errorPanel: [],
  };
}
