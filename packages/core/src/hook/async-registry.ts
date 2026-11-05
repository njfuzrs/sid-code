/**
 * 异步 Hook 注册表
 * 管理后台运行的异步 Hook，支持 asyncRewake 模式（退出码 2 时唤醒模型）
 */

import { HOOK_ASYNC_COMPLETED_EVENT_NAME, emitHookTrace } from "./hook-telemetry.ts";

export interface AsyncHookEntry {
  id: string;
  hookName: string;
  /**
   * G1：与本次执行的 `HookExecuted.run_id` 相同。
   * 异步 hook 的 `HookExecuted` 只能表达「启动了」（outcome=async_started），
   * 后台进程真正跑完的成败靠 `HookAsyncCompleted` 补，两条必须能配成一对。
   */
  runId?: string;
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

  register(hookName: string, runId?: string): string {
    const id = crypto.randomUUID();
    this.pending.set(id, {
      id,
      hookName,
      runId,
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

    // G1：后台完成进轨迹。只记 run_id / exit_code / duration_ms —— hookName 在没有 name 时
    // 是 command 的前 40 个字符，可能含 token，不能进会被上传的 events.jsonl。
    emitHookTrace(HOOK_ASYNC_COMPLETED_EVENT_NAME, {
      run_id: entry.runId ?? `async-${entry.id}`,
      exit_code: exitCode,
      duration_ms: Date.now() - entry.startTime,
    });

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
