/**
 * 类型安全的状态桥接器
 * 用事件驱动替代 50ms 轮询，外部调用 update() 时立即触发 React 状态更新
 */

import { EventEmitter } from "events";
import type { TUIState, TaskDisplayInfo } from "./App.tsx";
import { getAllTasks, isAgentTask, isShellTask, onTaskChanged, offTaskChanged } from "../task/index.ts";

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
        durationMs: (t.endTime ?? Date.now()) - t.startTime,
      };
      if (isAgentTask(t)) {
        info.agentType = t.agentType;
        if (t.progress) {
          info.progress = {
            toolUseCount: t.progress.toolUseCount,
            tokenCount: t.progress.tokenCount,
          };
        }
        if (t.progressSummary) {
          info.progressSummary = t.progressSummary;
        }
      }
      if (isShellTask(t)) {
        info.command = t.command;
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
    contextPercent: 0,
    statusMessage: "",
    lastToolResult: null,
    streamingText: "",
    streamingThinking: "",
    isStreaming: false,
    streamingLine: "",
    permissionRequest: null,
    shellConfirmRequest: null,
    activeDialog: null,
    todos: [],
    tasks: [],
    retryStatus: null,
  };
}
