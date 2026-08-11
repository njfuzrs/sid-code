/**
 * sequential — 串行化包装器（对齐 Claude Code 的 sequential.ts）
 *
 * 将任意异步函数包装为串行执行：无论调用者并发调用多少次，
 * 内部始终一个接一个执行，永不重叠。
 *
 * 特性：
 * - 保序：调用顺序 = 执行顺序 = 结果返回顺序
 * - 非阻塞入队：调用者立即拿到 Promise，不阻塞
 * - 错误隔离：一个调用失败（reject）不影响队列中后续调用的执行
 * - this 保留：通过 fn.apply(this, args) 保留调用上下文
 *
 * 适用场景：文件写入、会话状态持久化、配置文件更新等
 * 「必须串行、并发会损坏数据」的操作。
 */

export function sequential<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  // 队列尾部 Promise：每次调用都挂在它后面，形成串行链。
  // 用 .catch 吞掉错误只是为了让链条延续（错误隔离），
  // 真正的结果/错误通过下面包装的 Promise 透传给调用者。
  let tail: Promise<unknown> = Promise.resolve();

  return function (this: unknown, ...args: T): Promise<R> {
    const run = tail.then(() => fn.apply(this, args));
    // 链条延续：无论本次成功失败，下一个调用都能接着排队执行
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
