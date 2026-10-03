/** 测试专用。render/lastFrame 走非 TTY 整帧输出，覆盖不到增量 diff（设计文档 §3 L1 的盲区）。 */
export { render } from "@sid-code/tui-renderer/_vendor/testing.tsx";
export { renderSync } from "@sid-code/tui-renderer/root.ts";
import legacyInstances from "@sid-code/tui-renderer/instances.ts";

/**
 * 从实例注册表里摘掉这个 stdout 的实例。正常卸载会自己摘；`detachForShutdown` 之后
 * unmount 早退、不会摘（X4），同一个 stdout 再 render 会复用那个已卸载的实例。
 */
export function forgetRenderInstance(stdout: NodeJS.WriteStream): void {
  legacyInstances.delete(stdout);
}

/**
 * 在测试进程里打开真实的帧调度（16ms 节流 + microtask 合并，契约 R2），返回恢复函数。
 *
 * 测试环境默认**每次提交同步出帧**（契约 R13）——全仓几千个 `lastFrame()` 断言靠它，
 * 所以只有专门测调度的用例才调这个。legacy 的开关是 `NODE_ENV`（reconciler 每次提交都读），
 * 收在端口里是为了让测试不依赖这个实现细节：新底座换别的开关，只改这一处。
 */
export function enableFrameThrottle(): () => void {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  return () => {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  };
}
