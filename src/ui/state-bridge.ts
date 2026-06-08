/**
 * 类型安全的状态桥接器
 * 用事件驱动替代 50ms 轮询，外部调用 update() 时立即触发 React 状态更新
 */

import { EventEmitter } from "events";
import type { TUIState } from "./App.tsx";

export class StateBridge extends EventEmitter {
  current: TUIState;

  constructor(initial: TUIState) {
    super();
    this.current = initial;
  }

  /** 更新状态并触发事件 */
  update(patch: Partial<TUIState>): void {
    this.current = { ...this.current, ...patch };
    this.emit("change", this.current);
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
    contextPercent: 0,
    statusMessage: "",
    lastToolResult: null,
    streamingText: "",
    isStreaming: false,
    streamingLine: "",
    permissionRequest: null,
    shellConfirmRequest: null,
    activeDialog: null,
    todos: [],
  };
}
