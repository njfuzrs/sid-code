/**
 * next 骨架阶段（B9 / T1.3）还没实现的端口符号。
 *
 * 一律在**使用时**抛错，而不是导出 undefined 或空函数：CLI 有大量 `?.` 可选链，
 * 空实现会静默变成 no-op，「新底座少了一块」就只能靠肉眼发现。抛错信息带上负责实现它的任务号。
 */
import React from "react";

export class NotImplementedError extends Error {
  constructor(symbol: string, task: string) {
    super(`[render-port/next] ${symbol} 尚未实现（${task}）。用 SID_TUI_RENDERER=legacy 运行。`);
    this.name = "NotImplementedError";
  }
}

/** 函数 / hook：调用即抛。 */
export function notImplementedFn(symbol: string, task: string): (...args: never[]) => never {
  return () => {
    throw new NotImplementedError(symbol, task);
  };
}

/** 组件：渲染即抛（抛在 React 渲染阶段，走错误边界 / 卸载流程）。 */
export function notImplementedComponent(symbol: string, task: string): React.FC<never> {
  const C: React.FC<never> = () => {
    throw new NotImplementedError(symbol, task);
  };
  C.displayName = `NotImplemented(${symbol})`;
  return C;
}

/** 常量对象 / 类：读任何属性、构造、调用都抛。 */
export function notImplementedValue(symbol: string, task: string): never {
  const fail = () => {
    throw new NotImplementedError(symbol, task);
  };
  return new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive || key === "then" ? undefined : fail()),
    apply: fail,
    construct: fail,
  }) as never;
}
