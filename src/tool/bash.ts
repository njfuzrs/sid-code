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

import type { LegacyTool as Tool, LegacyToolResult as ToolResult, PermissionResult, ToolUseContext } from "./types.ts";
import { spawn } from "bun";
import { platform } from "os";
import { join } from "path";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { getLogger } from "../debug/logger.ts";
import type { Config } from "../config/config.ts";
import { isReadOnlyCommand, isDestructiveCommand } from "./bash/read-only-validation.ts";
import { interpretExitCode } from "./bash/command-semantics.ts";
import { looksLikeQuotingBreakage, quotingBreakageHint } from "./bash/quoting-diagnostics.ts";
import { detectMergeConflictHint } from "./bash/merge-conflict.ts";
import { normalizeToolPath } from "./path-utils.ts";
import { registerCleanup } from "../utils/graceful-shutdown.ts";
import { ensureSidTempDir } from "../utils/temp-dir.ts";
import { getCwd, setCwd, getOriginalCwd } from "../bootstrap/state.ts";
import { createAndSaveSnapshot, escapeForShell } from "./bash/shell-snapshot.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** Bash 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const bashSchema = lazySchema(() =>
  z.object({
    command: z.string().describe("要执行的 shell 命令"),
    description: z.string().optional().describe("用自然语言描述这条命令要做什么（会显示给用户审批）"),
    timeout: z.number().optional().describe("超时时间（毫秒），默认 120000（2 分钟），最长 600000（10 分钟）；可用 BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS 环境变量覆盖默认值与上限"),
    cwd: z.string().optional().describe("工作目录，默认为当前目录"),
    is_background: z.boolean().optional().describe("[已废弃，请用 run_in_background] 后台运行。为兼容保留，行为已等同 run_in_background（走 Task 系统）"),
    run_in_background: z.boolean().optional().describe("是否以后台任务模式运行（通过 Task 系统管理，返回 task_id，完成后通知；用 task_output 查询输出）"),
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
  const maxMs = Math.max(parseEnv("BASH_MAX_TIMEOUT_MS") ?? FACTORY_MAX_TIMEOUT_MS, TIMEOUT_FLOOR_MS);
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
 * 取 5 行(而非更多)是为了控制执行中工具卡片实时活动区的高度：单个 shell 活项 = header + 命令行
 * + 进度行 ≈ 2 + 5 = 7 行，在默认的 alt-screen 有界视口下不会挤占过多可见空间。
 */
const PROGRESS_TAIL_LINES = 5;

/** 单行进度尾部的最大字符数（窄终端兜底，避免超长单行破坏对齐）。 */
const PROGRESS_LINE_MAX_CHARS = 200;

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
      line.length > PROGRESS_LINE_MAX_CHARS
        ? `${line.slice(0, PROGRESS_LINE_MAX_CHARS)}…`
        : line,
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
      spawn({ cmd: ["taskkill", "/pid", String(pid), "/T", "/F"], stdout: "ignore", stderr: "ignore" });
    } catch {
      try { fallbackKill ? fallbackKill() : process.kill(pid, signal); } catch { /* 已退出 */ }
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
    } catch { /* 进程可能已自行退出 */ }
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
} catch { /* 测试或非标准入口下可能不可用,忽略 */ }

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
    } catch { /* 单个 handler 异常不应影响其它并发前台执行 */ }
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

/** 检测二进制输出 */
function isBinaryOutput(data: string): boolean {
  if (data.length === 0) return false;

  // 检查是否包含 null 字节
  if (data.includes("\0")) return true;

  // 检查不可打印字符比例
  let nonPrintable = 0;
  const sampleSize = Math.min(data.length, 1000);

  for (let i = 0; i < sampleSize; i++) {
    const code = data.charCodeAt(i);
    // 不可打印字符（排除常见空白字符）
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintable++;
    }
  }

  // 如果超过 30% 是不可打印字符，视为二进制
  return nonPrintable / sampleSize > 0.3;
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

