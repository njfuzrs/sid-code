/**
 * 交互终端的颜色级别：只改进程内的 chalk 实例，**绝不写 `process.env`**。
 *
 * ─── 为什么不能写 `process.env.FORCE_COLOR` ───
 *
 * 2026-03-12 起 `cli.ts` 入口写 `process.env.FORCE_COLOR = "3"` 来保证 TUI 有颜色。
 * `process.env` 是进程级、会被所有子进程继承的状态，于是 bash 前台、后台任务、shell
 * 快照、hook、MCP、LSP、子代理全部拿到 `FORCE_COLOR=3`：bun / vite / npm 这类工具
 * 即便输出接的是文件或管道也照样吐 ANSI。2026-10-18 事故：后台 `bun install | tail -3`
 * 写进 `.output` 的 122 字节里有 17 个 ESC（13.9%），read 工具按二进制拒读。
 * 子代理把整份 env 传给子 sid-code 后，子进程分不清 `FORCE_COLOR` 是用户设的还是
 * 父进程注入的，所以「在 spawn 点逐个擦掉」也挡不住，只能从源头不写。
 *
 * 注入原本的理由（「Ink 接管 stdout 后 chalk 检测不到 TTY」）不成立：chalk 在模块
 * 加载时探测，那时 stdout 还是真 TTY。实测真 pty 下不注入，chalk 自己就探到
 * 2（xterm-256color）/ 3（COLORTERM=truecolor）。注入真正改变行为的只有两处：
 * TTY 下把 2 抬到 3（这里照做，保持现有观感），以及非 TTY 下把 0 抬到 3
 * （恰恰是不该上色的场景，这里不再做）。Claude Code 同样不写 env，只改
 * `chalk.level`（`src/ink/colorize.ts`）。
 */
import chalk from "chalk";
// 经渲染端口拿底座（lint:boundary 的 render-port 规则：CLI 不得直连 @sid-code/tui）
import { adjustColorLevel } from "./render-port/text.ts";

type Level = typeof chalk.level;
type Env = Record<string, string | undefined>;

/** 本进程是否由 sid-code 主动把颜色抬到了真彩（而不是用户自己设的 FORCE_COLOR）。 */
let forcedByUs = false;

/**
 * 计算交互终端应使用的 chalk 级别；返回 null 表示不干预（交给 chalk 自己的探测）。
 *
 * 不干预的三种情况与旧入口逐条对应：stdout 不是 TTY（管道/文件不上色）、
 * 用户设了 `NO_COLOR`、用户设了 `FORCE_COLOR`（chalk 会自己读它，用户意图优先）。
 * 返回值走 `adjustColorLevel`，与旧版「FORCE_COLOR=3 → chalk 初值 3 → tui 修正」
 * 得到同一个结果（tmux 下降到 256 色、vscode 保持真彩）。
 */
export function resolveTerminalColorLevel(env: Env, stdoutIsTTY: boolean): Level | null {
  if (!stdoutIsTTY) return null;
  if (env["FORCE_COLOR"] || env["NO_COLOR"]) return null;
  return adjustColorLevel(3, env);
}

/**
 * 在 CLI 入口调用一次。只改 chalk 实例（全进程单例，tui 与 markdown 渲染共用），
 * 不触碰 `process.env`，所以子进程拿到的颜色相关环境与用户 shell 完全一致。
 */
export function applyTerminalColorLevel(
  env: Env = process.env,
  stdoutIsTTY: boolean = Boolean(process.stdout.isTTY),
): void {
  const level = resolveTerminalColorLevel(env, stdoutIsTTY);
  if (level === null) return;
  chalk.level = level;
  forcedByUs = true;
}

/**
 * 是否由本模块强制了颜色。`getColorDepth()` 用它保持旧行为：旧版 env 里有
 * `FORCE_COLOR=3`，Bun 的 `stdout.getColorDepth()` 会因此恒报 24 位。
 */
export function isTerminalColorForced(): boolean {
  return forcedByUs;
}

/**
 * 输出会被渲染进彩色 TUI 的子进程（自定义状态栏脚本）需要的颜色环境。
 *
 * 这是**按 spawn 点显式声明**，不是全局注入：状态栏脚本的 stdout 是管道，不给提示它就
 * 不上色，而它的输出原样进 TUI，旧版靠继承来的 `FORCE_COLOR=3` 才有颜色。级别取当前
 * chalk 级别（tmux 下是 2），不再一律给 3。用户自己设了 FORCE_COLOR / NO_COLOR 时
 * 已经随 env 继承下去，这里不覆盖。
 */
export function colorEnvForTuiRenderedChild(env: Env = process.env): Record<string, string> {
  if (!forcedByUs || env["FORCE_COLOR"] || env["NO_COLOR"]) return {};
  return { FORCE_COLOR: String(chalk.level) };
}

/** 仅测试用：重置模块状态。 */
export function __resetTerminalColorForTest(): void {
  forcedByUs = false;
}
