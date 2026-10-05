/**
 * 异步 Hook 注册表
 * 管理后台运行的异步 Hook，支持 asyncRewake 模式（退出码 2 时唤醒模型）
 */

export interface AsyncHookEntry {
  id: string;
  hookName: string;
  startTime: number;
  completed: boolean;
  exitCode?: number;
  stderr?: string;
}

export interface RewakeNotification {
  hookId: string;
  hookName: string;
  error: string;
}

export class AsyncHookRegistry {
  private pending = new Map<string, AsyncHookEntry>();
  private rewakeQueue: RewakeNotification[] = [];

  register(hookName: string): string {
    const id = crypto.randomUUID();
    this.pending.set(id, {
      id,
      hookName,
      startTime: Date.now(),
      completed: false,
    });
    return id;
  }

  /**
   * @param rewake 是否允许 exit 2 回灌。H18：原先调用方靠「非 rewake 时传 0」来关回灌，
   *   真实退出码因此被抹掉；现在两件事分开传。缺省 true 保持旧调用方语义。
   */
  markCompleted(id: string, exitCode: number, stderr?: string, rewake = true): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    entry.completed = true;
    entry.exitCode = exitCode;
    entry.stderr = stderr;

    if (rewake && exitCode === 2 && stderr) {
      this.rewakeQueue.push({
        hookId: id,
        hookName: entry.hookName,
        error: stderr,
      });
    }
  }

  drainRewakeNotifications(): RewakeNotification[] {
    const notifications = [...this.rewakeQueue];
    this.rewakeQueue = [];
    return notifications;
  }

  hasRewakeNotifications(): boolean {
    return this.rewakeQueue.length > 0;
  }

  cleanup(): void {
    for (const [id, entry] of this.pending) {
      if (entry.completed) {
        this.pending.delete(id);
      }
    }
  }

  get size(): number {
    return this.pending.size;
  }
}
