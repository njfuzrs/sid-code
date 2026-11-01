/**
 * 首帧信号：ink 第一次往 stdout 写内容的时刻。
 *
 * 两个消费者：
 *   1. 启动剖析的 `first_frame` 打点（G1）——用户「看见界面」的真实时刻；
 *   2. 启动维护子进程的拉起时机（`maintenance/launcher.ts`）——维护任务一律排在首帧之后，
 *      fork 子进程本身也有几毫秒，不该挡在首帧前面。
 *
 * 为什么挂在 stdout.write 上而不是 render() 返回之后：上游 render 只是建实例，
 * 首帧由 reconciler 调度写出；挂在 write 上测到的就是字节真正离开进程的时刻。
 */
import { profileCheckpoint } from "@sid-code/shared/utils/startup-profiler.ts";

let fired = false;
const waiters: Array<() => void> = [];

/** 标记首帧已写出（幂等，只有第一次生效） */
export function markFirstFrame(): void {
  if (fired) return;
  fired = true;
  profileCheckpoint("first_frame");
  for (const w of waiters.splice(0)) w();
}

/**
 * 首帧写出后 resolve。超时也 resolve：首帧因为任何原因没写出来（stdout 不是 TTY、渲染异常），
 * 依赖它的后台任务不能因此永远不跑。
 */
export function whenFirstFrame(timeoutMs = 5000): Promise<void> {
  if (fired) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    waiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * 在 stdout 上装一次性首帧探测。
 *
 * 刻意**不还原** stdout.write：之后别的模块可能在这层外面再包一层，
 * 此时把 write 改回原函数会把它们的包装一并拆掉。保留一个布尔判断的转发，代价可忽略。
 */
export function installFirstFrameProbe(stdout: NodeJS.WriteStream = process.stdout): void {
  if (fired) return;
  const original = stdout.write;
  stdout.write = function (this: NodeJS.WriteStream, ...args: unknown[]) {
    if (!fired) markFirstFrame();
    return (original as (...a: unknown[]) => boolean).apply(this, args);
  } as typeof stdout.write;
}
