/**
 * ripgrep 执行层
 * 对标 claude-code/src/utils/ripgrep.ts，提供健壮的 rg 调用封装。
 *
 * 核心能力：
 * - 超时控制（20s macOS/Linux）→ SIGTERM → 5s → SIGKILL 两级终止
 * - EAGAIN 自动重试（单线程 -j 1）
 * - 超时时返回部分结果（丢弃可能不完整的最后一行）
 * - 退出码 1 = 无匹配（正常返回 []，不是 error）
 * - 关键错误（ENOENT/EACCES/EPERM）直接 reject
 * - MAX_BUFFER = 20MB
 */

import { spawn } from "bun";

/** stdout 最大缓冲区大小（与 claude-code 一致） */
const MAX_BUFFER_SIZE = 20_000_000; // 20MB

/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 20_000;

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
  return (
    stderr.includes("os error 11") ||
    stderr.includes("Resource temporarily unavailable")
  );
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
  promise: Promise<{ stdout: string; stderr: string; truncatedStdout: boolean; truncatedStderr: boolean }>;
  cleanup: () => void;
} {
  const stdoutPromise = readStreamWithLimit(child.stdout as ReadableStream<Uint8Array> | null, MAX_BUFFER_SIZE);
  const stderrPromise = readStreamWithLimit(child.stderr as ReadableStream<Uint8Array> | null, MAX_BUFFER_SIZE);

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
): Promise<string[]> {
  const fullArgs = isRetry ? ["-j", "1", ...args, target] : [...args, target];
  const child = spawn(["rg", ...fullArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // 中止信号处理
  const abortListener = () => {
    child.kill("SIGTERM");
  };
  abortSignal.addEventListener("abort", abortListener, { once: true });

  const { promise, cleanup } = collectOutput(child);

  // 超时控制：两级终止（SIGTERM → 5s → SIGKILL）
  let killTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutId = setTimeout(() => {
    child.kill("SIGTERM");
    killTimeoutId = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
  }, DEFAULT_TIMEOUT_MS);

  try {
    const exitCode = await child.exited;
    const { stdout, stderr } = await promise;

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
      return lines;
    }

    // EAGAIN 重试
    if (!isRetry && isEagainError(stderr)) {
      return ripGrepInternal(args, target, abortSignal, true);
    }

    // 其他错误
    throw new Error(
      `ripgrep 退出码 ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`,
    );
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

    // 检查子进程是否被超时杀死
    const { stdout } = await promise; // 此时已终止，promise 应已 resolve

    const isKilled = child.killed;
    if (isKilled) {
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
        `ripgrep 搜索超时（${DEFAULT_TIMEOUT_MS / 1000}秒）。请尝试缩小搜索范围（指定更具体的 path 或 pattern）。`,
        lines,
      );
    }

    throw err;
  }
}

/**
 * 执行 ripgrep 搜索，返回结果行列表。
 *
 * @param args - rg 命令行参数（不含 "rg" 本身和 target）
 * @param target - 搜索目标路径
 * @param abortSignal - 中止信号
 * @returns 匹配行列表，无匹配时返回空数组
 * @throws {RipgrepTimeoutError} 超时且无任何结果
 */
export async function ripGrep(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  return ripGrepInternal(args, target, abortSignal, false);
}

/**
 * 检查系统是否安装了 ripgrep
 */
let _hasRipgrep: boolean | null = null;

export async function hasRipgrep(): Promise<boolean> {
  if (_hasRipgrep !== null) return _hasRipgrep;

  try {
    const child = spawn(["rg", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    _hasRipgrep = exitCode === 0;
    return _hasRipgrep;
  } catch {
    _hasRipgrep = false;
    return false;
  }
}
