/**
 * 类型安全的状态桥接器
 * 用事件驱动替代 50ms 轮询，外部调用 update() 时立即触发 React 状态更新
 *
 * 支持 pause/resume：流式输出期间暂停 ink 渲染更新，
 * 避免 StreamWriter 直接 stdout.write 与 ink eraseLines 竞争。
 * resume 时将暂停期间累积的 patch 合并为一次更新。
 */

import { EventEmitter } from "events";
import type { TUIState } from "./App.tsx";

export class StateBridge extends EventEmitter {
  current: TUIState;
  private paused = false;
  private pendingPatch: Partial<TUIState> | null = null;

  constructor(initial: TUIState) {
    super();
    this.current = initial;
  }

  /** 暂停事件派发，后续 update() 只累积 patch 不触发 ink 重渲染 */
  pause(): void {
    this.paused = true;
    this.pendingPatch = null;
  }

  /** 恢复事件派发，将暂停期间累积的 patch 合并为一次更新 */
  resume(): void {
    this.paused = false;
    if (this.pendingPatch) {
      const patch = this.pendingPatch;
      this.pendingPatch = null;
      this.current = { ...this.current, ...patch };
      this.emit("change", this.current);
    }
  }

  /** 是否处于暂停状态 */
  isPaused(): boolean {
    return this.paused;
  }

  /** 更新状态，暂停期间只累积 patch，不触发事件 */
  update(patch: Partial<TUIState>): void {
    this.current = { ...this.current, ...patch };
    if (this.paused) {
      // 累积 patch，resume 时一次性派发
      this.pendingPatch = { ...(this.pendingPatch || {}), ...patch };
      return;
    }
    this.emit("change", this.current);
  }
}
