/**
 * createChildAbortController — 内存安全的父子取消层级
 * （对齐 Claude Code 的 abortController.ts）
 *
 * 解决两个问题：
 * 1. 父取消传播到子：父 abort 时子自动 abort（携带 reason）
 * 2. 监听器泄漏：子先完成/取消时，自动移除挂在父信号上的监听器，
 *    防止长生命周期的父（如主会话）累积大量死监听器
 *
 * 内存安全设计：
 * - 子被 abort 时（无论是被父传播还是自身原因）都清理父上的监听器
 * - 用 { once: true } + 子的 abort 回调双保险，确保监听器最终被移除
 * - 模块级处理函数 + 闭包捕获最小集，避免每次创建大闭包
 *
 * 用法：
 *   const child = createChildAbortController(parentSignal);
 *   // ... 用 child.signal 传给下游
 *   // 子完成后：child.abort() 或让其自然 GC，父上的监听器已被清理
 */

export interface ChildAbortController {
  /** 子 AbortController（暴露 signal 给下游、abort() 给调用者主动取消） */
  controller: AbortController;
  /** 子的 signal（便捷访问） */
  signal: AbortSignal;
  /** 主动取消子，并清理父监听器 */
  abort: (reason?: unknown) => void;
  /** 仅清理父监听器（子已自然完成时调用，幂等） */
  dispose: () => void;
}

/**
 * 创建一个挂在 parentSignal 下的子 AbortController。
 *
 * @param parentSignal 父信号（可选）。无父信号时返回独立 controller。
 */
export function createChildAbortController(
  parentSignal?: AbortSignal,
): ChildAbortController {
  const controller = new AbortController();

  // 无父信号：独立 controller，dispose/abort 退化为普通操作
  if (!parentSignal) {
    return {
      controller,
      signal: controller.signal,
      abort: (reason?: unknown) => controller.abort(reason),
      dispose: () => {},
    };
  }

  // 快速路径：父已取消，直接 abort 子
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return {
      controller,
      signal: controller.signal,
      abort: (reason?: unknown) => controller.abort(reason),
      dispose: () => {},
    };
  }

  // 父 → 子传播
  const onParentAbort = () => {
    controller.abort(parentSignal.reason);
  };
  parentSignal.addEventListener("abort", onParentAbort, { once: true });

  // 子被 abort（任何原因）时，主动移除父上的监听器，防止泄漏
  const dispose = () => {
    parentSignal.removeEventListener("abort", onParentAbort);
  };
  controller.signal.addEventListener("abort", dispose, { once: true });

  return {
    controller,
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
    dispose,
  };
}
