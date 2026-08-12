/**
 * ripgrep 执行层
 * 对标 claude-code/src/utils/ripgrep.ts，提供健壮的 rg 调用封装。
 *
 * 核心能力：
 * - 超时控制（默认 20s，WSL 60s，可通过 SID_GREP_TIMEOUT_SECONDS 环境变量配置）
 * - 两级终止：SIGTERM → 5s → SIGKILL
 * - EAGAIN 自动重试（单线程 -j 1）
 * - 超时时返回部分结果（丢弃可能不完整的最后一行）
 * - 退出码 1 = 无匹配（正常返回 []，不是 error）
 * - 关键错误（ENOENT/EACCES/EPERM）直接 reject
 * - MAX_BUFFER = 20MB
 * - 缓冲区溢出时返回部分结果
 */

import { spawn } from "bun";
import { platform } from "node:os";
import { ensureRipgrepReleased } from "./ensure-ripgrep.ts";

/** stdout 最大缓冲区大小（与 claude-code 一致） */
const MAX_BUFFER_SIZE = 20_000_000; // 20MB

/**
 * rg 命令解析缓存。
 * undefined = 未解析；null = 不可用（触发 JS fallback）；string = 可执行 rg 命令/路径。
 */
let cachedRgCommand: string | null | undefined;

/**
 * 探测某个 rg 命令是否可执行（`rg --version` 退出码为 0）。
 */
async function probeRg(cmd: string): Promise<boolean> {
  try {
    const child = spawn([cmd, "--version"], { stdout: "pipe", stderr: "pipe" });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * 解析可用的 rg 命令（带模块级缓存）。
 *
 * 优先级：
 * 1. SID_RIPGREP_PATH 环境变量（用户/测试显式指定）
 * 2. 嵌入释放的 ~/.sid-code/bin/rg（编译产物自带，不依赖系统 PATH）
 * 3. 系统 PATH 里的 rg（dev 模式 / 释放失败时的回退）
 * 4. null（都不可用，调用方回退到 JS/系统 grep 实现）
 *
 * 结果缓存到 cachedRgCommand，后续调用不再重复 spawn 探测。
 */
export async function resolveRgCommand(): Promise<string | null> {
  if (cachedRgCommand !== undefined) return cachedRgCommand;

  const override = process.env.SID_RIPGREP_PATH?.trim();
  if (override) {
    return (cachedRgCommand = override);
  }

  // 编译产物：优先用嵌入释放的 rg（dev 模式 ensureRipgrepReleased 返回 null）
  const released = await ensureRipgrepReleased();
  if (released && (await probeRg(released))) {
    return (cachedRgCommand = released);
  }

  // 回退系统 PATH 里的 rg
  if (await probeRg("rg")) {
    return (cachedRgCommand = "rg");
  }

  return (cachedRgCommand = null);
}

/** 仅供测试：重置 rg 命令解析缓存 */
export function __resetRgCommandCacheForTest(): void {
  cachedRgCommand = undefined;
}

/**
 * 超时配置（毫秒）
 * - 优先读取环境变量 SID_GREP_TIMEOUT_SECONDS（秒）
 * - WSL 环境性能较差，默认 60s
 * - 其他平台默认 20s
 */
function getTimeoutMs(): number {
  const envSeconds = parseInt(process.env.SID_GREP_TIMEOUT_SECONDS || "", 10) || 0;
  if (envSeconds > 0) return envSeconds * 1000;

  // WSL 文件 I/O 比原生慢 3-5x
  const isWsl =
    platform() === "linux" &&
    (process.env.WSL_DISTRO_NAME !== undefined || process.env.WSLENV !== undefined);
  return isWsl ? 60_000 : 20_000;
}

/** 超时错误 */
export class RipgrepTimeoutError extends Error {
  constructor(
    message: string,
    public readonly partialResults: string[],
  ) {
    super(message);
    this.name = "RipgrepTimeoutError";
  }
}

/**
 * 检查是否 EAGAIN 错误（资源暂时不可用）
 */
function isEagainError(stderr: string): boolean {
  return stderr.includes("os error 11") || stderr.includes("Resource temporarily unavailable");
}

/**
 * 使用 ReadableStream reader 读取流，带缓冲区上限
 */
async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxSize: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };

  const reader = stream.getReader();
  let text = "";
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!truncated) {
        text += new TextDecoder().decode(value);
        if (text.length > maxSize) {
          text = text.slice(0, maxSize);
          truncated = true;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text, truncated };
}

/**
 * 在子进程中收集 stdout/stderr，带缓冲区上限
 * Bun 的 spawn 返回 ReadableStream，不使用 Node.js EventEmitter API
 */
function collectOutput(child: ReturnType<typeof spawn>): {
  promise: Promise<{
    stdout: string;
    stderr: string;
    truncatedStdout: boolean;
    truncatedStderr: boolean;
  }>;
  cleanup: () => void;
} {
  const stdoutPromise = readStreamWithLimit(
    child.stdout as ReadableStream<Uint8Array> | null,
    MAX_BUFFER_SIZE,
  );
  const stderrPromise = readStreamWithLimit(
    child.stderr as ReadableStream<Uint8Array> | null,
    MAX_BUFFER_SIZE,
  );

  const promise = Promise.all([stdoutPromise, stderrPromise]).then(([stdout, stderr]) => ({
    stdout: stdout.text,
    stderr: stderr.text,
    truncatedStdout: stdout.truncated,
    truncatedStderr: stderr.truncated,
  }));

  const cleanup = () => {
    // ReadableStream reader 通过 releaseLock 清理，无需额外操作
  };

  return { promise, cleanup };
}

