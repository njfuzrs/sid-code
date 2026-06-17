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
    timeout: z.number().optional().describe("超时时间（毫秒），默认 120000（2 分钟），最长 600000（10 分钟）"),
    cwd: z.string().optional().describe("工作目录，默认为当前目录"),
    is_background: z.boolean().optional().describe("是否后台运行（不等待命令完成，立即返回 PID）"),
    run_in_background: z.boolean().optional().describe("是否以后台任务模式运行（通过 Task 系统管理，完成后通知）"),
  }),
);

/** Bash 输出截断阈值（对标 Claude Code 30000 字符） */
const MAX_OUTPUT_LENGTH = 30000;

/** 后台进程延迟时间（200ms 后切换到后台） */
const BACKGROUND_DELAY_MS = 200;

/** 后台进程 PID 跟踪 */
const backgroundPids = new Set<number>();

/** cwd 临时文件计数器（与 pid 组合保证并发命令的临时文件名唯一） */
let cwdFileCounter = 0;

/**
 * 杀掉所有残留后台进程并清空跟踪表(LEAK-3)。
 * 退出时由 graceful-shutdown 调用,避免 backgroundPids 无界增长 + 孤儿进程残留。
 */
export function killBackgroundProcesses(): void {
  for (const pid of backgroundPids) {
    try { process.kill(pid); } catch { /* 进程可能已自行退出 */ }
  }
  backgroundPids.clear();
}

// 自注册到优雅关闭序列(退出时清理后台进程)
try {
  registerCleanup(killBackgroundProcesses);
} catch { /* 测试或非标准入口下可能不可用,忽略 */ }

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

export class BashTool implements Tool {
  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = bashSchema();

  /** shell 环境快照文件路径（构造期异步创建；undefined 表示无快照，降级登录模式） */
  private snapshotFilePath: string | undefined;
  /** 快照创建完成的 Promise（永不 reject，失败时 snapshotFilePath 为 undefined） */
  private snapshotReady: Promise<void>;

