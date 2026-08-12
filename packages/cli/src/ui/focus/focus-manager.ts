/**
 * 焦点管理器(焦点栈) — P1-3
 *
 * 解决多层嵌套对话框关闭后的焦点自动恢复问题。
 *
 * 核心概念:
 * - activeElement: 当前拥有焦点的元素
 * - focusStack: 焦点历史栈(去重 + 上限 32),元素被移除时自动恢复到栈顶
 * - tabbable: 通过 Tab/Shift+Tab 在可聚焦元素间循环
 *
 * 注:与 Ink fork 自带的 useFocus/useFocusManager 不冲突 —— 那套面向
 * "哪个 ink 组件接收 useInput",这里面向应用层"对话框栈式焦点恢复",
 * 是纯逻辑层,可单测,不依赖渲染。
 */

export interface FocusableElement {
  id: string;
  onFocus?: () => void;
  onBlur?: () => void;
  /** >= 0 表示可通过 Tab 聚焦;undefined / < 0 表示仅程序聚焦 */
  tabIndex?: number;
}

export class FocusManager {
  static readonly MAX_STACK_SIZE = 32;

  private _activeElement: FocusableElement | null = null;
  private _focusStack: FocusableElement[] = [];

  get activeElement(): FocusableElement | null {
    return this._activeElement;
  }

  /** 当前焦点栈快照(只读副本,从栈底到栈顶) */
  get focusStack(): readonly FocusableElement[] {
    return [...this._focusStack];
  }

  /**
   * 聚焦到指定元素:
   * - 旧元素 blur
   * - 新元素去重后压栈(成为栈顶)
   * - 新元素 focus
   */
  focus(element: FocusableElement): void {
    const prev = this._activeElement;
    if (prev === element) return;

    prev?.onBlur?.();
    this._activeElement = element;

    // 去重后压栈,保证同一元素在栈中只出现一次
    this._focusStack = this._focusStack.filter((e) => e !== element);
    this._focusStack.push(element);
    if (this._focusStack.length > FocusManager.MAX_STACK_SIZE) {
      this._focusStack.shift();
    }

    element.onFocus?.();
  }

  /**
   * 元素被卸载时调用:
   * - 从栈中移除
   * - 若它是当前焦点,自动恢复到新的栈顶元素(并触发其 focus)
   */
  handleElementRemoved(element: FocusableElement): void {
    const wasActive = this._activeElement === element;
    this._focusStack = this._focusStack.filter((e) => e !== element);

    if (wasActive) {
      const next = this._focusStack[this._focusStack.length - 1] ?? null;
      this._activeElement = next;
      next?.onFocus?.();
    }
  }

  /** 主动放弃当前焦点(不卸载元素),恢复到栈中前一个 */
  blur(): void {
    const current = this._activeElement;
    if (!current) return;
    this.handleElementRemoved(current);
  }

  /** Tab:循环到下一个可聚焦元素 */
  focusNext(tabbable: FocusableElement[]): void {
    if (tabbable.length === 0) return;
    const idx = this._activeElement ? tabbable.indexOf(this._activeElement) : -1;
    const next = (idx + 1) % tabbable.length;
    this.focus(tabbable[next]);
  }

  /** Shift+Tab:循环到上一个可聚焦元素 */
  focusPrevious(tabbable: FocusableElement[]): void {
    if (tabbable.length === 0) return;
    const idx = this._activeElement ? tabbable.indexOf(this._activeElement) : 0;
    const prev = (idx - 1 + tabbable.length) % tabbable.length;
    this.focus(tabbable[prev]);
  }

  /** 测试/重置用:清空所有状态 */
  reset(): void {
    this._activeElement = null;
    this._focusStack = [];
  }
}