/**
 * 执行 ripgrep 搜索（内部实现）
 * @param isRetry 是否为 EAGAIN 重试，重试时强制单线程
 */
async function ripGrepInternal(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  isRetry: boolean,
  cwd?: string,
): Promise<string[]> {
  const fullArgs = isRetry ? ["-j", "1", ...args, target] : [...args, target];
  const rgCmd = (await resolveRgCommand()) ?? "rg";
  const child = spawn([rgCmd, ...fullArgs], {
    stdout: "pipe",
    stderr: "pipe",
    ...(cwd ? { cwd } : {}),
  });

  // 中止信号处理
  const abortListener = () => {
    child.kill("SIGTERM");
  };
  abortSignal.addEventListener("abort", abortListener, { once: true });

  const { promise, cleanup } = collectOutput(child);

  // 超时控制：两级终止（SIGTERM → 5s → SIGKILL）
  // 注意：Bun 的 child.killed 在进程退出后恒为 true（与 Node.js 语义不同），
  // 因此必须用显式 flag 判断是否真正超时，不能依赖 child.killed。
  const timeoutMs = getTimeoutMs();
  let timedOut = false;
  let killTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killTimeoutId = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
  }, timeoutMs);

  try {
    const exitCode = await child.exited;
    const { stdout, stderr, truncatedStdout } = await promise;

    cleanup();
    clearTimeout(timeoutId);
    clearTimeout(killTimeoutId);
    abortSignal.removeEventListener("abort", abortListener);

    // 退出码 0 = 找到匹配，1 = 无匹配（都是正常情况）
    if (exitCode === 0 || exitCode === 1) {
      const lines = stdout
        .trim()
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter(Boolean);

      // 缓冲区溢出时丢弃最后一行（可能不完整）
      if (truncatedStdout && lines.length > 0) {
        lines.pop();
      }

      return lines;
    }

    // 关键错误：直接抛出
    const CRITICAL_ERROR_CODES = ["ENOENT", "EACCES", "EPERM"];
    for (const code of CRITICAL_ERROR_CODES) {
      if (stderr.includes(code)) {
        throw new Error(`ripgrep 关键错误 (${code}): ${stderr.trim()}`);
      }
    }

    // EAGAIN 重试（仅限首次）
    if (!isRetry && isEagainError(stderr)) {
      return ripGrepInternal(args, target, abortSignal, true, cwd);
    }

    // 其他错误（如 exit code 2: 无效参数/flag）
    throw new Error(`ripgrep 退出码 ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`);
  } catch (err: any) {
    cleanup();
    clearTimeout(timeoutId);
    clearTimeout(killTimeoutId);
    abortSignal.removeEventListener("abort", abortListener);
    child.kill("SIGKILL"); // 确保进程已终止

    // 中止信号 → 返回空（不算错误）
    if (abortSignal.aborted) {
      return [];
    }

    // 只有真正超时才走超时路径（用显式 timedOut flag，不依赖 Bun 的 child.killed）
    if (timedOut) {
      const { stdout } = await promise; // 此时已终止，promise 应已 resolve

      let lines = stdout
        .trim()
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter(Boolean);

      // 丢弃可能不完整的最后一行
      if (lines.length > 0) {
        lines = lines.slice(0, -1);
      }

      if (lines.length > 0) {
        return lines;
      }

      throw new RipgrepTimeoutError(
        `ripgrep 搜索超时（${timeoutMs / 1000}秒）。请尝试缩小搜索范围（指定更具体的 path 或 pattern）。`,
        lines,
      );
    }

    // 非超时错误（如 exit code 2: unrecognized flag）→ 直接抛出原始错误
    throw err;
  }
}

/**
 * 检查 ripgrep 是否可用（嵌入释放的 / 系统 PATH 的 / SID_RIPGREP_PATH 指定的）。
 * 基于 resolveRgCommand 的缓存，不再每次 spawn 探测。
 */
export async function hasRipgrep(): Promise<boolean> {
  return (await resolveRgCommand()) !== null;
}

/**
 * 主入口：执行 ripgrep 搜索
 *
 * @param args ripgrep 参数（不含 target 路径）
 * @param target 搜索路径
 * @param abortSignal 中止信号
 * @param cwd 可选：子进程工作目录。设置后 rg 的 --glob 模式锚定到此目录
 *            （rg 的 --glob 相对 spawn cwd 而非 target 位置参数），glob 工具据此
 *            把搜索根设为 cwd、target 传 "."，使相对 glob 正确匹配 + 输出相对路径。
 * @returns 匹配行数组
 */
export async function ripGrep(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  cwd?: string,
): Promise<string[]> {
  return ripGrepInternal(args, target, abortSignal, false, cwd);
}
