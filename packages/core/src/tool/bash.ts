/**
 * Bash 工具 - 执行 shell 命令
 * 对标 Claude Code：description 参数、输出截断、AbortSignal 集成、跨平台适配
 *
 * 持久 Shell 会话（P0-2）：
 * - 会话启动时（构造期）创建 shell 环境快照，抓取用户 aliases/functions/options/PATH
 * - 每条命令前 `source` 快照 + `eval` 命令（使 alias 生效）
 * - 命令末尾 `pwd -P` 写回全局 cwd 状态，实现 cd 跨命令、跨工具持久化
 * See: docs/bugfixes/todo/p0-2/持久Shell会话-补齐分析.md
 */

import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
  PermissionResult,
  ToolUseContext,
} from "./types.ts";
import { spawn } from "bun";
import { platform } from "os";
import { join, isAbsolute, relative, resolve as resolvePath } from "path";
import { readFileSync, unlinkSync, existsSync, realpathSync } from "fs";
import { getLogger } from "../debug/logger.ts";
import { describeAbortReason } from "../llm/errors.ts";
import type { Config } from "../config/config.ts";
import { isReadOnlyCommand, isDestructiveCommand } from "./bash/read-only-validation.ts";
import { interpretExitCode } from "./bash/command-semantics.ts";
import { scanControlChars } from "./binary-detect.ts";
import { looksLikeQuotingBreakage, quotingBreakageHint } from "./bash/quoting-diagnostics.ts";
import { detectMergeConflictHint } from "./bash/merge-conflict.ts";
import { stripTerminalControl } from "./bash/terminal-control.ts";
import { buildTimeoutGuidance } from "./bash/timeout-diagnostics.ts";
import {
  buildForegroundSleepNotice,
  detectForegroundSleep,
  FOREGROUND_SLEEP_LONG_SECONDS,
  type ForegroundSleepReason,
} from "./bash/foreground-sleep.ts";
import { emitForegroundSleepGuided } from "../query/guidance-events.ts";
import { normalizeToolPath } from "./path-utils.ts";
import { registerCleanup } from "@sid-code/shared/utils/graceful-shutdown.ts";
import { ensureSidTempDir } from "@sid-code/shared/utils/temp-dir.ts";
import { getCwd, setCwd, getOriginalCwd, getProjectRoot } from "../bootstrap/state.ts";
import { getAgentRoot } from "../bootstrap/cwd-context.ts";
import { createAndSaveSnapshot, escapeForShell } from "./bash/shell-snapshot.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";
import { bashWriteTargets } from "./jit-affected-paths.ts";
import type { FileReadTracker, BashChangedFile, BashMtimeSnapshot } from "./file-read-tracker.ts";
import { BACKGROUND_RECEIPT_NOTICE } from "../task/background-receipt.ts";

/** Bash 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const bashSchema = lazySchema(() =>
  z.object({
    command: z.string().describe("要执行的 shell 命令"),
    description: z
      .string()
      .optional()
      .describe("用自然语言描述这条命令要做什么（会显示给用户审批）"),
    timeout: z
      .number()
      .optional()
      .describe(
        "超时时间（毫秒），默认 120000（2 分钟），最长 600000（10 分钟）；可用 BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS 环境变量覆盖默认值与上限",
      ),
    cwd: z.string().optional().describe("工作目录，默认为当前目录"),
    run_in_background: z
      .boolean()
      .optional()
      .describe(
        "是否以后台任务模式运行（通过 Task 系统管理，返回 task_id，完成后通知；用 task_output 查询输出）",
      ),
    wait_until_seconds: z
      .number()
      .optional()
      .describe(
        "【只在 run_in_background=true 时有意义】声明「这是一次等待」：最多等这么多秒，期间不适用 60s 静默判据" +
          "（静默不代表不会回报）。到期仍在跑会被终止并通知。会被钳制到 [60, 3600]。",
      ),
  }),
);

/** Bash 输出截断阈值（对标 Claude Code 30000 字符） */
const MAX_OUTPUT_LENGTH = 30000;

/** 硬性下限：任何超时都不得低于 1 秒（防误传 0/负值把命令瞬间掐死）。 */
const TIMEOUT_FLOOR_MS = 1000;
/** 出厂默认超时（未传 timeout 且未配 env 时）：2 分钟。 */
const FACTORY_DEFAULT_TIMEOUT_MS = 120000;
/** 出厂上限（未配 env 时）：10 分钟。 */
const FACTORY_MAX_TIMEOUT_MS = 600000;

/**
 * `wait_until_seconds` 的钳制区间（秒）。
 *
 * 下限 60s 与 `schedule_wakeup` 一致（避免高频空转）；上限 3600s 同理——超过 1 小时的等待
 * 应该用 cron 或唤醒，而不是挂一个后台命令。
 */
const MIN_WAIT_UNTIL_S = 60;
const MAX_WAIT_UNTIL_S = 3600;

/**
 * 解析 bash 超时的默认值与上限，支持 env 覆盖（对齐 CC 的
 * BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS）。
 * - 非法/非正数 env 值一律忽略，回落出厂值。
 * - 保证 floor ≤ default ≤ max（default 不超过 max，max 不低于 floor）。
 */
export function resolveTimeoutBounds(): { defaultMs: number; maxMs: number } {
  const parseEnv = (name: string): number | undefined => {
    const raw = process.env[name];
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const maxMs = Math.max(
    parseEnv("BASH_MAX_TIMEOUT_MS") ?? FACTORY_MAX_TIMEOUT_MS,
    TIMEOUT_FLOOR_MS,
  );
  const defaultRaw = parseEnv("BASH_DEFAULT_TIMEOUT_MS") ?? FACTORY_DEFAULT_TIMEOUT_MS;
  // 默认值夹在 [floor, max] 内
  const defaultMs = Math.min(Math.max(defaultRaw, TIMEOUT_FLOOR_MS), maxMs);
  return { defaultMs, maxMs };
}

/**
 * 前台命令实时进度节流间隔（毫秒）。
 * bun test / 构建等命令每秒可输出数百行，逐行 emit 会把 React 重渲打爆并触发全屏闪烁
 *（见 src/ui/CLAUDE.md L3.4）。攒够一个间隔再吐一次尾部，兼顾"实时感"与渲染成本。
 */
const PROGRESS_THROTTLE_MS = 120;

/**
 * 实时进度只回传输出的**尾部 N 行**（对齐 CLAUDE.md L3.4「流式内容按视口高度 tail 截断」）。
 * 执行中的工具卡片是单行 header 下的一小块活动区，喂全量输出既无必要也会撑爆动态区高度。
 * 完整输出仍在命令结束后作为 tool_result 一次性返回，不受此截断影响。
 *
 * 取 4 行 = 命令结束后折叠态结果区的高度（ToolMessage 传 `maxLines={3}`：超出时 3 行 + 1 行
 * `… N 行已折叠` footer，恰好多 1 行时直接显示 4 行）。执行中与完成后同高，卡片完成那一帧
 * 帧不变矮——主屏帧已溢出视口时任何收缩都会整帧重画全部历史（packages/tui/src/frame/main-screen.ts）。
 * 两边一起改：这里改大会让每条长输出的 bash 完成时都触发一次整帧重画。
 */
const PROGRESS_TAIL_LINES = 4;

/** 单行进度尾部的最大字符数（窄终端兜底，避免超长单行破坏对齐）。 */
const PROGRESS_LINE_MAX_CHARS = 200;

/**
 * 进程退出后等待输出管道 EOF 的宽限期（毫秒）。
 *
 * 收尾主信号是**进程退出**而不是管道 EOF：管道 EOF 要求所有持有写端的进程都关闭它，
 * 而 setsid 脱离进程组的 daemon（nohup / setsid / `xxx --daemon` 且未重定向 stdio）
 * 既杀不到、也不会关闭写端。旧实现先 `await Promise.all([pump...])` 再等 proc.exited，
 * 在这类命令上永不 resolve，工具调用永久挂住（缺陷 2026-10-31，评测 2 个 trial 挂约 2 小时）。
 *
 * 进程退出后内核管道缓冲区里最多剩几十 KB（写端被阻塞时进程退不出去），读完是毫秒级；
 * 取 400ms 是给解码与背压留余量，同时保证「宽限期截断」的代价可控（只丢 daemon 后续输出）。
 */
const PIPE_DRAIN_GRACE_MS = 400;

/**
 * 发生「管道宽限期截断」时追加到结果尾部的说明。
 * 这既是给用户的诚实交代，也是给模型的纠偏信号——否则模型会以为自己拿到了完整输出，
 * 或者反过来重试一条本来已经成功、只是 daemon 还在后台跑的命令。
 */
const PIPE_TRUNCATED_NOTICE =
  "\n[注意] 命令已退出，但有脱离进程组的后台进程仍持有输出管道（常见于 daemon 未重定向输出），已停止读取其后续输出。如需保留请重定向到文件：`cmd > log 2>&1 &`";

/**
 * 从累积的完整输出里取"最近 N 行、每行至多 M 字符"的尾部快照，作为实时进度文本。
 * 纯函数：只做字符串切分，不改状态。空输出返回空串（调用方据此跳过 emit）。
 */
function tailProgressSnapshot(fullOutput: string): string {
  if (!fullOutput) return "";
  const lines = fullOutput.split("\n");
  // 末尾若是空行（输出以 \n 结尾），去掉它再取尾部，避免最后一行永远是空白。
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const tail = lines.slice(-PROGRESS_TAIL_LINES);
  return tail
    .map((line) =>
      line.length > PROGRESS_LINE_MAX_CHARS ? `${line.slice(0, PROGRESS_LINE_MAX_CHARS)}…` : line,
    )
    .join("\n");
}

/**
 * 是否以 detached 模式 spawn（子进程独立进程组，便于进程树 kill）。
 * 仅 POSIX 启用：Windows 下 detached 会弹出可见控制台窗口，且无进程组概念，
 * 其进程树清理依赖 killProcessTree 内的 taskkill /T（走真实父子关系），无需 detached。
 */
const DETACH = platform() !== "win32";

/** 后台进程 PID 跟踪 */
const backgroundPids = new Set<number>();

/** cwd 临时文件计数器（与 pid 组合保证并发命令的临时文件名唯一） */
let cwdFileCounter = 0;

/**
 * 杀掉整棵进程树（缺口 3 修复，对标 claude-code treeKill）。
 *
 * POSIX：前台命令以 `detached:true` spawn，子进程成为进程组组长（pgid===pid）。
 * `process.kill(-pid, signal)` 向整个进程组发信号，连带清理 `sleep 30 &` 类孙子进程，
 * 避免旧实现 `proc.kill()` 只杀 shell 父进程、子进程成孤儿的泄漏（见 shell-task.ts 同款用法）。
 *
 * Windows：无进程组概念，`process.kill(-pid)` 不生效。改用 `taskkill /T /F` 杀进程树。
 *
 * @param pid 进程组组长 pid（= detached spawn 返回的 pid）
 * @param signal 默认 SIGKILL（超时/取消场景需要确定性终止）
 * @param fallbackKill 进程组 kill 失败时的兜底（如 proc.kill()），用于未 detached 的场景
 */
export function killProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals = "SIGKILL",
  fallbackKill?: () => void,
): void {
  if (!pid) {
    fallbackKill?.();
    return;
  }
  // Windows：taskkill /T 递归杀子进程，/F 强制
  if (platform() === "win32") {
    try {
      spawn({
        cmd: ["taskkill", "/pid", String(pid), "/T", "/F"],
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      try {
        fallbackKill ? fallbackKill() : process.kill(pid, signal);
      } catch {
        /* 已退出 */
      }
    }
    return;
  }
  try {
    // 负 pid = 向进程组发信号，清理整棵树
    process.kill(-pid, signal);
  } catch {
    // 进程组不存在（未 detached）或已退出，回退到单进程 kill
    try {
      fallbackKill ? fallbackKill() : process.kill(pid, signal);
    } catch {
      /* 进程可能已自行退出 */
    }
  }
}

/**
 * 杀掉所有残留后台进程并清空跟踪表(LEAK-3)。
 * 退出时由 graceful-shutdown 调用,避免 backgroundPids 无界增长 + 孤儿进程残留。
 * 用进程组 kill 清理整棵树（后台命令也以 detached 启动）。
 */
export function killBackgroundProcesses(): void {
  for (const pid of backgroundPids) {
    killProcessTree(pid);
  }
  backgroundPids.clear();
}

// 自注册到优雅关闭序列(退出时清理后台进程)
try {
  registerCleanup(killBackgroundProcesses);
} catch {
  /* 测试或非标准入口下可能不可用,忽略 */
}

/**
 * Ctrl+B 热转后台（P1-4，对标 claude-code）。
 *
 * 语义：把"正在前台执行的 bash 命令"过继给 Task 系统——execute() 立即返回 task_id 结果，
 * 主循环随之空闲、可以接受新输入；命令本身继续在后台跑完，完成后走既有的后台通知回注
 * 链路（与模型主动传 run_in_background=true 完全同一条通知/面板/kill 路径，见
 * task/shell-task.ts 的 adoptRunningProcessAsTask）。
 *
 * 触发方是 App.tsx 的 Ctrl+B 键处理器（经 app.ts 的 onBackgroundCurrent 回调），本模块
 * 不感知 UI；这里只维护"当前有哪些前台执行可以响应转后台请求"的注册表——用回调而非
 * toolUseId 索引，因为 execute() 的调用签名（tool-executor.ts）不传 toolUseId，且 bash
 * 是单例工具，同一时刻通常只有 0~1 个前台执行在跑（并发安全的只读命令批次理论上可能
 * 有多个，此时 Ctrl+B 会把它们一起转后台——只读命令通常跑得快用户不太会这么做，但统一
 * 处理更简单也不会错）。
 */
const foregroundDetachHandlers = new Map<number, () => boolean>();
let foregroundDetachSeq = 0;

/**
 * 请求把当前所有"可转后台"的前台 bash 执行转入后台。
 * 返回实际触发的个数（0 表示当前没有可转后台的前台命令——调用方据此给用户诚实的提示，
 * 而不是假装成功）。已经处于超时/取消收尾中的执行不会响应（各自内部有守卫，迟到的
 * 转后台请求没有意义——进程已经在被杀或已经杀完）。
 *
 * 注意：handler 的返回值（true=真正执行了 detach，false=命中内部守卫短路）才是"实际触发"，
 * 不能用 `handlers.length`（注册数）代替——一个已经 timedOut/aborted/已 detach 的前台执行
 * 仍然在 map 里（要等 execute() 的 finally 才移除），若不看返回值直接数注册数，会在命令即将
 * 因超时被杀的窗口期把"实际没转成"误报成"已转后台"，是一句谎话。
 */
export function requestDetachForegroundBash(): number {
  const handlers = [...foregroundDetachHandlers.values()];
  let detachedCount = 0;
  for (const handler of handlers) {
    try {
      if (handler()) detachedCount++;
    } catch {
      /* 单个 handler 异常不应影响其它并发前台执行 */
    }
  }
  return detachedCount;
}

/**
 * adoptRunningProcessAsTask 的返回形状（本地声明，仅为拿到字段级类型提示；
 * 避免为了一个内部类型对 task/index.ts 做静态类型导入，维持该模块一贯的
 * 惰性 require 接线风格）。
 */
interface DetachedTaskHandle {
  taskState: { id: string; status: string; outputFile: string };
  appendLiveOutput: (text: string) => void;
  markExited: (exitCode: number | null) => void;
  markError: (err: Error) => void;
}

/**
 * 收尾 detachedTaskHandle（若已转后台）——TS 对"跨闭包重新赋值的 let 变量"控制流窄化有
 * 缺陷：detachedTaskHandle 在 detach handler 闭包（`foregroundDetachHandlers.set` 里注册
 * 的那个）里被异步重新赋值，但 runToCompletion 闭包自身在被创建那一刻捕获到的仍是声明时
 * 的 null——导致在 runToCompletion 内直接 `if (detachedTaskHandle)`（哪怕先赋给局部 const
 * 别名）都会被 tsc 误窄化为 `never`（报错 "Property 'xxx' does not exist on type 'never'"，
 * 已用最小复现验证：本地 const 别名规避不了，必须让变量穿过一次函数调用边界——参数类型只看
 * 函数签名，不受调用点的窄化分析影响）。
 * 返回 true 表示已处理（调用方据此提前 return），false 表示尚未转后台，继续走前台收尾。
 */
function finalizeIfDetached(
  handle: DetachedTaskHandle | null,
  action: (h: DetachedTaskHandle) => void,
): boolean {
  if (!handle) return false;
  action(handle);
  return true;
}

/** 全局配置（用于环境变量清理） */
let globalConfig: Config | null = null;

/** 设置全局配置 */
export function setBashToolConfig(config: Config): void {
  globalConfig = config;
}

/**
 * 获取平台 shell 配置。
 * @param opts.login 是否登录模式（加 -l）。无快照时回退登录模式以重新 source 用户配置（对标 claude-code getSpawnArgs）。
 *                   Windows（powershell）无登录概念，忽略此参数。
 */
function getPlatformShell(opts?: { login?: boolean }): { shell: string; args: string[] } {
  if (platform() === "win32") {
    return { shell: "powershell.exe", args: ["-NoProfile", "-Command"] };
  }
  const userShell = process.env.SHELL || "/bin/bash";
  // -c 后跟 -l：bash/zsh 将命令字符串作为首个操作数，-l 触发登录模式重新 source 配置
  const args = opts?.login ? ["-c", "-l"] : ["-c"];
  return { shell: userShell, args };
}

/** 截断超长输出 */
function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) return output;

  const head = output.slice(0, MAX_OUTPUT_LENGTH / 2);
  const tail = output.slice(-MAX_OUTPUT_LENGTH / 4);
  const omitted = output.length - head.length - tail.length;

  return `${head}\n\n... [输出已截断: 省略了中间 ${omitted} 字符，共 ${output.length} 字符] ...\n\n${tail}`;
}