  constructor() {
    // 构造期异步触发快照创建（BashTool 单例，cli.ts 仅 new 一次，构造期建快照成立）。
    // 不阻塞构造；execute 首次会 await snapshotReady 确保从第一条命令起就用上快照。
    this.snapshotReady = this.initSnapshot();
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
- 必须提供 description 参数，用自然语言描述命令意图
- 设置合理的 timeout，默认 2 分钟，最长 10 分钟
- 输出超过 30000 字符会被自动截断
- 长时间运行的进程（如 dev server）可设置 is_background=true 后台运行
- 后台进程会返回 PID，可用于后续管理
- 每条命令在独立 shell 进程中执行。cd 后的目录变更会被自动追踪并对所有工具（read/edit/glob 等）生效，无需每次重复传 cwd；
  但 export、source venv/bin/activate 等动态环境变更不会跨命令保留——需要它们的操作必须写在同一条命令里。
  例：\`cd src\` 后下一条 \`ls\` 会列 src 目录（可拆两条）；但 \`source venv/bin/activate && python foo.py\` 必须写为一条`;
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

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
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

    // 确保快照创建完成（首条命令可能赶在快照就绪前；snapshotReady 永不 reject）
    await this.snapshotReady;

    log.info("TOOL", `▶ 执行: ${params.command.slice(0, 200)}${params.command.length > 200 ? "..." : ""}`);

    // Task 系统后台模式（新）
    if (params.run_in_background) {
      return this.executeWithTaskSystem(params, signal);
    }

    // 旧后台模式（兼容）
    if (params.is_background) {
      return this.executeBackground(params);
    }

    // 超时限制：最短 1 秒，最长 10 分钟
    const timeout = Math.min(Math.max(params.timeout || 120000, 1000), 600000);
    const cwd = this.resolveCwd(params.cwd);
    const { shell, args } = getPlatformShell({ login: !this.snapshotFilePath });

    // CWD 追踪范围（缺口 5 并发竞态处理）：只读命令不含 cd，跳过写回。
    // 只读命令可并发执行（isConcurrencySafe），跳过 cwd 写回既零损失又消除两条并发
    // bash 互相覆盖全局 cwd 的竞态。非只读命令视为串行，正常追踪 cwd。
    const trackCwd = !isReadOnlyCommand(params.command);

    // 前台命令：拼接快照注入 + cwd 追踪
    const { commandString, cwdFile } = this.buildCommand(params.command, { trackCwd });

    // 准备环境变量（如果启用了清理）
    let env = process.env;
    if (globalConfig && (globalConfig as any).sanitizeEnv) {
      const { sanitizeEnv } = await import("../config/env-sanitizer.ts");
      env = sanitizeEnv(process.env as Record<string, string>);
      log.debug("BASH", `环境变量已清理，保留 ${Object.keys(env).length} 个变量`);
    }

    try {
      const proc = spawn({
        cmd: [shell, ...args, commandString],
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      // 超时控制 + AbortSignal 集成
      let killed = false;
      let killReason = "";
      let backgrounded = false;

      const timeoutId = setTimeout(() => {
        // 超时自动后台化：不终止进程，而是转为后台任务
        backgrounded = true;
        killReason = `命令超时（${timeout / 1000}秒），已自动转为后台运行`;
        const pid = proc.pid;
        if (pid) backgroundPids.add(pid);
        log.info("BASH", `命令超时，PID ${pid} 自动转为后台运行`);
      }, timeout);

      // AbortSignal 监听
      const abortHandler = () => {
        killed = true;
        killReason = "用户取消";
        proc.kill();
      };
      signal?.addEventListener("abort", abortHandler);

      // 使用 Promise.race 实现超时后台化：超时时立即返回，进程继续后台运行
      const outputPromise = (async () => {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", abortHandler);

        const exitCode = await proc.exited;

        // CWD 追踪写回：仅前台、未取消、未后台化、退出码 0 时写回全局 cwd。
        // backgrounded 为 true 时跳过写回（命令已转后台，可能尚未执行 pwd -P）。
        if (!backgrounded) {
          this.applyCwdTracking(cwdFile, !killed && exitCode === 0);
        }

        // 合并输出
        let output = "";
        if (stdout) output += stdout;
        if (stderr) {
          if (output && !output.endsWith("\n")) output += "\n";
          if (stderr) output += stderr;
        }
        if (!output) output = "(命令无输出)";

        // 二进制输出检测
        if (isBinaryOutput(output)) {
          const byteCount = new TextEncoder().encode(output).length;
          output = `[检测到二进制输出，共 ${byteCount} 字节]`;
        } else {
          output = truncateOutput(output);
        }

        if (killed) {
          return {
            output: `${killReason}，已终止命令。\n部分输出:\n${output}`,
            isError: true,
          };
        }

        if (exitCode !== 0) {
          log.info("TOOL", `✓ 命令完成 code=${exitCode} stdout=${stdout.length}字符 stderr=${stderr.length}字符`);
          return {
            output: `命令执行失败（退出码 ${exitCode}）:\n${output}`,
            isError: true,
          };
        }

        log.info("TOOL", `✓ 命令完成 code=0 stdout=${stdout.length}字符 stderr=${stderr.length}字符`);
        return { output };
      })();

      // LEAK-2 修复：保存该定时器 id，竞速结束后无论哪条路径都 clear，
      // 避免命令正常完成后这个冗余 setTimeout 仍空转到 timeout 才触发空回调。
      let backgroundTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<ToolResult | null>((resolve) => {
        backgroundTimeoutId = setTimeout(() => {
          if (!killed && !backgrounded) {
            backgrounded = true;
            resolve(null); // 触发后台化
          }
        }, timeout);
      });

      // 正常完成 vs 超时后台化
      const raceResult = await Promise.race([
        outputPromise.then(r => ({ type: "done" as const, result: r })),
        timeoutPromise.then(() => ({ type: "timeout" as const, result: null })),
      ]);

      // 竞速已分出胜负，冗余的后台化定时器不再需要，立即清除。
      if (backgroundTimeoutId !== undefined) clearTimeout(backgroundTimeoutId);

      if (raceResult.type === "timeout") {
        const pid = proc.pid;
        if (pid) backgroundPids.add(pid);
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", abortHandler);
        // 命令转后台，cwd 临时文件不再读取，直接清理（pwd -P 可能稍后才执行，留孤儿可接受）
        if (cwdFile) { try { unlinkSync(cwdFile); } catch { /* 忽略 */ } }
        log.info("BASH", `命令超时（${timeout / 1000}秒），PID ${pid} 自动转为后台运行`);
        return {
          output: `命令执行超过 ${timeout / 1000} 秒，已自动转为后台运行。PID: ${pid}\n可使用 \`kill ${pid}\` 终止进程。`,
          isError: false,
        };
      }

      return raceResult.result;
    } catch (err: any) {
      // 异常路径也清理 cwd 临时文件，避免泄漏
      if (cwdFile) { try { unlinkSync(cwdFile); } catch { /* 忽略 */ } }
      return { output: `执行命令失败: ${err.message}`, isError: true };
    }
  }

  /** 后台执行命令（不追踪 cwd：命令未完成，pwd -P 行不应触发写回） */
  private async executeBackground(params: {
    command: string;
    cwd?: string;
  }): Promise<ToolResult> {
    const log = getLogger();
    await this.snapshotReady;
    const cwd = this.resolveCwd(params.cwd);
    const { shell, args } = getPlatformShell({ login: !this.snapshotFilePath });
    // 后台命令：注入快照但不追踪 cwd
    const { commandString } = this.buildCommand(params.command, { trackCwd: false });

    // 准备环境变量（如果启用了清理）
    let env = process.env;
    if (globalConfig && (globalConfig as any).sanitizeEnv) {
      const { sanitizeEnv } = await import("../config/env-sanitizer.ts");
      env = sanitizeEnv(process.env as Record<string, string>);
      log.debug("BASH", `环境变量已清理，保留 ${Object.keys(env).length} 个变量`);
    }

    try {
      const proc = spawn({
        cmd: [shell, ...args, commandString],
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      // 等待一小段时间收集初始输出
      await new Promise(resolve => setTimeout(resolve, BACKGROUND_DELAY_MS));

      const pid = proc.pid;
      backgroundPids.add(pid);

      // 尝试读取初始输出（非阻塞）
      let initialOutput = "";
      try {
        const stdout = await Promise.race([
          new Response(proc.stdout).text(),
          new Promise<string>(resolve => setTimeout(() => resolve(""), 100)),
        ]);
        if (stdout) initialOutput = stdout.slice(0, 500); // 只取前 500 字符
      } catch {
        // 忽略读取失败
      }

      log.info("TOOL", `✓ 命令已在后台运行 PID=${pid}`);

      let output = `命令已在后台运行 (PID: ${pid})`;
      if (initialOutput) {
        output += `\n\n初始输出:\n${initialOutput}`;
      }

      return { output };
    } catch (err: any) {
      return { output: `后台执行失败: ${err.message}`, isError: true };
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
    const { commandString } = this.buildCommand(params.command, { trackCwd: false });

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
