/**
 * 终端事件基类 — P1-1
 *
 * 类浏览器 DOM Event 接口,用于在组件树上做捕获/冒泡两阶段分发。
 * 与 KeypressContext 的扁平优先级系统共存:优先级系统处理全局快捷键,
 * 树分发处理嵌套 UI(对话框/覆盖层/确认队列)的事件路由。
 */

import type { Key } from "../contexts/KeypressContext.ts";

export class TerminalEvent {
  /** 事件类型,如 "keyboard" / "click" / "focus" / "blur" */
  type: string;
  /** 事件最初的目标节点 */
  target: EventTarget | null = null;
  /** 当前正在处理事件的节点(分发过程中变化) */
  currentTarget: EventTarget | null = null;
  /** 事件所处阶段 */
  eventPhase: "none" | "capture" | "bubble" = "none";

  private _propagationStopped = false;
  private _immediatePropagationStopped = false;
  private _defaultPrevented = false;

  constructor(type: string) {
    this.type = type;
  }

  /** 停止向后续节点传播(当前节点剩余 handler 仍会执行) */
  stopPropagation(): void {
    this._propagationStopped = true;
  }

  /** 立即停止传播(当前节点剩余 handler 也不执行) */
  stopImmediatePropagation(): void {
    this._immediatePropagationStopped = true;
    this._propagationStopped = true;
  }

  preventDefault(): void {
    this._defaultPrevented = true;
  }

  get propagationStopped(): boolean {
    return this._propagationStopped;
  }
  get immediatePropagationStopped(): boolean {
    return this._immediatePropagationStopped;
  }
  get defaultPrevented(): boolean {
    return this._defaultPrevented;
  }
}

export class KeyboardEvent extends TerminalEvent {
  constructor(public readonly key: Key) {
    super("keyboard");
  }
}

export class ClickEvent extends TerminalEvent {
  constructor(
    public readonly row: number,
    public readonly col: number,
    public readonly button: number,
  ) {
    super("click");
  }
}

export class FocusEvent extends TerminalEvent {
  constructor(
    type: "focus" | "blur",
    public readonly relatedTarget: EventTarget | null,
  ) {
    super(type);
  }
}

export type EventHandler = (event: TerminalEvent) => void;

/**
 * 可参与事件分发的节点。
 * 由 React 组件通过 ref 提供;parentNode 链构成分发路径。
 */
export interface EventTarget {
  parentNode: EventTarget | null;
  captureHandlers: Map<string, Set<EventHandler>>;
  bubbleHandlers: Map<string, Set<EventHandler>>;
}

/** 创建一个空的 EventTarget(供组件初始化 ref) */
export function createEventTarget(parentNode: EventTarget | null = null): EventTarget {
  return {
    parentNode,
    captureHandlers: new Map(),
    bubbleHandlers: new Map(),
  };
}
