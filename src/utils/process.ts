/**
 * 进程级 stdout/stderr 错误处理模块
 *
 * 对标 claude-code src/utils/process.ts。
 * 目标：当终端被关闭（VS Code PTY 销毁）时，防止 EIO/EPIPE 错误
 * 从 Ink 渲染管线抛出 uncaughtException 导致进程崩溃。
 *
 * 防御原理：
 * - 注册 'error' 事件处理器后，Node.js/Bun 不会将 write 失败作为同步异常抛出
 * - 而是通过事件通知；处理器中 destroy() 流使后续 write 变成 no-op
 * - claude-code 仅处理 EPIPE；本实现同时覆盖 EIO（VS Code 终端关闭场景）
 */

/**
 * 注册 process.stdout / process.stderr 错误处理器。
 * 必须在 Ink 渲染启动前调用。
 *
 * 当终端关闭（EIO）或管道断开（EPIPE）时：
 * - Node.js/Bun 的 write() 不再抛同步异常，而是触发 'error' 事件
 * - 处理器调用 stream.destroy() 使后续 write 静默失败
 * - 主渲染循环由此不会被 EIO 中断
 */
export function registerProcessOutputErrorHandlers(): void {
  const handleDestroy = (stream: NodeJS.WriteStream) => (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE" || err.code === "EIO") {
      stream.destroy();
    }
  };
  process.stdout.on("error", handleDestroy(process.stdout));
  process.stderr.on("error", handleDestroy(process.stderr));
}

/**
 * 强制进程退出，处理终端已死导致的 EIO（对标 claude-code forceExit）。
 * 当 process.exit() 因 dead terminal throw EIO 时回退到 SIGKILL。
 */
export function forceExit(exitCode: number): never {
  // 测试环境下 process.exit 可能被 mock，直接调用
  if (process.env.NODE_ENV === "test") {
    process.exit(exitCode);
  }
  try {
    process.exit(exitCode);
  } catch {
    // 生产环境：dead terminal 导致 process.exit() 抛 EIO
    // 回退到 SIGKILL（不 flush stdout）
    process.kill(process.pid, "SIGKILL");
  }
  // 理论上不可达；防止 TypeScript 返回类型推断错误
  throw new Error("unreachable: forceExit did not exit");
}