export class BashTool implements Tool {
  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = bashSchema();

  /** shell 环境快照文件路径（构造期异步创建；undefined 表示无快照，降级登录模式） */
  private snapshotFilePath: string | undefined;
  /** 快照创建完成的 Promise（永不 reject，失败时 snapshotFilePath 为 undefined） */
  private snapshotReady: Promise<void>;
  /** macOS Seatbelt 沙箱管理器（可选，通过 setter 注入） */
  private sandboxManager: import("../permission/sandbox.ts").SandboxManager | null = null;

  constructor() {
    // 构造期异步触发快照创建（BashTool 单例，cli.ts 仅 new 一次，构造期建快照成立）。
    // 不阻塞构造；execute 首次会 await snapshotReady 确保从第一条命令起就用上快照。
    this.snapshotReady = this.initSnapshot();
  }

  /** 注入沙箱管理器（macOS Seatbelt） */
  setSandboxManager(manager: import("../permission/sandbox.ts").SandboxManager | null): void {
    this.sandboxManager = manager;
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
  }

  name(): string {
    return "bash";
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
- 输出超过 30000 字符会被自动截断
- 长时间运行的进程（如 dev server）可设置 is_background=true 后台运行
- 后台进程会返回 PID，可用于后续管理
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
- 不自动 push / 建 PR（走 /commit-push-pr 或用户显式要求）

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
  private resolveCwd(rawCwd: string | undefined): string {
    let cwd = rawCwd ? normalizeToolPath(rawCwd) : getCwd();
    if (!existsSync(cwd)) {
      cwd = getOriginalCwd();
    }
    return cwd;
  }

  /**
   * 构造实际 spawn 的命令字符串（前台/后台三处路径共用，避免只改前台导致后台丢快照）。
   * - 有快照：`source <快照> 2>/dev/null || true && eval <命令>`（eval 触发二次解析使 alias 生效）
   * - 无快照：原样命令（spawn 时由 getPlatformShell({login:true}) 加 -l 重新 source 配置）
   * - trackCwd：命令末尾追加 `pwd -P >| <临时文件>`（>| 绕过 noclobber），仅前台、非 Windows
   * @returns commandString 拼接后命令；cwdFile 追踪文件路径（undefined 表示不追踪 cwd）
   */
  private buildCommand(
    rawCommand: string,
    opts: { trackCwd: boolean },
  ): { commandString: string; cwdFile: string | undefined } {
    const isWin = platform() === "win32";
    const parts: string[] = [];
    let cwdFile: string | undefined;

    if (this.snapshotFilePath && !isWin) {
      parts.push(`source ${escapeForShell(this.snapshotFilePath)} 2>/dev/null || true`);
      parts.push(`eval ${escapeForShell(rawCommand)}`);
    } else {
      parts.push(rawCommand);
    }

    // CWD 追踪仅对前台命令、非 Windows 生效（powershell 无 POSIX pwd -P 语义）
    if (opts.trackCwd && !isWin) {
      cwdFile = join(ensureSidTempDir(), `sid-code-cwd-${process.pid}-${++cwdFileCounter}`);
      parts.push(`pwd -P >| ${escapeForShell(cwdFile)}`);
    }

    return { commandString: parts.join(" && "), cwdFile };
  }

  /**
   * 命令成功完成后读取 cwd 临时文件并写回全局 cwd 状态；无论成功与否都清理临时文件。
   * @param success 命令是否成功（exitCode===0 且未被取消）。仅成功时才写回，失败时 pwd -P 未执行。
   */
  private applyCwdTracking(cwdFile: string | undefined, success: boolean): void {
    if (!cwdFile) return;
    try {
      if (success) {
        // 裸 readFileSync 需自行 NFC 归一化（normalizeToolPath 内部已做，但此处直读文件）
        const newCwd = readFileSync(cwdFile, "utf8").trim().normalize("NFC");
        if (newCwd && newCwd !== getCwd() && existsSync(newCwd)) {
          setCwd(newCwd);
        }
      }
    } catch {
      /* 文件不存在或读取失败（命令失败时 pwd 未执行），忽略 */
    } finally {
      try { unlinkSync(cwdFile); } catch { /* 忽略 */ }
    }
  }

  async execute(
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
      is_background?: boolean;
      run_in_background?: boolean;
    };

    if (!params.command) {
      return { output: "错误: 缺少 command 参数", isError: true };
    }

    // 预先取消守卫：若 signal 在进入时已 abort，直接返回而不 spawn。
    // 否则 addEventListener("abort") 晚于 abort 事件 → handler 永不触发 → 命令照常执行
    // （已复现：用户 ESC 后排队的 bash 调用会无视取消）。
    if (signal?.aborted) {
      return { output: "命令已取消（执行前 signal 已中止）", isError: true };
    }

    // 确保快照创建完成（首条命令可能赶在快照就绪前；snapshotReady 永不 reject）
    await this.snapshotReady;

    log.info("TOOL", `▶ 执行: ${params.command.slice(0, 200)}${params.command.length > 200 ? "..." : ""}`);

    // Task 系统后台模式（统一通道）。
    // P2-10：is_background 是旧后台通道（不进 Task 系统、无 task_id、无完成通知），弱模型
    // 选到它会落入"无法查询输出"死角。现把两个参数统一重定向到 Task 系统——is_background
    // 保留仅为向后兼容（schema 已标 deprecated），语义与 run_in_background 完全一致。
    if (params.run_in_background || params.is_background) {
      return this.executeWithTaskSystem(params, signal);
    }

    // 超时限制：默认值/上限支持 env 覆盖（BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS），
    // 下限恒为 1 秒。未传 timeout 用默认值，传了则夹在 [1s, max] 内。
    const { defaultMs, maxMs } = resolveTimeoutBounds();
    const timeout = Math.min(Math.max(params.timeout || defaultMs, TIMEOUT_FLOOR_MS), maxMs);
    const cwd = this.resolveCwd(params.cwd);
    const { shell, args } = getPlatformShell({ login: !this.snapshotFilePath });

    // CWD 追踪范围（缺口 5 并发竞态处理）：只读命令不含 cd，跳过写回。
    // 只读命令可并发执行（isConcurrencySafe），跳过 cwd 写回既零损失又消除两条并发
    // bash 互相覆盖全局 cwd 的竞态。非只读命令视为串行，正常追踪 cwd。
    const trackCwd = !isReadOnlyCommand(params.command);

    // 前台命令：拼接快照注入 + cwd 追踪
    const { commandString: rawCommand, cwdFile } = this.buildCommand(params.command, { trackCwd });
    // 沙箱包裹（macOS Seatbelt，启用时限制文件系统和网络访问）
    const commandString = this.sandboxManager?.isEnabled()
      ? this.sandboxManager.wrapCommand(rawCommand)
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
        } catch { /* 进度上报失败不影响命令执行 */ }
      };

      // 单一超时定时器：到点直接杀进程树并标记 timedOut（对标 claude-code #handleTimeout → #doKill）。
      // 不再玩"两个同延时定时器 + backgrounded 标志"的竞态把戏——旧实现里
      // timeoutId 先把 backgrounded 置 true，导致 timeoutPromise 的 resolve 永不触发，
      // Promise.race 只能等命令自然结束，超时保护形同虚设（实测 timeout=60s 命令跑满 87.5s）。
      const timeoutId = setTimeout(() => {
        timedOut = true;
        killProcessTree(proc.pid, "SIGKILL", () => proc.kill());
        log.info("BASH", `命令超时（${timeout / 1000}秒），已终止 PID ${proc.pid} 及其进程树`);
      }, timeout);

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
      const detachPromise = new Promise<ToolResult>((resolve) => { resolveDetach = resolve; });
      foregroundDetachHandlers.set(detachHandlerId, () => {
        if (detachedTaskHandle || timedOut || aborted) return false;
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", abortHandler);
        // 后台任务不追踪 cwd（对齐 executeWithTaskSystem 的既有语义）：cd 发生的时间点已经
        // 脱离"用户仍在等待这条命令"的因果链，异步写回全局 cwd 会与用户后续操作产生竞态。
        if (cwdFile) { try { unlinkSync(cwdFile); } catch { /* 忽略 */ } }

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
            message: `已将当前前台命令转入后台 (task_id: ${adopted.taskState.id})`,
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
        // - 超时/abort 杀进程树后 reader 会读到 done，pump 正常收尾，不泄漏；
        // - stdout/stderr 分别累积，最终合并逻辑与旧实现一致；
        // - Ctrl+B 转后台后（detachedTaskHandle 非 null）：新增内容改写盘、不再进内存
        //   累积（避免长跑后台进程内存无界增长），也不再触发前台进度回调。
        const pump = async (
          stream: ReadableStream<Uint8Array>,
          append: (text: string) => void,
        ): Promise<void> => {
          const reader = stream.getReader();
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
            try { reader.releaseLock(); } catch { /* 已释放 */ }
          }
        };

        // 正常完成链：包成一个立即执行的异步函数而不直接 await——这样 Ctrl+B 触发的
        // detachPromise 才能在它之前 settle，让 execute() 提前返回；pump/exited 不会被
        // "放弃"，Promise.race 的败者仍在事件循环里跑完，detach 后转去走 Task 收尾分支。
        const runToCompletion = (async (): Promise<ToolResult> => {
          try {
            await Promise.all([
              pump(proc.stdout, (t) => {
                if (detachedTaskHandle) { detachedTaskHandle.appendLiveOutput(t); return; }
                stdout += t;
              }),
              pump(proc.stderr, (t) => {
                if (detachedTaskHandle) { detachedTaskHandle.appendLiveOutput(t); return; }
                stderr += t;
              }),
            ]);
            const exitCode = await proc.exited;
            emitProgress(true);

            // 已转后台：不再构造前台 ToolResult，走 Task 收尾记账（对齐 spawnShellTask 的
            // child.on("exit")）。这里的返回值不会被消费——外层 Promise.race 早已用
            // detachPromise 的结果 resolve 了 execute()。穿 finalizeIfDetached 走一次函数
            // 调用边界，规避上面 DetachedTaskHandle 声明处注释的 tsc 窄化缺陷。
            if (finalizeIfDetached(detachedTaskHandle, (h) => h.markExited(exitCode))) {
              return { output: "" };
            }

            // CWD 追踪写回：仅前台、未取消、未超时、退出码 0 时写回全局 cwd。
            this.applyCwdTracking(cwdFile, !aborted && !timedOut && exitCode === 0);

            // 方向 3（git-status 快照冻结死循环修复）：非只读命令成功执行后失效 git 状态缓存。
            // git add/commit/restore/checkout、release.sh 等改动工作区的命令跑完后，下一次
            // generateGitStatusAttachment（含止损阀 remind 时的实时重抓）能拿到最新状态，
            // 而非命中 30s TTL 里的旧快照。只读命令（git status/log 等）不改状态，跳过以免抖缓存。
            if (!aborted && !timedOut && exitCode === 0 && !isReadOnlyCommand(params.command)) {
              try {
                const { clearGitStatusCache } = require("../config/attachments.ts");
                clearGitStatusCache();
              } catch { /* 失效缓存失败不阻断命令返回 */ }

              // P2-3：git 操作使用度量。命令成功后分类 commit/push/pr_created 等并落计数，
              // 供 trace/telemetry 观察（非 git 操作静默忽略）。记账失败不阻断命令返回。
              try {
                const { recordGitOperation } = require("./git-operation-tracking.ts");
                recordGitOperation(params.command, Date.now());
              } catch { /* 度量失败不阻断命令返回 */ }
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
              output = truncateOutput(output);
            }

            // 超时（缺口 1/2 修复）：杀掉进程树后给出明确的 kill 语义，
            // 并引导模型改用 run_in_background 而非无谓重试。
            if (timedOut) {
              return {
                output: `命令执行超过 ${timeout / 1000} 秒被终止（超时）。\n如需长时间运行，请用 run_in_background=true 重试。\n部分输出:\n${output}`,
                isError: true,
              };
            }

            if (aborted) {
              return {
                output: `用户取消，已终止命令。\n部分输出:\n${output}`,
                isError: true,
              };
            }

            // 退出码语义解释（缺口 4 修复）：grep 无匹配 / diff 有差异 / find 部分不可访问
            // / test 条件为假 等，退出码非 0 但不是错误，不再误标 isError。
            const interp = interpretExitCode(params.command, exitCode);
            if (interp.isError) {
              log.info("TOOL", `✓ 命令完成 code=${exitCode} stdout=${stdout.length}字符 stderr=${stderr.length}字符`);
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

            log.info("TOOL", `✓ 命令完成 code=${exitCode} stdout=${stdout.length}字符 stderr=${stderr.length}字符`);

            // P1-3：合并冲突感知（超越 CC 的运行时增强）。git merge/rebase/cherry-pick/pull
            // 产生冲突时（输出含 CONFLICT），附一条提示引导模型按「合并冲突处理协议」逐个解决，
            // 双方都对时问用户，而不是盲目丢一侧。纯追加提示、不改退出码语义。
            const conflictHint = detectMergeConflictHint(params.command, output);
            if (conflictHint) {
              const base = output === "(命令无输出)" ? "" : `${output}\n`;
              return { output: `${base}${conflictHint}` };
            }

            // 非 0 但语义上非错误：附注语义提示（如 "无匹配"），帮助模型正确理解
            if (exitCode !== 0 && interp.message) {
              const note = output === "(命令无输出)" ? interp.message : `${output}\n(${interp.message})`;
              return { output: note };
            }
            return { output };
          } catch (err) {
            // 已转后台时，pump/exited 阶段的异常记为任务失败（对齐 spawnShellTask 的
            // child.on("error")），不再向外抛——execute() 已经通过 detachPromise 返回过了。
            // 同上，穿 finalizeIfDetached 走一次函数调用边界规避 tsc 窄化缺陷。
            if (finalizeIfDetached(detachedTaskHandle, (h) => h.markError(err instanceof Error ? err : new Error(String(err))))) {
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
        signal?.removeEventListener("abort", abortHandler);
      }
    } catch (err: any) {
      // 异常路径也清理 cwd 临时文件，避免泄漏
      if (cwdFile) { try { unlinkSync(cwdFile); } catch { /* 忽略 */ } }
      return { output: formatSpawnError(err, cwd), isError: true };
    }
  }

  /** Task 系统后台执行（新模式，不追踪 cwd） */
  private async executeWithTaskSystem(params: {
    command: string;
    cwd?: string;
  }, signal?: AbortSignal): Promise<ToolResult> {
    const { spawnShellTask } = require("../task/index.ts");
    await this.snapshotReady;
    const cwd = this.resolveCwd(params.cwd);
    // 后台任务：注入快照但不追踪 cwd
    const { commandString: rawTaskCommand } = this.buildCommand(params.command, { trackCwd: false });
    const commandString = this.sandboxManager?.isEnabled()
      ? this.sandboxManager.wrapCommand(rawTaskCommand)
      : rawTaskCommand;

    const taskState = spawnShellTask({
      command: commandString,
      displayCommand: params.command,
      cwd,
      signal,
    });

    return {
      output: JSON.stringify({
        task_id: taskState.id,
        status: taskState.status,
        output_file: taskState.outputFile,
        message: `命令已作为后台任务启动 (task_id: ${taskState.id})`,
      }),
    };
  }
}
