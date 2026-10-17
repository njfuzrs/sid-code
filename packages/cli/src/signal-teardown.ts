/**
 * 退出信号的收尾调度（S15）。
 *
 * ⚠️ 为什么不能用 `process.once`：`once` 触发一次后监听器被摘除，**第二个同类信号走默认处置
 * 直接终止进程**。关终端时 SIGHUP 常常连发（pty 关闭 + shell 转发），第二发到达时收尾还在
 * `await race`（1.2s）里，于是 messages.json / session-summary.json / heartbeat 撤销 / PID 清理
 * 全部丢失 —— 实测信号路径会话 0/209 落盘，而退出码同为 129，**看退出码分不出**。
 *
 * 所以这里一直挂着监听器（`on`），用一个状态位挡住重入，第二个信号由 `decideRepeatSignal` 处置。
 */

export type TeardownSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

/** handler 运行超过这么久仍未完成，再来同类 SIGTERM / SIGHUP 就直接退出（视为卡死）。 */
export const STUCK_TEARDOWN_MS = 2_000;

export type RepeatSignalAction = "start" | "ignore" | "force_exit";

/**
 * 信号到达时怎么处置。纯函数，便于单测钉住策略。
 *
 * - 第一个信号：开始收尾。
 * - 收尾中又来 SIGINT：强退。只有 headless 会真收到 SIGINT（TUI 是 `exitOnCtrlC:false`，
 *   raw mode 下 Ctrl+C 不产生 SIGINT），「连按两次 Ctrl+C 强退」与现状一致。
 * - 收尾中又来 SIGTERM / SIGHUP：先只记录，**让收尾跑完**；但 handler 已运行超过
 *   `STUCK_TEARDOWN_MS` 仍未完成时直接退出 —— 事件循环被同步卡死时 1.5s 的 forceExitTimer
 *   触发不了，若重复信号也一律忽略，进程就只剩 SIGKILL 一条路（现状下第二个信号还能杀掉它）。
 */
export function decideRepeatSignal(
  inFlight: { startedAt: number } | null,
  signal: TeardownSignal,
  nowMs: number,
): RepeatSignalAction {
  if (!inFlight) return "start";
  if (signal === "SIGINT") return "force_exit";
  return nowMs - inFlight.startedAt > STUCK_TEARDOWN_MS ? "force_exit" : "ignore";
}

export interface TeardownSignalDeps {
  /** 真正的收尾（SessionEnd 落盘 → 清理 → process.exit）。只会被调用一次。 */
  run: (signal: TeardownSignal) => Promise<void> | void;
  /** 强退：重复信号判为强退时调用。 */
  forceExit: (signal: TeardownSignal) => void;
  /** 每个到达的信号都回调一次（含第一个），用于「信号到达计数」度量。 */
  onArrival?: (signal: TeardownSignal, action: RepeatSignalAction, count: number) => void;
  now?: () => number;
  /** 注入点，测试用；缺省为 `process`。 */
  target?: { on(event: TeardownSignal, listener: () => void): unknown };
}

export interface TeardownSignalController {
  /**
   * 非信号来源也走同一条收尾（如终端流 EIO：终端已死，等价于收到 SIGHUP）。
   * 与真信号共用重入保护：已在收尾时再触发只按重复信号处置。
   */
  trigger: (signal: TeardownSignal) => void;
  /** 到目前为止到达的信号总数（含 trigger）。 */
  arrivals: () => number;
}

export function installTeardownSignalHandlers(deps: TeardownSignalDeps): TeardownSignalController {
  const now = deps.now ?? Date.now;
  const target = deps.target ?? process;
  let inFlight: { startedAt: number } | null = null;
  let count = 0;

  const handle = (signal: TeardownSignal) => {
    count++;
    const action = decideRepeatSignal(inFlight, signal, now());
    try {
      deps.onArrival?.(signal, action, count);
    } catch {
      /* 度量失败不影响收尾 */
    }
    if (action === "force_exit") {
      deps.forceExit(signal);
      return;
    }
    if (action === "ignore") return;
    inFlight = { startedAt: now() };
    // fire-and-forget：监听器本身不能 await，否则事件发射方会被卡住
    void Promise.resolve()
      .then(() => deps.run(signal))
      .catch(() => {
        /* run 自己负责兜底退出 */
      });
  };

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    target.on(sig, () => handle(sig));
  }

  return { trigger: handle, arrivals: () => count };
}

/**
 * 在终端输出流上判「终端已死」（S15，EIO 60/209 的击杀者）。
 *
 * 判据落在**流对象**上，不在 uncaughtException 里按错误字段猜（2026-10-17 Bun 1.4.2 pty 探针）：
 * - 关 pty 后每次写都是 `code=EIO, syscall=write`，`stdout.write` 本身不抛，错误只从
 *   `'error'` 事件出来；`err.fd` 恒为 undefined ⇒ 按 fd 判在 Bun 下永不命中；
 * - 只看 `code` 又会误吞写普通文件的 EIO。
 * 所以「哪个流对象发出的」就是判据：只监听传进来的这几个流。
 *
 * 命中后 destroy 该流（后续写变 no-op，不再每帧刷错误），`onDead` 只调用一次。
 */
export function watchTerminalOutputErrors(
  streams: NodeJS.WriteStream[],
  onDead: (err: NodeJS.ErrnoException) => void,
): void {
  let dead = false;
  for (const stream of streams) {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err?.code !== "EIO" && err?.code !== "EPIPE") return;
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
      if (dead) return;
      dead = true;
      onDead(err);
    });
  }
}