/**
 * 检测二进制输出。
 *
 * 与 read 共用 scanControlChars：完整 ANSI 转义序列不计入不可打印。用户自己设了
 * FORCE_COLOR 时，彩色输出（进度条、带颜色的测试报告）里 ESC 密度可以超过 30%，
 * 旧算法会把整段有用输出替换成「[检测到二进制输出]」。
 */
export function isBinaryOutput(data: string): boolean {
  if (data.length === 0) return false;

  // 检查是否包含 null 字节
  if (data.includes("\0")) return true;

  // 检查不可打印字符比例（采样前 1000 个 UTF-16 码元）
  const sampleSize = Math.min(data.length, 1000);
  const { nonPrintableCount } = scanControlChars(sampleSize, (i) => data.charCodeAt(i));

  // 如果超过 30% 是不可打印字符，视为二进制
  return nonPrintableCount / sampleSize > 0.3;
}

/**
 * 格式化 spawn 异常信息（缺口 5 修复）。
 *
 * Bun 在 cwd 不存在时抛出 `ENOENT: no such file or directory, posix_spawn '/bin/zsh'`——
 * 错误指向 shell 二进制，实际根因却是工作目录不存在，对模型极具误导性。
 * 此处优先检测 cwd 是否存在，给出对标 claude-code Shell.ts:234 的友好信息。
 */
function formatSpawnError(err: any, cwd: string): string {
  const msg = String(err?.message ?? err);
  if (/ENOENT/.test(msg) && !existsSync(cwd)) {
    return `执行命令失败: 工作目录 "${cwd}" 不存在。请确认目录未被删除，或从有效目录重试。`;
  }
  return `执行命令失败: ${msg}`;
}

/**
 * 工作目录变更告知（追加到本次 bash 的 tool_result 末尾）。
 *
 * 为什么需要它：模型对"当前有效 cwd"**没有任何主动信号源**。`<environment>` 段里的
 * 工作目录只在会话启动（或提示词重建）时取一次 `process.cwd()`，此后 bash 怎么 `cd`
 * 都不变；而真正驱动 read/edit/grep/glob/ls 相对路径解析的是会跟随 `cd` 的全局
 * `getCwd()`。两套状态永久发散，模型唯一的发现途径是踩坑报错。
 *
 * 为什么落在 tool_result 而不是 `<environment>` 或新增一条 per-turn reminder：
 * - `<environment>` 在 `DYNAMIC_BOUNDARY` **之前**且入 `generateCacheKey`，让它跟随 cwd
 *   等于"任意 cd + 任意重建 = 静态前缀击穿"，而重建每会话通常一次都不发生 —— 纯亏。
 * - tool_result 本就是每轮新增内容，零 cache 影响；且它天然只在真的 cd 了时出现一次，
 *   不需要自建去重状态；位置还正好是模型此刻在读的那条结果。
 * - 信号源早就在 `setCwd` 那一刻存在，这里只是把它接出来，不新建任何机制。
 */
function cwdChangeNotice(newCwd: string): string {
  return (
    `\n[工作目录已切换] 当前工作目录: ${newCwd}\n` +
    `（后续 read/edit/grep/glob/ls 等工具的相对路径均以此为基准；如需回到原目录请显式 cd）`
  );
}

/**
 * 工作目录已失效告知（追加到本次 bash 的 tool_result 末尾）。
 *
 * 触发场景：agent 删掉了自己正站着的目录（`cd x && rm -rf x`，实测出自真实轨迹）。
 *
 * ## ⚠️ 真正的危害是**两套 cwd 状态发散**，不是"后续命令会失败"
 *
 * 本轮实测（2026-08-27，删掉 cwd 之后）：
 *
 * ```
 * getCwd()                        → /tmp/sidW/x   ← 仍停在**已删除**的路径
 * bash 里 pwd                      → /Users/.../sid-code  ← resolveCwd 局部回退到启动目录
 * normalizeToolPath("f.txt")      → /tmp/sidW/x/f.txt     ← 指向不存在的地方
 * ```
 *
 * 成因：`resolveCwd`（上方）在 cwd 不存在时回退到 `getOriginalCwd()`，
 * 但**只在那一次调用里局部回退、不写回全局** —— 于是 bash 跑在启动目录，
 * 而 read/edit/grep/glob/ls 经 `normalizeToolPath(getCwd())` 仍解析到已删除的路径。
 * **后续 bash 命令并不会失败**（这一点我最初写错了，实测纠正），
 * 它们只是静默跑在了另一个目录里 —— 这比直接报错更难发现。
 *
 * 所以文案要说的是「你的两套路径基准已经不一致了，显式 cd 一次把它们对齐」，
 * 不是「后续命令都会失败」。
 *
 * 与 `cwdChangeNotice` 同款理由落在 tool_result 而不是 `<environment>`：
 * 零 cache 影响、天然只出现一次、位置正好是模型此刻在读的地方。
 *
 * ⚠️ 文案必须给出**可执行的下一步**，不能只说"目录不存在了"——
 * 后者会让模型原地重试同一条命令。
 */
function cwdStaleNotice(staleCwd: string): string {
  // 子代理上下文里 resolveCwd 回退到的是它自己的边界（进入时的 root），不是主会话启动目录
  const fallback = getAgentRoot() !== undefined ? "本子代理的工作区根目录" : "启动目录";
  return (
    `\n[工作目录已失效] 当前工作目录 ${staleCwd} 已不存在（很可能是刚才的命令把它删掉了）。\n` +
    `上面这条命令本身已执行完成。但后续 bash 会静默跑在${fallback}，` +
    `而 read/edit/grep/glob/ls 的相对路径仍以这个已删除的路径为基准 —— 两者不一致。\n` +
    `请显式 \`cd\` 到一个存在的目录，把两套路径基准对齐。`
  );
}

/** realpath 失败（目录已删、权限）时退回原值 —— 比较时宁可「不等」也不抛 */
function realpathOr(p: string): string {
  try {
    return realpathSync(p).normalize("NFC");
  } catch {
    return p;
  }
}

