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
