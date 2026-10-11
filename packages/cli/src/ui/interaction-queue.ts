/**
 * 交互式确认的串行队列（权限 / Shell 确认 / Plan 审批 / 提问 / 并发冲突）。
 *
 * 为什么需要它：这几类请求在 UI state 里各只有**一个格子**（`permissionRequest` 等），
 * 旧实现收到请求就直接 `updateState({ xxxRequest })`。两个请求同时到（并行子代理、
 * 后台子代理与主循环各自要确认、MCP elicitation 撞上权限框）时，后一个把前一个盖掉：
 * 屏幕上只剩后一个，前一个的 resolve 再也没人调，那次工具调用一直挂到 abort 才按拒绝解开。
 * 而不同类型之间又靠 DialogSwitch 的固定优先级只显示一个，被压住的那个照样可能被同类覆盖。
 *
 * 做法：所有确认先排队拿到「显示权」再写 state，答完释放给下一个，FIFO。
 * 排队期间 signal abort 的请求直接出队（返回 null，调用方按各自的保守默认闭合），
 * 不会出现「轮到它时才发现早已取消」的孤儿弹窗。
 */

export type InteractionRelease = () => void;

interface Waiter {
  start: () => void;
}

export class InteractionQueue {
  private busy = false;
  private waiters: Waiter[] = [];

  /** 还在排队、尚未显示的确认数（不含当前正在显示的那个） */
  get waitingCount(): number {
    return this.waiters.length;
  }

  /**
   * 拿到显示权后 resolve 一个 release 函数（必须调用，重复调用无副作用）。
   * 排队期间 signal abort → resolve null，调用方不要再显示弹窗。
   */
  acquire(signal?: AbortSignal): Promise<InteractionRelease | null> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(null);
        return;
      }
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          resolve(null);
        }
      };
      const waiter: Waiter = {
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          this.busy = true;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.busy = false;
            this.waiters.shift()?.start();
          });
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (this.busy) this.waiters.push(waiter);
      else waiter.start();
    });
  }

  /** 拿显示权 → 跑 show → 无论成败都释放。排队期间被 abort 时返回 onAborted() 的值。 */
  async run<T>(show: () => Promise<T>, onAborted: () => T, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    if (!release) return onAborted();
    try {
      return await show();
    } finally {
      release();
    }
  }
}