/**
 * target 是否在 root 之内（含 root 本身）。
 *
 * CG-1 / R4 的门控判据：cwd 通知只在「离开或回到工作区根」时发（D1 裁决 ②）。
 * 全量 3242 次 cd 里 1738 次落在仓库外，而仓库内部的 cd（`cd packages/core`）
 * 不会让 enter_worktree 或 git 失败 —— 每次都发只是在花 token。
 *
 * ⚠️ 两边都必须 realpath 归一化：`switched` 来自 `pwd -P`（物理路径），
 * 而 `getProjectRoot()` 是启动时的逻辑路径。macOS 的 `/tmp`→`/private/tmp`、
 * `/var`→`/private/var` 会让「根内部的 cd」被误判成「跨出根」，通知一去一回刷两条。
 */
function isUnderWorkspaceRoot(target: string, root: string): boolean {
  const rel = relative(realpathOr(root), realpathOr(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 从 `git worktree add [<选项>] <path> [<commit-ish>]` 里取出 `<path>`（原样，未解析）。
 * 只认命令里第一处 `git worktree add`；取不到（变量、引号拼接等）返回 undefined —— 宁漏不误。
 */
export function parseWorktreeAddPath(command: string): string | undefined {
  const m = command.match(/(?:^|[\s;&|(])git\s+worktree\s+add\s+([^;&|\n]*)/);
  if (!m) return undefined;
  const toks = m[1].trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === "--") return toks[i + 1];
    if (t.startsWith("-")) {
      // 带值的选项：`-b <branch>` / `-B <branch>` / `--reason <string>`（`--reason=x` 形态不吃下一个）
      if (t === "-b" || t === "-B" || t === "--reason") i++;
      continue;
    }
    if (/[$`*?]/.test(t)) return undefined;
    // 成对引号剥掉；残缺引号说明路径含空格被切断了（`'../w s'`），不猜
    const unquoted = t.replace(/^(['"])(.*)\1$/, "$2");
    return /['"]/.test(unquoted) ? undefined : unquoted;
  }
  return undefined;
}

/**
 * 自建 worktree 的路径提示（20261020 会话评估发现 10）。
 *
 * 模型用 bash `git worktree add` 自建 worktree 而不调 enter_worktree（延迟工具，没加载）时，
 * 会话 cwd 不会跟过去：实测之后 10 分钟内 13 次写到主仓。git 自己的输出不含路径，
 * 所以这里补一行「去哪儿干活」。只追加提示、不拦截写主仓 —— 合法的跨目录写会被误伤。
 *
 * 相对路径先按启动目录解析，不存在再按命令结束后的 cwd 解析（`cd x && git worktree add ../w`）；
 * 两处都不存在就不提示，不猜。
 */
function worktreeAddNotice(command: string, launchCwd: string): string {
  const raw = parseWorktreeAddPath(command);
  if (!raw) return "";
  const candidates = isAbsolute(raw)
    ? [raw]
    : [resolvePath(launchCwd, raw), resolvePath(getCwd(), raw)];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) return "";
  return (
    `\n[已创建 worktree] ${hit}\n` +
    `当前会话工作目录没有切过去。后续读写请使用该路径下的绝对路径，` +
    `或调用 enter_worktree（path 参数）把会话工作目录切到它。`
  );
}

/** 把 cwd 变更/失效告知拼到结果末尾；两者互斥，都没有时原样返回 */
function withCwdNotice(
  output: string,
  cwd: { switched?: string; staleCwd?: string } | undefined,
): string {
  if (cwd?.switched) return `${output}${cwdChangeNotice(cwd.switched)}`;
  if (cwd?.staleCwd) return `${output}${cwdStaleNotice(cwd.staleCwd)}`;
  return output;
}

/**
 * C1：`bun test <path>` 匹配 0 个文件时的提示（追加到 tool_result 末尾）。
 *
 * 为什么需要它：bun 在这种情况只输出一行 `Test filter "..." had no matches`。
 * 模型看到「测试跑完了」就以为测过了，实际一条都没执行 —— 实测同一会话连续 4 次空转
 * （01 C1，77684ab7 step 157/159/161/165），每次都要重来一遍。
 *
 * ⚠️ 实测（bun 1.4.2）这条命令的**退出码是 1**，01 C1 文档里写的「退出码 0」不准。
 * 所以 isError 本来就是 true —— 本改动**不动判据**，只补一条「为什么失败 + 下一步」，
 * 因为原报错里除了那行英文短语之外没有任何可执行指引。
 *
 * 文案里的路径写法是实测结论：`bun test` 的位置参数是**完整路径子串匹配**，不是目录
 * ——本仓 `bun test tests/` 搜 692 个文件、`bun test ./tests/` 才是 38 个。
 */
function bunTestNoMatchNotice(command: string, output: string): string {
  if (!/\bbun\s+test\b/.test(command)) return "";
  if (!/had no matches/.test(output)) return "";
  return (
    `\n[没有匹配到测试文件] 这条 \`bun test\` 的路径/过滤器没有匹配到任何测试文件，` +
    `一条测试都没跑。\n` +
    `请先核对：① 当前工作目录是否是你以为的那个（bash \`cd\` 之后相对路径基准会变）；` +
    `② 路径写法——\`bun test\` 的位置参数是**完整路径子串匹配**，不是目录：` +
    `\`bun test tests/\` 会匹配所有含 \`tests/\` 的路径，\`bun test ./tests/\` 才是该目录。`
  );
}

/** 回扫清单在结果里最多列多少个路径（每类各自计数，避免一次大规模格式化灌满上下文） */
const MAX_LISTED_CHANGED_FILES = 10;

/** 把一类改动渲染成「标题 + 清单 + 下一步」的一段；清单按上限截断 */
function renderChangedFileBlock(
  header: string,
  lead: string,
  files: BashChangedFile[],
  advice: string,
): string {
  const shown = files
    .slice(0, MAX_LISTED_CHANGED_FILES)
    .map((c) => (c.deleted ? `  - ${c.path}（已删除）` : `  - ${c.path}`));
  const more =
    files.length > MAX_LISTED_CHANGED_FILES
      ? `\n  …另有 ${files.length - MAX_LISTED_CHANGED_FILES} 个`
      : "";
  return `${header}${lead}\n${shown.join("\n")}${more}\n${advice}`;
}

/**
 * F1 + CG-4：已读文件变动的告知（追加到 tool_result 末尾）。
 *
 * 与 cwdChangeNotice 同款理由落在 tool_result：零 cache 影响、只在真变了时出现一次、
 * 位置正好是模型此刻在读的地方。文案必须给出两工具不同的下一步——edit 可直接继续，
 * write 要先重读（见 FileReadTracker.ReadRecord.changedByBash）。
 *
 * **必须分成两类**（CG-4）：改造前所有变化都写成「被本命令修改」，而实际上
 * 「读取之后、命令之前」被外部改的那些也被算了进来——模型跑一条 `cat`/`grep` 却看到
 * 「你刚改了这些文件」，于是质疑「我没改它」。这不只是措辞问题：模型会为一次不存在
 * 的改动去重新 read 甚至回滚，白烧轮次。归因分开之后，「本命令改动」才配得上
 * 「你上下文里的内容已过期」这句指令。
 */
export function trackedFilesChangedNotice(changed: BashChangedFile[]): string {
  if (changed.length === 0) return "";
  const byCommand = changed.filter((c) => c.attribution === "command");
  const byExternal = changed.filter((c) => c.attribution === "external");

  const blocks: string[] = [];
  if (byCommand.length > 0) {
    blocks.push(
      renderChangedFileBlock(
        `\n[已读文件被本命令修改] 以下你读过的文件刚被这条命令改动（如格式化 / sed -i）：\n`,
        "",
        byCommand,
        `你上下文里的内容已过期。edit 可直接继续（以磁盘最新内容匹配 old_string，匹配不到再 read）；` +
          `write 整文件覆盖前须先重新 read。\n` +
          `（归因说明：命令运行期间若有其他进程同时改了同一文件，也会列在这里。）`,
      ),
    );
  }
  if (byExternal.length > 0) {
    blocks.push(
      renderChangedFileBlock(
        `\n[已读文件在本次命令前已被外部修改] 以下你读过的文件在本次命令开始执行前就变了，不是这条命令改的：\n`,
        "",
        byExternal,
        `你上下文里的内容已过期。重新 read 后基于最新内容再改，避免覆盖他人的改动。`,
      ),
    );
  }
  return blocks.join("\n");
}

export class BashTool implements Tool {
  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = bashSchema();

  /** shell 环境快照文件路径（构造期异步创建；undefined 表示无快照，降级登录模式） */
  private snapshotFilePath: string | undefined;
  /** 快照创建完成的 Promise（永不 reject，失败时 snapshotFilePath 为 undefined） */
  private snapshotReady: Promise<void>;
  /** macOS Seatbelt 沙箱管理器（可选，通过 setter 注入） */
  private sandboxManager: import("../permission/sandbox.ts").SandboxManager | null = null;
  /**
   * CG-1 / R4：cwd 跨出（或回到）工作区根时的通知回调。
   * null = 未接线（测试 / 无头路径），此时只有 tool_result 里的一次性尾注。
   */
  private cwdSwitchListener: ((newCwd: string) => void) | null = null;

  /**
   * F1：与 read/edit/write 共享的 FileReadTracker。前台命令结束后回扫它追踪的文件，
   * 把「本会话 bash 改了已读文件」吸收掉，否则下一次 edit 会把自己的格式化误判成外部修改。
   * null = 不回扫（测试 / 未接线路径），退回改造前行为。
   */
  private tracker: FileReadTracker | null = null;

  constructor(tracker?: FileReadTracker) {
    this.tracker = tracker ?? null;
    // 构造期异步触发快照创建（BashTool 单例，cli.ts 仅 new 一次，构造期建快照成立）。
    // 不阻塞构造；execute 首次会 await snapshotReady 确保从第一条命令起就用上快照。
    this.snapshotReady = this.initSnapshot();
  }

  /**
   * 返回一个绑定到另一个 tracker 的视图（子代理 / fork 用：它们有独立 tracker，
   * 若复用父实例，子代理自己 bash 格式化完再 edit 仍会被误拦，而回扫刷新的却是父 tracker）。
   *
   * 用 Object.create(this) 而不是 new：new 会重建 shell 快照（spawn 一次登录 shell），
   * 且丢掉 cli.ts 之后才注入的 sandboxManager。原型链继承让快照、沙箱随父实例生效，
   * 只在视图上遮蔽 tracker 这一个字段。
   */
  withFileReadTracker(tracker: FileReadTracker): BashTool {
    const view = Object.create(this) as BashTool;
    view.tracker = tracker;
    return view;
  }

  /**
   * CG-1 / R4：注入「cwd 跨出/回到工作区根」的通知回调（CLI 在 ctxMgr 就绪后接线）。
   *
   * 为什么用注入而不是让 bash 直接调 ctxMgr：bash 工具在 core 的工具层，
   * ContextManager 的持有者是 CLI 的 App；反向依赖会成环，而 core 里已有的
   * `setSandboxManager` / `withFileReadTracker` 都是同一个方向（外层注入给工具）。
   */
  setCwdSwitchListener(fn: ((newCwd: string) => void) | null): void {
    this.cwdSwitchListener = fn;
  }

  /**
   * CG-1 / R4：cwd 跨出（或回到）工作区根时，通知外层排一条**值型**变更通知。
   *
   * 为什么只在这一类变更上发（D1 的裁决 ②）：全量 3242 次 cd 里 1738 次落在仓库外，
   * 而仓库内部的 cd（`cd packages/core`）不会让 enter_worktree 或 git 失败，
   * 每次都发只是花 token。真正需要「此前说法作废」的，是模型判断「我在哪个项目里」
   * 这一刻失效的时候。
   *
   * 为什么通知要带作废声明而不是只说新值：只播报不撤销的话，历史里那条权威的
   * 「当前工作目录是 X」仍然在，模型会两个都信 —— 这是 §2.2 采纳附件 B §10.2 的理由。
   * 文案由外层（CLI）组装：它才知道语言偏好与持久块的消费格式。
   */
  private notifyWorkspaceRootCrossing(prevCwd: string, newCwd: string): void {
    if (!this.cwdSwitchListener) return;
    try {
      const root = getProjectRoot();
      if (isUnderWorkspaceRoot(prevCwd, root) === isUnderWorkspaceRoot(newCwd, root)) return;
      this.cwdSwitchListener(newCwd);
    } catch {
      /* 通知失败绝不影响命令结果本身 */
    }
  }

  /** 注入沙箱管理器（macOS Seatbelt） */
  setSandboxManager(manager: import("../permission/sandbox.ts").SandboxManager | null): void {
    this.sandboxManager = manager;
    // 注入时快照可能还没就绪（cli.ts 在构造后立刻注入），先报一次现值；
    // initSnapshot 完成时会再报一次，两处合起来覆盖两种时序。
    this.registerSnapshotToSandbox();
  }

  /**
   * 把快照路径告诉沙箱：profile 里要给它一条 literal 读放行。
   *
   * 为什么必须做：内层 shell 的第一条命令就是 `source <快照>`，而快照在
   * `~/.sid-code/shell-snapshots/` 下 —— 恰好被 sid home 的 deny 覆盖。
   * POSIX mode 的 shell 里 `source` 一个读不了的文件是**特殊内建致命错误**
   * （`|| true` 救不回来，shell 直接退出），用户命令一行都不会执行。
   */
  private registerSnapshotToSandbox(): void {
    this.sandboxManager?.setSnapshotPath(this.snapshotFilePath);
  }

  /** 异步创建 shell 快照（Windows 跳过，失败降级 undefined，永不抛出） */
  private async initSnapshot(): Promise<void> {
    if (platform() === "win32") return;
    try {
      const { shell } = getPlatformShell();
      this.snapshotFilePath = await createAndSaveSnapshot(shell);
    } catch {
      this.snapshotFilePath = undefined;
    }
    // 快照就绪 → 立刻让沙箱 profile 放行它（否则第一条命令就死在 source）
    this.registerSnapshotToSandbox();
  }

  name(): string {
    return "bash";
  }

  /**
   * 第 7 批 · §8.9 共同盲区：bash 写文件也要触发 JIT。
   *
   * `cat > src/ui/x.tsx` / `sed -i` 改了文件却不触发 JIT —— 模型接着改同目录其它
   * 文件时拿不到该目录的规范，且**静默无日志**。CC 也没有这条，但它确实是能力上限。
   *
   * 只认高确定性写入形态（`>` / `>>` / `tee` / `sed -i`），提取逻辑与判据见
   * `bashWriteTargets`。**不报 `cwd`**：它是命令的工作目录，不是被读写的业务文件，
   * 报了会把整个目录链的规则在每次 bash 调用时都灌一遍（绝大多数 bash 调用
   * 如 `git status` / `make` 根本不碰项目文件），纯属浪费 —— 与 `enter_worktree`
   * 登记豁免的理由同源。
   */
  jitAffectedPaths(input: unknown): string[] {
    if (!input || typeof input !== "object") return [];
    return bashWriteTargets((input as { command?: unknown }).command);
  }

  description(): string {
    return "执行 shell 命令。必须提供 description 参数用人话说明命令意图。支持超时控制和工作目录设置。";
  }

  usageGuide(): string {
    return `- 仅用于需要 shell 执行的系统命令，文件操作请用专用工具
- 不要用 bash 执行 cat/head/tail（用 read）、echo/cat 写文件（用 write）、sed/awk（用 edit）、find（用 glob）、grep（用 grep 工具）
- 要向用户传达信息时，直接在回复正文里输出文本，不要用 echo/printf 打印（除非确实需要把文本喂给管道/重定向等 shell 流程）
- 必须提供 description 参数，用自然语言描述命令意图
- 设置合理的 timeout，默认 2 分钟，最长 10 分钟
- 命令预计耗时超过 10 分钟时直接用 run_in_background=true：前台 timeout 传更大的值也会被截到上限，后台任务没有这个上限
- 输出超过 30000 字符会被自动截断
- 长时间运行的进程（如 dev server）可设置 run_in_background=true 后台运行
- 后台任务会返回 task_id，可用 task_output 查看输出、task_stop 终止；完成时有通知
- 命令超时被杀后，不要原样重试——要么用 run_in_background=true 重跑，要么缩小范围（见下条）
- 全盘/大目录搜索（find / / grep -r ~ 这类）极易超时：优先用 glob / grep 工具并把 path 限定到具体子目录
- 每条命令在独立 shell 进程中执行。cd 后的目录变更会被自动追踪并对所有工具（read/edit/glob 等）生效，无需每次重复传 cwd；
  但 export、source venv/bin/activate 等动态环境变更不会跨命令保留——需要它们的操作必须写在同一条命令里。
  例：\`cd src\` 后下一条 \`ls\` 会列 src 目录（可拆两条）；但 \`source venv/bin/activate && python foo.py\` 必须写为一条
- 命令里含**引号、多行、中文引号或其它特殊字符的长文本**（最典型：git commit message），不要手写 \`-m "..."\` 内联——
  内层引号极易把外层引号提前闭合，命令被 shell 拆断（退出码 127 / "未匹配"）。改用 heredoc 从 stdin 传入，内容按字面量处理无需转义：
  \`\`\`
  git commit -F - << 'SIDEOF'
  <完整 commit message，可含任意引号/中文/多行>
  SIDEOF
  \`\`\`
  定界符用单引号包裹（<< 'SIDEOF'）可禁用 $ 与反引号展开。或用 write 工具把内容写到临时文件后 \`git commit -F <文件>\`

## Git 命令安全（每次跑 git 都适用）
- 优先新建 commit，不要 --amend 既有 commit：pre-commit hook 失败时 commit 并未发生，此时 --amend 会改掉「上一个已完成的 commit」，可能破坏历史工作。hook 失败 → 修复问题 → 重新 git add → 新建 commit。除非用户明确要求，否则始终新建 commit
- 破坏性操作（git reset --hard / push --force / checkout . / restore . / clean -f / branch -D / stash drop）执行前，先想有没有更安全的等价做法；只在确实最优且用户要求时才用
- 绝不用 --no-verify 跳过 hooks、--no-gpg-sign 跳过签名，除非用户明确要求；hook 失败时排查并修复根因，而不是跳过
- 不擅自 git config 写操作（尤其 core.hooksPath）、不改 git 远程与分支上游，除非用户要求
- 不自动 push / 建 PR（走 /pr-workflow 或用户显式要求）

## 合并冲突处理（git merge / rebase / cherry-pick / pull 报冲突时）
1. git status 找出所有冲突文件（Unmerged paths）
2. 逐个 read 冲突文件，定位 <<<<<<< / ======= / >>>>>>> 标记
3. 在代码库上下文中理解双方变更各自的意图
4. 用 edit 消除标记、写入正确的合并结果——保留双方都需要的逻辑，不是简单选一边
5. 双方语义都正确、需要人工取舍时，用 ask_user_question 让用户拍板，不要擅自决定
6. 解决后 git add 冲突文件，按需 git commit（merge）/ git rebase --continue
- 不用 git checkout --theirs/--ours 简单丢一侧，除非确认那一侧确实该整体采用
- 中途放弃用 git merge --abort / git rebase --abort 回到干净状态`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(bashSchema()) as Record<string, unknown>;
  }

  /** 基于命令内容判断是否只读（输入感知） */
  readOnly(): boolean {
    return false; // 默认非只读，实际判断在 isConcurrencySafe 中
  }

  /** 工具级权限检查：只读命令直接放行，破坏性命令要求确认，其余 passthrough */
  async checkPermissions(input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    const command = (input as any)?.command;
    if (!command || typeof command !== "string") {
      return { behavior: "passthrough" };
    }
    if (isReadOnlyCommand(command)) {
      return { behavior: "allow" };
    }
    if (isDestructiveCommand(command)) {
      return { behavior: "ask", message: `破坏性命令需要确认: ${command.slice(0, 80)}` };
    }
    return { behavior: "passthrough" };
  }

  /** 基于命令内容判断是否并发安全（输入感知） */
  isConcurrencySafe(input: unknown): boolean {
    const command = (input as any)?.command;
    if (!command || typeof command !== "string") return false;
    return isReadOnlyCommand(command);
  }

  /**
   * 解析命令的工作目录。
   * 优先级：显式 params.cwd > 全局 cwd（getCwd()）> 原始启动目录（兜底）。
   * 若目标目录已被删除（如 rm -rf 之后），回退到原始启动目录，对标 claude-code Shell.ts:222-238。
   */
  private resolveCwd(rawCwd: string | undefined): { cwd: string } | { error: string } {
    const cwd = rawCwd ? normalizeToolPath(rawCwd) : getCwd();
    if (existsSync(cwd)) return { cwd };
    // 子代理上下文（withAgentCwd）里**不许**回退到 getOriginalCwd()：那是主会话的启动目录，
    // 对隔离 worktree 里的子代理而言就是主仓 —— 旧实现在这里静默把命令挪进主仓执行，
    // 而 bash 不经过 W12 的越界写拦截。回退只能落在本子代理自己的边界（进入时的 root）内；
    // 边界本身也没了（worktree 被清理）就报错，不找替身目录。
    const agentRoot = getAgentRoot();
    if (agentRoot !== undefined) {
      if (existsSync(agentRoot)) return { cwd: agentRoot };
      return {
        error:
          `执行命令失败: 子代理工作目录 "${agentRoot}" 已不存在（隔离 worktree 可能已被清理）。` +
          `为避免在其它目录执行，本命令未运行。`,
      };
    }
    return { cwd: getOriginalCwd() };
  }

  /**
   * 构造实际 spawn 的命令字符串（前台/后台三处路径共用，避免只改前台导致后台丢快照）。
   * - 有快照：`source <快照> 2>/dev/null || true && eval <命令>`（eval 触发二次解析使 alias 生效）
   * - 无快照：原样命令（spawn 时由 getPlatformShell({login:true}) 加 -l 重新 source 配置）
   * - trackCwd：命令末尾追加 `pwd -P >| <临时文件>`（>| 绕过 noclobber），仅前台、非 Windows
   * @returns commandString 拼接后命令；cwdFile 追踪文件路径（undefined 表示不追踪 cwd）
   *
   * ## ⚠️ cwd 追踪**不能用 `&&` 接**，否则它会污染用户命令的退出码
   *
   * 实测踩到（2026-08-27，从 SWE-bench 轨迹里挖出来的真实产品缺陷）：
   *
   * ```
   * ① cd /tmp && mkdir -p symlink_test/real_dir && cd symlink_test   ← cwd = /tmp/symlink_test
   * ② rm -rf /tmp/symlink_test                                       ← 把自己站着的目录删了
   *    ERR: 命令执行失败（退出码 1）:
   *         pwd: error retrieving current directory: getcwd: cannot access parent directories
   * ```
   *
   * **`rm -rf` 本身是成功的**，失败的是收尾那个 `pwd -P`（cwd 已不存在 → 非 0）。
   * 用 `&&` 拼接时整条命令的退出码取最后一段，于是**成功的操作被报成失败** ——
   * 模型收到"我的 rm 失败了"，可能重试或改道，而它其实已经做完了。
   * 这比反过来（失败报成成功）更难查：日志里那句 `pwd: ...` 看起来像个无关的噪声。
   *
   * 既有防线覆盖不到它：`formatSpawnError`（下方）只处理 **spawn 前** cwd 不存在，
   * 而这条是 **spawn 后、用户命令成功、收尾 `pwd` 失败**。
   *
   * 修法：把用户命令的退出码**先存进 `__sc_rc`**，跑完 `pwd` 再用它退出。
   *
   * ```sh
   * <用户命令>; __sc_rc=$?; { pwd -P >| <file>; } 2>/dev/null; exit $__sc_rc
   * ```
   *
   * ⛔ **不要用 `|| true` 兜 `pwd`** —— 实测那会把**用户命令的真失败也吞成成功**
   * （`false && { pwd; } || true` → exit 0），比原 bug 更坏。
   *
   * ⚠️ 一处行为差异（无害，但注释别再写错）：改成 `;` 之后，
   * **用户命令失败时 `pwd` 也会执行并写文件**（原先 `&&` 会短路）。
   * 这不影响正确性 —— `applyCwdTracking(cwdFile, success)` 只在 `success` 时读它，
   * 失败时直接跳过并删掉临时文件。
   */
  private buildCommand(
    rawCommand: string,
    opts: { trackCwd: boolean },
  ): { commandString: string; cwdFile: string | undefined } {
    const isWin = platform() === "win32";
    const parts: string[] = [];
    let cwdFile: string | undefined;

    if (this.snapshotFilePath && !isWin) {
      const snapshot = escapeForShell(this.snapshotFilePath);
      // ⚠️ 先判 `[ -r ]` 再 source，不是多余的防御：POSIX mode 的 shell（`/bin/sh`）里
      // `source` 一个读不了的文件是**特殊内建致命错误**，后面的 `|| true` 根本执行不到，
      // shell 直接退出、用户命令一行不跑（2026-11-05 D3 实测 exit 1/2 且无输出）。
      // 加了预判之后，快照丢失/落在 deny 区时 source 被短路，`|| true` 兜成 0，
      // 后面的 `eval` 照常执行 —— 这条与沙箱无关（`$SHELL=/bin/sh` 的用户同样会踩）。
      // 分组 `{ ...; }` 是为了让 `|| true` 覆盖整段而不是只覆盖 source。
      parts.push(`{ [ -r ${snapshot} ] && source ${snapshot} 2>/dev/null; } || true`);
      parts.push(`eval ${escapeForShell(rawCommand)}`);
    } else {
      parts.push(rawCommand);
    }

    // 用户命令部分：段间仍用 `&&`（source 失败不该继续 eval）
    const userCommand = parts.join(" && ");

    // CWD 追踪仅对前台命令、非 Windows 生效（powershell 无 POSIX pwd -P 语义）
    if (opts.trackCwd && !isWin) {
      cwdFile = join(ensureSidTempDir(), `sid-code-cwd-${process.pid}-${++cwdFileCounter}`);
      // ⚠️ 用 `;` + 存退出码，**不是 `&&`** —— 理由见上方长注释（成功的命令被报成失败）。
      // `2>/dev/null` 吞掉 `pwd: getcwd: ...` 那行噪声：cwd 没了对模型来说不是错误，
      // 而 applyCwdTracking 读不到文件时本来就会静默保持原 cwd。
      return {
        commandString:
          `${userCommand}; __sc_rc=$?; ` +
          `{ pwd -P >| ${escapeForShell(cwdFile)}; } 2>/dev/null; exit $__sc_rc`,
        cwdFile,
      };
    }

    return { commandString: userCommand, cwdFile };
  }

  /**
   * 命令成功完成后读取 cwd 临时文件并写回全局 cwd 状态；无论成功与否都清理临时文件。
   * @param success 命令是否成功（exitCode===0 且未被取消）。仅成功时才写回。
   *
   * ⚠️ 别再写「失败时 pwd -P 未执行」—— 2026-08-27 起 `buildCommand` 用 `;` 而不是 `&&`
   * 接 cwd 追踪（理由见那里：`&&` 会让成功的命令被报成失败），
   * 所以**用户命令失败时 `pwd` 也会执行并写文件**。这里靠 `success` 参数把它挡住，
   * 而不是靠"文件不存在"。下面 catch 里那句注释同理。
   * @returns `switched` 真的切换了工作目录时是新的绝对路径；
   *          `staleCwd` 当前 cwd 已不存在时是那个失效路径（两者互斥）。
   *
   * 返回值供调用方在 tool_result 末尾追加一行告知（见 `cwdChangeNotice` / `cwdStaleNotice`）。
   * 切换判据刻意就取"`setCwd` 实际执行"这一件事、不另算一次 diff —— 两处判据必然漂移，
   * 这是本仓反复踩过的坑。
   *
   * ## 为什么要单独报「cwd 失效」（缺陷的另一半）
   *
   * 把退出码修对之后，`rm -rf $(pwd)` 会正确地返回成功 —— 但模型**仍然不知道
   * 自己站的目录没了**。而实测（见 `cwdStaleNotice`）后果不是"后续命令失败"，
   * 是**两套 cwd 状态静默发散**：bash 经 `resolveCwd` 局部回退到启动目录，
   * 而 read/edit/grep 经 `normalizeToolPath(getCwd())` 仍指向已删除的路径。
   * 静默跑在错误目录比直接报错更难发现，所以必须主动告知。
   *
   * 判据取「`existsSync(getCwd())` 为假」这个**直接事实**，
   * 不取「`pwd` 没写文件」—— 后者还可能是磁盘满、临时目录被清，
   * 拿它当 cwd 失效的证据会造出假信号。
   */
  private applyCwdTracking(
    cwdFile: string | undefined,
    success: boolean,
    launchCwd: string,
  ): { switched?: string; staleCwd?: string } {
    if (!cwdFile) return {};
    let switched: string | undefined;
    // CG-1 / R4：变更前的全局 cwd。通知要说明「从哪个目录换到哪个」，
    // 也用它做「是否跨出/回到工作区根」的判定（D1 裁决 ②）。
    const prevCwd = getCwd();
    try {
      if (success) {
        // 裸 readFileSync 需自行 NFC 归一化（normalizeToolPath 内部已做，但此处直读文件）
        const newCwd = readFileSync(cwdFile, "utf8").trim().normalize("NFC");
        // 比较基准是**本次命令的启动目录**，不是全局 getCwd()（20261020 会话评估发现 6a）。
        // 旧判据拿结束目录比全局 cwd：一条带显式 `cwd:<主仓>` 的非只读命令即使没有 `cd`，
        // 结束目录（=启动目录）也 ≠ 全局 cwd，于是全局被切到主仓 —— 实测一个会话来回翻转
        // 29 次、主仓误写 13 次。显式 cwd 只该作用于这一次调用，只有命令自己 cd 了才写回。
        //
        // ⚠️ 启动目录必须先 realpath：`pwd -P` 给的是物理路径，launchCwd 是 normalizeToolPath
        // 的逻辑路径。macOS 的 /tmp→/private/tmp、/var→/private/var 以及经 symlink 进入的
        // worktree 下两边恒不等，不 realpath 这条修复会静默失效（且把全局写成物理路径）。
        if (newCwd && newCwd !== realpathOr(launchCwd) && existsSync(newCwd)) {
          setCwd(newCwd);
          switched = newCwd;
        }
      }
    } catch {
      /* 文件不存在或读取失败（cwd 被删掉时 `pwd -P` 非 0、不写文件），忽略 —— 保持原 cwd */
    } finally {
      try {
        unlinkSync(cwdFile);
      } catch {
        /* 忽略 */
      }
    }
    if (switched) {
      this.notifyWorkspaceRootCrossing(prevCwd, switched);
      return { switched };
    }
    // 没切换成功时才检查失效 —— 切换成功意味着新 cwd 存在（上面 existsSync 已验），
    // 两个告知同时出现只会让模型困惑。
    const cur = getCwd();
    return existsSync(cur) ? {} : { staleCwd: cur };
  }

  async execute(
    input: unknown,
    signal?: AbortSignal,
    onProgress?: (event: import("./types.ts").ToolProgressData) => void,
  ): Promise<ToolResult> {
    // CG-4：命令开始执行前拍一份已读文件 mtime 快照，作为「这条命令改了谁」的归因基准。
    // 拍在这里而不是 executeCommand 内部：那里有十几个提前 return（缺参数 / cwd 不存在 /
    // 取消…），逐个补快照必然漏。唯一的时序代价是首条命令 `await snapshotReady` 的等待
    // 窗口（构造期就在建 shell 快照）——那时模型还没读过文件，tracker 是空的，无影响。
    const snapshot = this.beginBashTracking(input);
    const result = await this.executeCommand(input, signal, onProgress);
    // C1：`bun test` 0 匹配时补一句提示（只追加文案，不动 isError / 退出码）
    const cmd = (input as { command?: unknown } | null)?.command;
    const noMatch = typeof cmd === "string" ? bunTestNoMatchNotice(cmd, result.output ?? "") : "";
    const withNoMatch = noMatch
      ? { ...result, output: `${result.output ?? ""}${noMatch}` }
      : result;
    return this.withTrackedFileChanges(
      input,
      this.withForegroundSleepNotice(
        input,
        this.withSandboxMeta(this.withWaitUntilNotice(input, withNoMatch)),
      ),
      snapshot,
    );
  }

  /**
   * N6 A 档：前台 `sleep N` 阻塞本轮时追加一行出口引导（**只追加提示，不拦、不改退出码**）。
   *
   * 为什么要引导：`schedule_wakeup` / 后台通知只在会话空闲时送达，本轮 sleep 会把它们
   * 全部挡在外面排队。fbb02831 排了唤醒之后又在本轮 `sleep 150/180`，第二个唤醒
   * lag 383 秒才注入。N2 已经把「排完该结束本轮」写进唤醒的文案，但模型仍可能
   * 用 sleep 在本轮里「等一会儿」——那是行为面的缺口，只能在调用点上给出口。
   *
   * 为什么落在 tool_result 而不是系统提示：见 `bash/foreground-sleep.ts` 文件头。
   * 为什么不拦：这个形态离合法用法很近（`sleep 2 && curl …`），B 档等 A 上线两周后
   * 的数据再决定（`.agents/notes/rejected/feature/2026-11-11-前台sleep改为拒绝执行.md`）。
   *
   * 引发放置与 `withWaitUntilNotice` 同款：埋点/引导失败不能影响命令结果本身。
   */
  private withForegroundSleepNotice(input: unknown, result: ToolResult): ToolResult {
    const params = input as {
      command?: unknown;
      run_in_background?: unknown;
    };
    // 后台命令正是引导要去的方向，不提示。旧后台参数已由别名层（input-alias.ts）
    // 在执行之前改名，这一层只认协议字段 run_in_background。
    if (params?.run_in_background) return result;
    const command = typeof params?.command === "string" ? params.command : "";
    if (!command) return result;
    const matched = detectForegroundSleep(command);
    if (!matched) return result;

    let hasDeclaredWait = false;
    try {
      const wait = require("../task/wait-registry.ts") as typeof import("../task/wait-registry.ts");
      hasDeclaredWait = wait.hasDeclaredExternalWait();
    } catch {
      // 等待注册表不可用时不阻断：当作「没有声明的等待」，仍按 N 阈值判
      hasDeclaredWait = false;
    }

    const reason: ForegroundSleepReason | undefined = hasDeclaredWait
      ? "declared_wait"
      : matched.seconds >= FOREGROUND_SLEEP_LONG_SECONDS
        ? "long_sleep"
        : undefined;
    if (!reason) return result;

    emitForegroundSleepGuided({
      seconds: matched.seconds,
      has_declared_wait: hasDeclaredWait,
      reason,
    });
    return {
      ...result,
      output: `${result.output}${buildForegroundSleepNotice(matched, reason)}`,
    };
  }

  /**
   * `wait_until_seconds` 只在后台有意义：前台命令本来就会等到退出或超时，再声明一个期限
   * 没有可执行语义。**忽略但不能静默**——模型以为等待被登记了，闸门就会放行，结果主循环
   * 在没有任何回报承诺的情况下收尾。静默失效是这里最坏的形态。
   */
  private withWaitUntilNotice(input: unknown, result: ToolResult): ToolResult {
    const params = input as {
      wait_until_seconds?: unknown;
      run_in_background?: boolean;
    };
    if (params?.wait_until_seconds === undefined) return result;
    if (params.run_in_background) return result;
    return {
      ...result,
      output: `${result.output}\n[注意] wait_until_seconds 只在 run_in_background=true 时生效，本次前台执行已忽略它（前台命令本来就等到退出）。`,
    };
  }

  /**
   * 给结果附上「本次调用所处沙箱状态」的元数据（仅供轨迹，不进模型上下文）。
   *
   * 口径刻意取 `sandboxManager` 是否**已注入且启用**，而不是「命令真的被 sandbox-exec
   * 包裹了」：包裹发生在 `executeCommand` 内部，那里有十几个提前 return（缺参数、cwd
   * 不存在、取消…），逐个标注既啰嗦又必然漏。两者差异只在「没执行命令的早退调用」上，
   * 而这条指标要回答的是「开了沙箱的会话里 bash 有没有被判到无沙箱路径」
   * ——降级时 cli.ts 根本不注入 manager，这里自然没有 meta，正是我们要的信号。
   */
  private withSandboxMeta(result: ToolResult): ToolResult {
    if (!this.sandboxManager?.isEnabled()) return result;
    return { ...result, meta: { ...(result.meta ?? {}), sandboxed: true } };
  }

  /**
   * CG-4：命令开始前给已读文件拍 mtime 快照（归因基准）。
   *
   * 跳过条件与 `withTrackedFileChanges` 逐条对齐——两处判定必须同源，否则会出现
   * 「拍了快照但从不回扫」（白扫一遍文件）或「回扫了却没有基准」（退回全算本命令）。
   */
  private beginBashTracking(input: unknown): BashMtimeSnapshot | undefined {
    if (!this.tracker) return undefined;
    const params = input as {
      command?: string;
      run_in_background?: boolean;
    };
    if (!params?.command || params.run_in_background) return undefined;
    if (isReadOnlyCommand(params.command)) return undefined;
    try {
      return this.tracker.beginBashExecution();
    } catch {
      // 拍快照失败不影响命令执行：退回改造前口径（全算本命令），至少不丢告知
      return undefined;
    }
  }

  /**
   * F1 + CG-4：命令结束后回扫已读文件。失败 / 超时 / 取消也扫——命令可能已改了一半文件。
   * 跳过：只读命令（不会写盘）、后台命令（此刻还没跑完，其改动之后仍按外部修改拦截）。
   * Ctrl+B 转后台的命令此时 output 为空，回扫也只会看到已发生的改动，无害。
   *
   * `snapshot` 是 `beginBashTracking` 拍下的执行前基准；为 undefined 时退回改造前口径。
   */
  private withTrackedFileChanges(
    input: unknown,
    result: ToolResult,
    snapshot?: BashMtimeSnapshot,
  ): ToolResult {
    if (!this.tracker) return result;
    const params = input as {
      command?: string;
      run_in_background?: boolean;
    };
    if (!params?.command || params.run_in_background) return result;
    if (isReadOnlyCommand(params.command)) return result;
    let notice = "";
    try {
      notice = trackedFilesChangedNotice(this.tracker.noteBashExecution(snapshot));
    } catch {
      // 回扫失败不影响命令结果本身
    }
    return notice ? { ...result, output: `${result.output}${notice}` } : result;
  }

  private async executeCommand(
    input: unknown,
    signal?: AbortSignal,
    onProgress?: (event: import("./types.ts").ToolProgressData) => void,
  ): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      command: string;
      description?: string;
      timeout?: number;
      cwd?: string;
      run_in_background?: boolean;
      wait_until_seconds?: number;
    };

    if (!params.command) {
      return { output: "错误: 缺少 command 参数", isError: true };
    }

    // 预先取消守卫：若 signal 在进入时已 abort，直接返回而不 spawn。
    // 否则 addEventListener("abort") 晚于 abort 事件 → handler 永不触发 → 命令照常执行
    // （已复现：用户 ESC 后排队的 bash 调用会无视取消）。
    if (signal?.aborted) {
      return {
        output: `命令已取消，未执行（${describeAbortReason(signal.reason)}，执行前 signal 已中止）`,
        isError: true,
      };
    }

    // 确保快照创建完成（首条命令可能赶在快照就绪前；snapshotReady 永不 reject）
    await this.snapshotReady;
    // 兜底再报一次快照路径：setSandboxManager 与 initSnapshot 谁先谁后不确定，
    // 两处都报才能覆盖两种时序（setSnapshotPath 值未变时是 no-op）。
    this.registerSnapshotToSandbox();

    log.info(
      "TOOL",
      `▶ 执行: ${params.command.slice(0, 200)}${params.command.length > 200 ? "..." : ""}`,
    );

    // Task 系统后台模式（统一通道）。
    // 旧后台参数已由别名层（input-alias.ts）在执行之前改名成 run_in_background，
    // 所以执行层只认协议字段。P2-10 的教训保留在这里：旧后台通道（不进 Task 系统、
    // 无 task_id、无完成通知）会让弱模型落入"无法查询输出"死角，不能重新引入。
    if (params.run_in_background) {
      return this.executeWithTaskSystem(params, signal);
    }

    // 超时限制：默认值/上限支持 env 覆盖（BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS），
    // 下限恒为 1 秒。未传 timeout 用默认值，传了则夹在 [1s, max] 内。
    const { defaultMs, maxMs } = resolveTimeoutBounds();
    const timeout = Math.min(Math.max(params.timeout || defaultMs, TIMEOUT_FLOOR_MS), maxMs);
    const resolved = this.resolveCwd(params.cwd);
    if ("error" in resolved) return { output: resolved.error, isError: true };
    const { cwd } = resolved;
    const { shell, args } = getPlatformShell({ login: !this.snapshotFilePath });

    // CWD 追踪范围（缺口 5 并发竞态处理）：只读命令不含 cd，跳过写回。
    // 只读命令可并发执行（isConcurrencySafe），跳过 cwd 写回既零损失又消除两条并发
    // bash 互相覆盖全局 cwd 的竞态。非只读命令视为串行，正常追踪 cwd。
    const trackCwd = !isReadOnlyCommand(params.command);

    // 前台命令：拼接快照注入 + cwd 追踪
    const { commandString: rawCommand, cwdFile } = this.buildCommand(params.command, { trackCwd });
    // 沙箱包裹（macOS Seatbelt，启用时限制文件系统和网络访问）。
    // 内层 shell 必须与外层一致：写死 /bin/sh 会让按 zsh 抓的快照在 POSIX mode 下
    // 执行，`source` 失败是致命错误（`|| true` 救不回来），用户命令一行都不执行。
    const commandString = this.sandboxManager?.isEnabled()
      ? this.sandboxManager.wrapCommand(rawCommand, shell)
      : rawCommand;

    // 准备环境变量（如果启用了清理）
    let env = process.env;
    if (globalConfig && (globalConfig as any).sanitizeEnv) {
      const { sanitizeEnv } = await import("../config/env-sanitizer.ts");
      env = sanitizeEnv(process.env as Record<string, string>);
      log.debug("BASH", `环境变量已清理，保留 ${Object.keys(env).length} 个变量`);
    }

    try {
      // detached（仅 POSIX）→ 子进程成为进程组组长，超时/取消时可 process.kill(-pid) 清理整棵树
      const proc = spawn({
        cmd: [shell, ...args, commandString],
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
        detached: DETACH,
      });
      // Ctrl+B 热转后台时，任务的 startTime 用真实起跑时刻（而非 detach 那一刻），
      // 避免任务面板把"已经跑了很久的命令"误显示成刚开始。
      const spawnedAt = Date.now();

      let timedOut = false;
      let aborted = false;
      // 非 null 表示本次执行已被 Ctrl+B 转入后台——此后 pump/超时/abort/cwd 逻辑全部改道：
      // 新输出写盘、不再走前台 timeout/abort kill、不追踪 cwd。
      let detachedTaskHandle: DetachedTaskHandle | null = null;
      let stdout = "";
      let stderr = "";
      let lastEmit = 0;
      let lastEmitted = "";

      // 节流 emit：攒够 PROGRESS_THROTTLE_MS 才吐一次尾部快照，且内容有变化才发。
      // force=true 用于流结束时的最后一次补发，确保最终尾部不因节流被吞。
      const emitProgress = (force: boolean) => {
        if (detachedTaskHandle) return; // 已转后台：前台进度卡片已经不存在，无需上报
        if (!onProgress) return;
        const nowMs = Date.now();
        if (!force && nowMs - lastEmit < PROGRESS_THROTTLE_MS) return;
        // 合并 stdout+stderr 取尾部（用户视角不区分两个流，跟最终输出的拼接顺序一致）。
        const combined = stderr ? (stdout ? `${stdout}\n${stderr}` : stderr) : stdout;
        const snapshot = tailProgressSnapshot(combined);
        if (!snapshot || snapshot === lastEmitted) return;
        lastEmit = nowMs;
        lastEmitted = snapshot;
        try {
          onProgress({ type: "output", text: snapshot });
        } catch {
          /* 进度上报失败不影响命令执行 */
        }
      };

      // 单一超时定时器：到点直接杀进程树并标记 timedOut（对标 claude-code #handleTimeout → #doKill）。
      // 不再玩"两个同延时定时器 + backgrounded 标志"的竞态把戏——旧实现里
      // timeoutId 先把 backgrounded 置 true，导致 timeoutPromise 的 resolve 永不触发，
      // Promise.race 只能等命令自然结束，超时保护形同虚设（实测 timeout=60s 命令跑满 87.5s）。
      // 复用上方已有的 spawnedAt（真实起跑时刻，见其定义处注释）——挂钟兜底要的
      // 正是"从起跑到现在过了多久"，与它语义完全一致，不另立一个变量以免二者漂移。
      const killForTimeout = () => {
        if (timedOut || detachedTaskHandle) return; // 已超时处理过 / 已转后台则不管
        timedOut = true;
        killProcessTree(proc.pid, "SIGKILL", () => proc.kill());
        log.info("BASH", `命令超时（${timeout / 1000}秒），已终止 PID ${proc.pid} 及其进程树`);
      };
      const timeoutId = setTimeout(killForTimeout, timeout);

      // ─── 挂钟兜底检查（事故 20260801-175042-699f69f8）───
      //
      // 单靠上面的 setTimeout 挡不住系统休眠：进程被冻结期间定时器不 fire，
      // 醒来才补 fire。那次事故里 timeout=120s 的命令**实际跑了 926 秒**
      // （PostToolUse duration_ms=926323），超时保护完全失效。
      //
      // 注意这不是"改用 setInterval 就好"——TimerDrift 实测证明 setInterval 在
      // 休眠下同样冻结（预期 5000ms / 实际 926241ms）。所以判据必须是**挂钟差值**
      // 而非"定时器有没有 fire"：即使 tick 迟到 900 秒，醒来第一次 tick 就能从
      // Date.now() - spawnedAt 立刻看出早已超时并补杀。
      //
      // 这一点上我们比 claude-code 更强：CC 的 ShellCommand.ts:275 也是裸
      // setTimeout(#timeout)，同样的失效模式，它没有挂钟兜底。
      const WALL_CLOCK_CHECK_MS = Math.max(1_000, Math.min(5_000, timeout));
      const wallClockTimer = setInterval(() => {
        if (timedOut || detachedTaskHandle) return;
        if (Date.now() - spawnedAt < timeout) return;
        log.warn(
          "BASH",
          `挂钟检查发现命令已超时（设定 ${timeout / 1000}s，实际已 ${((Date.now() - spawnedAt) / 1000).toFixed(0)}s，` +
            `定时器未按时 fire，通常是系统休眠），补杀进程树`,
        );
        killForTimeout();
      }, WALL_CLOCK_CHECK_MS);
      // unref：兜底检查绝不能成为进程退不掉的原因（命令正常结束时会 clearInterval，
      // 此处只防"极端情况下 timer 仍在挂着"）。
      wallClockTimer.unref?.();

      // AbortSignal 监听：用户 ESC / 上游取消 → 同样杀进程树
      const abortHandler = () => {
        aborted = true;
        killProcessTree(proc.pid, "SIGKILL", () => proc.kill());
      };
      signal?.addEventListener("abort", abortHandler);

      // Ctrl+B 转后台注册（P1-4）。命令仍在跑时才能响应——已经在超时/取消收尾中的
      // 执行会被守卫忽略（迟到的转后台请求没有意义，进程已经在被杀或已经杀完）。
      const detachHandlerId = ++foregroundDetachSeq;
      let resolveDetach: ((result: ToolResult) => void) | null = null;
      const detachPromise = new Promise<ToolResult>((resolve) => {
        resolveDetach = resolve;
      });
      foregroundDetachHandlers.set(detachHandlerId, () => {
        if (detachedTaskHandle || timedOut || aborted) return false;
        clearTimeout(timeoutId);
        // 转后台后前台超时语义消失，挂钟兜底也必须停（否则它会在后台任务跑到
        // timeout 时把已经"归任务系统管"的进程杀掉）。
        clearInterval(wallClockTimer);
        signal?.removeEventListener("abort", abortHandler);
        // 后台任务不追踪 cwd（对齐 executeWithTaskSystem 的既有语义）：cd 发生的时间点已经
        // 脱离"用户仍在等待这条命令"的因果链，异步写回全局 cwd 会与用户后续操作产生竞态。
        if (cwdFile) {
          try {
            unlinkSync(cwdFile);
          } catch {
            /* 忽略 */
          }
        }

        const { adoptRunningProcessAsTask } = require("../task/index.ts");
        const adopted: DetachedTaskHandle = adoptRunningProcessAsTask({
          proc,
          command: params.command,
          alreadyCaptured: stdout + (stderr ? (stdout ? "\n" : "") + stderr : ""),
          signal,
          startTime: spawnedAt,
        });
        detachedTaskHandle = adopted;
        log.info("BASH", `Ctrl+B：前台命令已转入后台 (task_id: ${adopted.taskState.id})`);
        resolveDetach!({
          output: JSON.stringify({
            task_id: adopted.taskState.id,
            status: adopted.taskState.status,
            output_file: adopted.taskState.outputFile,
            // Q1：Ctrl+B 回执原先没有任何不要轮询的说明，补上同一段禁令。
            message: `已将当前前台命令转入后台 (task_id: ${adopted.taskState.id})。${BACKGROUND_RECEIPT_NOTICE}`,
          }),
        });
        return true;
      });

      try {
        // 流式增量读取（替代旧的 `new Response(proc.stdout).text()` 一次性 await）。
        //
        // 旧实现憋到进程退出才拿到完整输出——长命令（bun test / 构建 / git clone）执行
        // 数十秒内 TUI 只显示 `⏺ bash (执行中…)`、零输出，用户无从判断是否卡死。
        // 改为并发读 stdout/stderr 两个流，边读边累积，并节流把"尾部快照"经 onProgress
        // 上报给执行中的工具卡片（见 app.ts liveToolOutput 侧信道）。
        //
        // 关键不变量（不能改坏）：
        // - 完整输出仍在命令结束后一次性返回（进度只是尾部预览，不替代最终 tool_result）；
        // - **收尾主信号是进程退出，不是管道 EOF**（见下方 runToCompletion 的宽限期注释）；
        //   超时/abort 杀进程树后 proc.exited 会 resolve，管道再给 PIPE_DRAIN_GRACE_MS 读尾巴；
        // - stdout/stderr 分别累积，最终合并逻辑与旧实现一致；
        // - Ctrl+B 转后台后（detachedTaskHandle 非 null）：新增内容改写盘、不再进内存
        //   累积（避免长跑后台进程内存无界增长），也不再触发前台进度回调。
        //
        // reader 登记表：进程退出后宽限期到仍未 EOF 时，靠它 cancel 掉读端让 pump 收尾。
        // 旧注释写的「杀进程树后 reader 会读到 done」只在**所有写端都在本进程组里**时成立——
        // setsid 脱离进程组的 daemon 既打不到也不关写端，那条不变量是假的（缺陷 2026-10-31）。
        const activePipeReaders: ReadableStreamDefaultReader<Uint8Array>[] = [];
        const pump = async (
          stream: ReadableStream<Uint8Array>,
          append: (text: string) => void,
        ): Promise<void> => {
          const reader = stream.getReader();
          activePipeReaders.push(reader);
          const decoder = new TextDecoder();
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) {
                append(decoder.decode(value, { stream: true }));
                emitProgress(false);
              }
            }
            // flush 解码器残留的多字节字符尾巴
            const tail = decoder.decode();
            if (tail) append(tail);
          } finally {
            try {
              reader.releaseLock();
            } catch {
              /* 已释放 */
            }
          }
        };

        // 正常完成链：包成一个立即执行的异步函数而不直接 await——这样 Ctrl+B 触发的
        // detachPromise 才能在它之前 settle，让 execute() 提前返回；pump/exited 不会被
        // "放弃"，Promise.race 的败者仍在事件循环里跑完，detach 后转去走 Task 收尾分支。
        const runToCompletion = (async (): Promise<ToolResult> => {
          // 本次执行是否发生过「管道宽限期截断」（daemon 持写端，读端被我们主动 cancel）。
          let pipesTruncated = false;
          try {
            // ─── 收尾顺序：进程退出是主信号，管道 EOF 只给宽限期（缺陷 2026-10-31）───
            //
            // 旧实现先 `await Promise.all([pump...])` 再 `await proc.exited`，隐含假设
            // "进程一退，管道自然 EOF"。setsid 脱离进程组的 daemon（nohup / setsid /
            // `xxx --daemon` 且未重定向 stdio）打破这个假设：kill(-pgid) 打不到它，
            // 它继续持有写端，pump 的 `for(;;) reader.read()` 永远等不到 done，
            // 工具调用永久挂住（评测里 2 个 trial 挂约 2 小时，手动 kill 才结束）。
            //
            // 现在改成并发推进：
            //   1. pump 立刻开跑（流式进度不受影响）；
            //   2. 等 proc.exited（或 pump 先抛错）——命令本身结束就是收尾的发令枪；
            //   3. 给管道 PIPE_DRAIN_GRACE_MS 把内核缓冲区里的尾巴读完；
            //   4. 仍未 EOF → 主动 cancel 读端让 pump 收尾，并在结果尾部说明被截断。
            const pipesDone = Promise.all([
              pump(proc.stdout, (t) => {
                if (detachedTaskHandle) {
                  detachedTaskHandle.appendLiveOutput(t);
                  return;
                }
                stdout += t;
              }),
              pump(proc.stderr, (t) => {
                if (detachedTaskHandle) {
                  detachedTaskHandle.appendLiveOutput(t);
                  return;
                }
                stderr += t;
              }),
            ]);

            // 先用 then(,onRejected) 把 rejection 接住，避免「等 proc.exited 期间 pump 抛错」
            // 变成 unhandled rejection（旧实现是立即 await，天然不会漏）。
            let pipesFinished = false;
            let pipesFailure: unknown = null;
            const pipesSettled = pipesDone.then(
              () => {
                pipesFinished = true;
              },
              (err) => {
                pipesFinished = true;
                pipesFailure = err;
              },
            );

            // 进程退出 or 管道先出错，谁先给结果用谁：
            // - 管道正常 EOF 但进程还在跑（如 daemon 自己复制了一份 stdout）：继续等进程；
            // - 管道异常（流损坏）：立刻上抛，不等进程——保持旧实现的错误可见性。
            const exitCode = await new Promise<number>((resolve, reject) => {
              void proc.exited.then(resolve, reject);
              void pipesDone.then(() => {}, reject);
            });

            if (!pipesFinished) {
              await Promise.race([
                pipesSettled,
                new Promise<void>((resolve) => {
                  const timer = setTimeout(resolve, PIPE_DRAIN_GRACE_MS);
                  timer.unref?.();
                }),
              ]);
            }

            if (!pipesFinished) {
              // 宽限期到仍无 EOF：有脱离进程组的进程仍持有写端（典型是 daemon 未重定向输出）。
              // 取消读端让 pump 立即收尾，工具调用不再被它拖住。
              pipesTruncated = true;
              log.warn(
                "BASH",
                `命令已退出，但输出管道在 ${PIPE_DRAIN_GRACE_MS}ms 宽限期后仍未 EOF，` +
                  `判定为有脱离进程组的后台进程持有写端，已停止读取其后续输出`,
              );
              for (const reader of activePipeReaders) {
                try {
                  void reader.cancel().catch(() => {});
                } catch {
                  /* 读端已释放/已关闭 */
                }
              }
              // 等 pump 收尾。cancel 之后 read() 按 Web Streams 规范立刻返回 done，
              // 这里不会久等。**故意不加「再等一会儿就放弃」的兜底**：若某个运行时上
              // cancel 不生效，我们要的是测试立刻变红暴露它，而不是静默降级成
              // 「工具返回了、reader 和 fd 却一直泄漏」——后者比挂死更难发现。
              await pipesDone;
            }

            // pump 自身的异常（流损坏等）按旧语义上抛，走下面的 catch 分支。
            if (pipesFailure) throw pipesFailure;

            emitProgress(true);

            // 已转后台：不再构造前台 ToolResult，走 Task 收尾记账（对齐 spawnShellTask 的
            // child.on("exit")）。这里的返回值不会被消费——外层 Promise.race 早已用
            // detachPromise 的结果 resolve 了 execute()。穿 finalizeIfDetached 走一次函数
            // 调用边界，规避上面 DetachedTaskHandle 声明处注释的 tsc 窄化缺陷。
            if (finalizeIfDetached(detachedTaskHandle, (h) => h.markExited(exitCode))) {
              return { output: "" };
            }

            // CWD 追踪写回：仅前台、未取消、未超时、退出码 0 时写回全局 cwd。
            // 返回 `{switched}` = 真的切换了目录；`{staleCwd}` = 当前 cwd 已被删掉。
            // 两者都会在结果末尾追加一行告知（cwdChangeNotice / cwdStaleNotice）。
            const cwdState = this.applyCwdTracking(
              cwdFile,
              !aborted && !timedOut && exitCode === 0,
              cwd,
            );

            // 方向 3（git-status 快照冻结死循环修复）：非只读命令成功执行后失效 git 状态缓存。
            // git add/commit/restore/checkout、release.sh 等改动工作区的命令跑完后，下一次
            // generateGitStatusAttachment（含止损阀 remind 时的实时重抓）能拿到最新状态，
            // 而非命中 30s TTL 里的旧快照。只读命令（git status/log 等）不改状态，跳过以免抖缓存。
            if (!aborted && !timedOut && exitCode === 0 && !isReadOnlyCommand(params.command)) {
              try {
                const { clearGitStatusCache } = require("../config/attachments.ts");
                clearGitStatusCache();
              } catch {
                /* 失效缓存失败不阻断命令返回 */
              }

              // P2-3：git 操作使用度量。命令成功后分类 commit/push/pr_created 等并落计数，
              // 供 trace/telemetry 观察（非 git 操作静默忽略）。记账失败不阻断命令返回。
              try {
                const { recordGitOperation } = require("./git-operation-tracking.ts");
                recordGitOperation(params.command, Date.now());
              } catch {
                /* 度量失败不阻断命令返回 */
              }
            }

            // 合并输出
            let output = "";
            if (stdout) output += stdout;
            if (stderr) {
              if (output && !output.endsWith("\n")) output += "\n";
              output += stderr;
            }
            if (!output) output = "(命令无输出)";

            // 二进制输出检测
            if (isBinaryOutput(output)) {
              const byteCount = new TextEncoder().encode(output).length;
              output = `[检测到二进制输出，共 ${byteCount} 字节]`;
            } else {
              // 先剥终端控制序列再截断：顺序不能颠倒，二进制判定依赖控制字符密度（见 terminal-control.ts）
              output = truncateOutput(stripTerminalControl(output) || "(命令无输出)");
            }

            // 管道宽限期截断说明（见 runToCompletion 顶部「收尾顺序」注释）：
            // 必须追加在 truncateOutput 之后，否则这条提示本身会在长输出里被截掉——
            // 那正是最需要它出现的场合。转后台的执行不会走到这里（上面已提前 return）。
            if (pipesTruncated) output += PIPE_TRUNCATED_NOTICE;

            // 自建 worktree 的路径提示：只在成功时补（失败时 worktree 没建出来）
            if (!aborted && !timedOut && exitCode === 0) {
              output += worktreeAddNotice(params.command, cwd);
            }

            // 超时（缺口 1/2 修复）：杀掉进程树后给出明确的 kill 语义，
            // 并引导模型改用 run_in_background 而非无谓重试。
            if (timedOut) {
              // 实际墙钟耗时远超设定值 → 说明中途被系统挂起（休眠）。必须说清楚：
              // 否则模型会把"睡了 15 分钟"当成"这条命令真的要跑 15 分钟"，从而
              // 错误地拆分命令或放弃一条本来很快的操作。
              const actualMs = Date.now() - spawnedAt;
              const overshoot = actualMs - timeout;
              const sleepHint =
                overshoot > 30_000
                  ? `\n注意：实际墙钟耗时 ${(actualMs / 1000).toFixed(0)}s 远超设定的 ${timeout / 1000}s，` +
                    `期间系统很可能进入过休眠（命令本身未必慢）。`
                  : "";
              // 旧提示一律建议转后台，对 watch/常驻/等待输入的命令是错药（会话
              // 20261019-163503-c0e3e484：裸 vitest 进 watch，转后台后同样挂住）。
              // 诊断失败不能影响超时结果返回，故整体兜底回旧文案。
              let guidance = "如需长时间运行，请用 run_in_background=true 重试。";
              let redirectSection = "";
              try {
                ({ guidance, redirectSection } = buildTimeoutGuidance(
                  params.command,
                  output,
                  !stdout && !stderr,
                ));
              } catch {
                /* 诊断失败沿用旧文案 */
              }
              return {
                output: `命令执行超过 ${timeout / 1000} 秒被终止（超时）。${sleepHint}\n${guidance}\n部分输出:\n${output}${redirectSection}`,
                isError: true,
              };
            }

            if (aborted) {
              // 成因按 signal.reason 写，不再一律「用户取消」：同一个 signal 还会被同批 Bash 失败
              // 联动取消、看门狗、单轮硬超时 abort。模型读到「用户取消」会以为用户否决了这一步、
              // 放弃整条路线——真实成因是兄弟命令失败时，它该做的是修那条命令。
              return {
                output: `命令已取消并终止（${describeAbortReason(signal?.reason)}）。\n部分输出:\n${output}`,
                isError: true,
              };
            }

            // 沙箱归因（启发式，2026-10-20）：Seatbelt 的 denial 明细只写 macOS 统一日志，
            // 子进程 stderr 里只有它自己的 `Operation not permitted`（见 sandbox.ts
            // SANDBOX_DENIAL_STDERR_RE 的注释）。所以这里不做规则级归属，只在沙箱启用、
            // 命令失败且 stderr 出现权限拒绝特征时打一条 [SANDBOX] 行，给排查留 grep 锚点。
            //
            // 只在 exitCode !== 0 时调：成功命令即便 stderr 里有 "permission denied" 字样
            // （比如命令自己探测权限后继续走），也不该被记成沙箱相关失败。
            if (exitCode !== 0) {
              this.sandboxManager?.noteCommandFailure(params.command, stderr);
            }

            // 退出码语义解释（缺口 4 修复）：grep 无匹配 / diff 有差异 / find 部分不可访问
            // / test 条件为假 等，退出码非 0 但不是错误，不再误标 isError。
            const interp = interpretExitCode(params.command, exitCode);
            if (interp.isError) {
              log.info(
                "TOOL",
                `✓ 命令完成 code=${exitCode} stdout=${stdout.length}字符 stderr=${stderr.length}字符`,
              );
              // 引号畸形诊断：命令失败且疑似"手写引号被 shell 拆断"（中文/多行 commit message
              // 高频场景）时，附一段可直接照抄的 heredoc 写法，避免模型原样重发陷入死循环。
              let failOutput = `命令执行失败（退出码 ${exitCode}）:\n${output}`;
              if (looksLikeQuotingBreakage(params.command, exitCode, output)) {
                failOutput += `\n${quotingBreakageHint(params.command)}`;
              }
              return {
                output: failOutput,
                isError: true,
              };
            }

            log.info(
              "TOOL",
              `✓ 命令完成 code=${exitCode} stdout=${stdout.length}字符 stderr=${stderr.length}字符`,
            );

            // P1-3：合并冲突感知（超越 CC 的运行时增强）。git merge/rebase/cherry-pick/pull
            // 产生冲突时（输出含 CONFLICT），附一条提示引导模型按「合并冲突处理协议」逐个解决，
            // 双方都对时问用户，而不是盲目丢一侧。纯追加提示、不改退出码语义。
            const conflictHint = detectMergeConflictHint(params.command, output);
            if (conflictHint) {
              const base = output === "(命令无输出)" ? "" : `${output}\n`;
              return { output: withCwdNotice(`${base}${conflictHint}`, cwdState) };
            }

            // 非 0 但语义上非错误：附注语义提示（如 "无匹配"），帮助模型正确理解
            if (exitCode !== 0 && interp.message) {
              const note =
                output === "(命令无输出)" ? interp.message : `${output}\n(${interp.message})`;
              // 这一路 exitCode !== 0，`switched` 必为 undefined（不写回）；
              // ⚠️ 但 `staleCwd` **可以**有值 —— cwd 被删掉且命令本身也失败时就是这一路，
              // 而那正是最需要告知的场合（否则后续每条命令都 spawn ENOENT）。
              return { output: withCwdNotice(note, cwdState) };
            }
            // E1：非 0 退出码但语义上不是坏消息时，把说明放在**首行**。
            //
            // 为什么位置要紧：模型读结果的第一眼决定它要不要重试或改道。
            // `gh pr checks` 退出码 8 = 有检查 pending，是等待中的正常状态；此前它被包成
            // 「命令执行失败（退出码 8）」，模型据此反复重查、甚至去修一个不存在的缺陷（G8）。
            // 与上面 `message` 的分工见 command-semantics.ts 里 header 字段的注释。
            if (exitCode !== 0 && interp.header) {
              const body = output === "(命令无输出)" ? "" : `\n${output}`;
              return {
                output: withCwdNotice(`${interp.header}${body}`, cwdState),
                // D14：P1 的「结果没变」判据要的是**加工前**的原始输出。
                //
                // 首行说明会破坏 `gh pr checks` 的 TSV 形态（首行只有一列），
                // P1 拿加工后的正文做归一化会退回通用路径，拦截回执里的状态摘要
                // 从「1 项 pass，2 项 pending」退化成首行截断（实测 R7）。
                // meta 不进模型上下文，只供轨迹/遥测/判据消费（见 LegacyToolResult.meta）。
                // 只在 header 非空时填：范围极小，正常路径不增加任何体积。
                meta: { rawOutput: output },
              };
            }
            return { output: withCwdNotice(output, cwdState) };
          } catch (err) {
            // 已转后台时，pump/exited 阶段的异常记为任务失败（对齐 spawnShellTask 的
            // child.on("error")），不再向外抛——execute() 已经通过 detachPromise 返回过了。
            // 同上，穿 finalizeIfDetached 走一次函数调用边界规避 tsc 窄化缺陷。
            if (
              finalizeIfDetached(detachedTaskHandle, (h) =>
                h.markError(err instanceof Error ? err : new Error(String(err))),
              )
            ) {
              return { output: "" };
            }
            throw err;
          }
        })();

        // Ctrl+B 竞速：谁先 settle 用谁。未触发 detach 时 detachPromise 永远不会
        // resolve（没有 handler 调用过 resolveDetach），等价于原来的 `await runToCompletion`。
        return await Promise.race([detachPromise, runToCompletion]);
      } finally {
        foregroundDetachHandlers.delete(detachHandlerId);
        // detach 分支已经在 handler 内部清理过 timer/listener；未 detach 时这里兜底清理。
        // clearTimeout/removeEventListener 对已经清理过的 timer/listener 是安全的空操作，
        // 双重清理不会出错，无需额外按 detachedTaskHandle 分支。
        clearTimeout(timeoutId);
        clearInterval(wallClockTimer);
        signal?.removeEventListener("abort", abortHandler);
      }
    } catch (err: any) {
      // 异常路径也清理 cwd 临时文件，避免泄漏
      if (cwdFile) {
        try {
          unlinkSync(cwdFile);
        } catch {
          /* 忽略 */
        }
      }
      return { output: formatSpawnError(err, cwd), isError: true };
    }
  }

  /** Task 系统后台执行（新模式，不追踪 cwd） */
  private async executeWithTaskSystem(
    params: {
      command: string;
      cwd?: string;
      wait_until_seconds?: number;
    },
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const { spawnShellTask } = require("../task/index.ts");
    await this.snapshotReady;
    this.registerSnapshotToSandbox();
    const resolved = this.resolveCwd(params.cwd);
    if ("error" in resolved) return { output: resolved.error, isError: true };
    const { cwd } = resolved;
    // 后台任务：注入快照但不追踪 cwd
    const { commandString: rawTaskCommand } = this.buildCommand(params.command, {
      trackCwd: false,
    });
    // 内层 shell 与外层一致：shell-task.ts 用同一个 getPlatformShell()，
    // 写死 /bin/sh 会让 zsh 快照在 POSIX mode 下 source 失败（致命，见 sandbox.ts）。
    const commandString = this.sandboxManager?.isEnabled()
      ? this.sandboxManager.wrapCommand(rawTaskCommand, getPlatformShell().shell)
      : rawTaskCommand;

    const taskState = spawnShellTask({
      command: commandString,
      displayCommand: params.command,
      cwd,
      signal,
    });

    const waitNote = this.registerWaitUntil(
      taskState.id,
      params.command,
      params.wait_until_seconds,
    );

    return {
      output: JSON.stringify({
        task_id: taskState.id,
        status: taskState.status,
        output_file: taskState.outputFile,
        // F3：同 sub_agent 后台启动返回——明说不要轮询（20261019 轨迹 shell 任务也被 task_output 阻塞满 600s）
        // Q1：去掉运行期间读 output_file 的许可，与子代理 / Ctrl+B 回执共用同一常量。
        message: `命令已作为后台任务启动 (task_id: ${taskState.id})。${BACKGROUND_RECEIPT_NOTICE}${waitNote}`,
      }),
    };
  }

  /**
   * W1.3：`wait_until_seconds`——「这是一次等待」的显式声明。
   *
   * 为什么需要（G3）：CC 的分流规则是「只要一次通知就用后台 Bash + 会自己退出的循环」，
   * 而这条路在本仓被 60s 静默判据堵死——`until curl …; do sleep 5; done` 静默 60s 后
   * 就被判成「不会回报」，todo 闸门不再放行、headless 不再为它挂。声明期限之后，
   * harness 不必靠静默猜：期限内一直算「值得等」，到期由自己的定时器 kill + 通知。
   *
   * 不带这个参数的后台 bash 行为**与改动前完全相同**。
   */
  private registerWaitUntil(
    taskId: string,
    command: string,
    rawSeconds: number | undefined,
  ): string {
    if (typeof rawSeconds !== "number" || !Number.isFinite(rawSeconds)) return "";
    const clamped = Math.min(MAX_WAIT_UNTIL_S, Math.max(MIN_WAIT_UNTIL_S, Math.round(rawSeconds)));
    // 惰性 require：bash.ts 对 task 模块一贯如此（见 background-receipt.ts 的注释）
    const task = require("../task/index.ts") as typeof import("../task/index.ts");
    const registered = task.registerWait({
      id: taskId,
      kind: "shell",
      promise: { kind: "deadline", deadlineAt: Date.now() + clamped * 1000 },
      description: command.slice(0, 60),
      registeredAt: Date.now(),
    });
    if (!registered) return "";

    const timer = setTimeout(() => {
      const t = task.getTask(taskId);
      if (!t || t.status !== "running") return;
      // 期限就是回报：kill + 终态通知由 harness 自己执行，不依赖子进程配合
      task.killShellTask(taskId, {
        summary: `等待期限到（${clamped} 秒），条件未满足，已停止命令 "${command.slice(0, 60)}"`,
      });
    }, clamped * 1000);
    // 不阻止进程退出：等待由主循环的活跃度承载，进程要退出时不应该被这个定时器拖住
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    const clampNote =
      clamped !== Math.round(rawSeconds)
        ? `（已从 ${Math.round(rawSeconds)}s 钳制到 ${clamped}s）`
        : "";
    return (
      `\n已声明这是一次等待：最多等 ${clamped}s${clampNote}，期间不按「静默」判定；` +
      `到期仍在跑会被终止并以通知告知（不需要你轮询）。`
    );
  }
}
