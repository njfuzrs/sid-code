/**
 * TUI console 护栏：把 stderr 类 console 输出转进日志，不让它砸在终端上。
 *
 * ## 为什么需要这层（2026-08-04 刷屏事故的第二道防线）
 *
 * 已有的 `patchStderr`（`src/ink/ink.tsx`）拦的是**裸 `process.stderr.write`**。
 * 但 `console.error` 走的是**另一条信道**：Node 的 console 实现持有自己对
 * stderr 流的引用，`console.error(...)` 不会经过被替换后的 `process.stderr.write`
 * 属性。也就是说 patchStderr 拦不到 console.error —— 两者必须各拦一次。
 *
 * 触发本模块的真实案例：`bun build --compile` 未定义 NODE_ENV 时，产物运行时
 * NODE_ENV="development"，react-reconciler 因此加载 development build，其中
 * `getRootForUpdatedFiber()` 会 `console.error("Maximum update depth exceeded...")`。
 * 因为是 console.error 而非 throw：错误边界抓不到、进程不崩、任务照常跑完、
 * debug.log 无痕，只有用户终端被反复刷屏。
 *
 * 根因已由构建期 `--define process.env.NODE_ENV='"production"'` 修掉（见 Makefile
 * 的 BUILD_DEFINES 注释）。本模块是**纵深防御**：任何第三方依赖、未来新增代码、
 * 或其它 development-only 警告仍可能走 console.error/warn/trace，护栏保证它们
 * 「有日志留痕、但不破坏终端画面」。
 *
 * ## 为什么不直接开 ink 的 patchConsole
 *
 * 生产入口 `fullscreen.ts` 传 `patchConsole: false` 是**有意为之**，把它翻成 true
 * 会一并改变 `console.log/info/debug/table/group/...`（14 个 stdout 类方法）的语义，
 * 影响面远超本次需要。本模块**只拦 stderr 三件套**（error/warn/trace）+ assert，
 * 完全不碰 stdout 类方法，与那个决定不冲突。
 *
 * ## 落点选择：为什么写进 logger 而不是丢弃
 *
 * 静默吞掉等于把现场也一起吞了 —— 这次排查最大的障碍恰恰是"debug.log 里搜不到
 * 任何记录"。转进 logger 后：`--debug` 时进 debug.log，平时进 audit.log（WARN 级
 * 常驻留痕），下次同类问题有据可查。
 */

import { getLogger } from "../debug/logger.ts";

/** stderr 类 console 方法：只拦这三个 + assert，刻意不碰 stdout 类方法。 */
const STDERR_METHODS = ["error", "warn", "trace"] as const;

type StderrMethod = (typeof STDERR_METHODS)[number];

/** 已安装的卸载函数；非空表示护栏在生效中（防重复安装）。 */
let uninstall: (() => void) | null = null;

/**
 * 把任意 console 实参拼成单行文本。
 *
 * 不用 `util.format`：Error 实参在 format 下只剩 message + stack 多行展开，
 * 而护栏要的是"一行一条、可 grep"。这里对 Error 显式取 message + 首行 stack。
 */
function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) {
        const firstFrame = a.stack?.split("\n")[1]?.trim();
        return firstFrame ? `${a.message} (${firstFrame})` : a.message;
      }
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ")
    .replace(/\s*\n\s*/g, " ") // 压成单行，避免多行日志破坏 grep
    .trim();
}

/**
 * 安装护栏。返回卸载函数；重复调用是幂等的（第二次起返回既有的卸载函数）。
 *
 * 必须在 Ink `render()` **之前**调用 —— render 一旦开始写 stdout，
 * 此后任何 console.error 都会立刻破坏画面。
 */
export function installTUIConsoleGuard(): () => void {
  if (uninstall) return uninstall;

  // biome-ignore lint/suspicious/noConsole: 本模块的职责就是接管 console
  const con = console;
  const originals = new Map<StderrMethod | "assert", unknown>();

  // 重入守卫：logger 自身在某些降级路径下会写 stderr / 调 console
  // （logger.ts 的 writeToConsole 与 enabled=false 兜底分支），若不设守卫，
  // console.error → 护栏 → logger → console.error → … 自我递归。
  // 同款守卫在 ink.tsx 的 patchConsole/patchStderr 里各有一处，原因相同。
  let reentered = false;

  const route = (level: "error" | "warn", args: unknown[]): void => {
    if (reentered) return; // 递归第二层：直接丢弃，避免打爆调用栈
    reentered = true;
    try {
      const text = stringifyArgs(args);
      if (!text) return;
      const logger = getLogger();
      // 分类用 TUI:CONSOLE，方便 grep 出"本该打到终端但被护栏收走"的记录
      if (level === "error") logger.error("TUI:CONSOLE", text);
      else logger.warn("TUI:CONSOLE", text);
    } catch {
      // 日志失败也绝不能回落到 console/stderr —— 那正是要防的事
    } finally {
      reentered = false;
    }
  };

  for (const m of STDERR_METHODS) {
    originals.set(m, con[m]);
    // trace 语义上是 error 级（带栈的诊断输出）
    con[m] = ((...args: unknown[]) => route(m === "warn" ? "warn" : "error", args)) as never;
  }

  originals.set("assert", con.assert);
  con.assert = ((condition: unknown, ...args: unknown[]) => {
    if (!condition) route("error", args.length > 0 ? args : ["Assertion failed"]);
  }) as never;

  uninstall = () => {
    for (const [name, fn] of originals) {
      (con as unknown as Record<string, unknown>)[name] = fn;
    }
    uninstall = null;
  };
  return uninstall;
}

/** 卸载护栏（无护栏时是 no-op）。退出路径与测试清理用。 */
export function uninstallTUIConsoleGuard(): void {
  uninstall?.();
}

/** 护栏当前是否生效（测试与诊断用）。 */
export function isTUIConsoleGuardInstalled(): boolean {
  return uninstall !== null;
}
