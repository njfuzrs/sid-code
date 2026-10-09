/**
 * ripgrep 执行层
 * 对标 claude-code/src/utils/ripgrep.ts，提供健壮的 rg 调用封装。
 *
 * 核心能力：
 * - 超时控制（默认 20s，WSL 60s，可通过 settings.json searchTimeoutSeconds 或
 *   SID_GREP_TIMEOUT_SECONDS 环境变量配置）
 * - 两级终止：SIGTERM → 5s → SIGKILL
 * - EAGAIN 自动重试（单线程 -j 1）
 * - 超时抛 RipgrepTimeoutError，partialResults 带已扫到的部分结果（丢弃可能不完整的最后一行）
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
 * 超时配置（毫秒）。优先级：
 * 1. settings.json 的 searchTimeoutSeconds（可随团队默认配置分发，用户最容易发现）
 * 2. 环境变量 SID_GREP_TIMEOUT_SECONDS（秒）
 * 3. 缺省：WSL 60s（文件 I/O 慢 3-5x），其他平台 20s
 *
 * 为什么要有上限：headless / 子代理场景没人按 ESC，扫 ~ 或网络盘时会无限挂起。
 * 为什么 20s 够：rg 不排序时扫完整个家目录实测约 5s（2026-10-10，macOS）；
 * 之前 glob 撞线是因为 --sortr 让 rg 退化单线程（27–32s），不是上限太短。
 */
export function getTimeoutMs(): number {
  try {
    const { getSettings } = require("../config/settings/settings.ts");
    const v = getSettings().settings.searchTimeoutSeconds;
    if (typeof v === "number" && v > 0) return Math.round(v * 1000);
  } catch {
    /* settings 未初始化时回退 env，不让搜索因配置系统故障而失败 */
  }

  const envSeconds = parseInt(process.env.SID_GREP_TIMEOUT_SECONDS || "", 10) || 0;
  if (envSeconds > 0) return envSeconds * 1000;

  // WSL 文件 I/O 比原生慢 3-5x
  const isWsl =
    platform() === "linux" &&
    (process.env.WSL_DISTRO_NAME !== undefined || process.env.WSLENV !== undefined);
  return isWsl ? 60_000 : 20_000;
}

/**
 * 超时报错文案。两类读者各给一条出路：
 * - 模型：别把家目录 / 根目录当搜索根（轨迹 20261009-135641 两次都是 path=~）
 * - 用户：上限可调，且说清在哪调——否则配置项存在等于不存在
 */
export function formatTimeoutMessage(timeoutMs: number): string {
  return (
    `ripgrep 搜索超时（${timeoutMs / 1000}秒）。请缩小搜索范围：指定更具体的 path` +
    `（避免直接搜家目录或根目录）或更具体的 pattern。` +
    `如确需更长时间，可在 settings.json 设置 searchTimeoutSeconds，或设置环境变量 SID_GREP_TIMEOUT_SECONDS。`
  );
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
 * stderr 是否只包含逐路径的访问错误（`rg: <path>: ... (os error N)`）。
 * 参数错误（如 `unrecognized flag`）、正则错误不带 `(os error N)`，仍按失败处理——
 * 判据用白名单（每一行都得是路径错误），不用「包含某个子串」的黑名单。
 */
export function isOnlyPathAccessErrors(stderr: string): boolean {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((l) => /^rg: .+\(os error \d+\)$/.test(l));
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

    // 退出码 0 = 找到匹配，1 = 无匹配（都是正常情况）。
    // 退出码 2 且 stderr 全是逐路径访问错误（macOS TCC 保护目录、无权限子目录）= 搜索本身完成了，
    // 只是跳过了读不了的目录 → 也按正常结果返回。以前整体判失败，连带丢掉 stdout 里已扫到的
    // 匹配：path=~ 时必然命中（~/Library 下几十个受保护目录），2026-10-10 实测目标文件就在被丢的 stdout 里。
    if (exitCode === 0 || exitCode === 1 || (exitCode === 2 && isOnlyPathAccessErrors(stderr))) {
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

      // 有部分结果也必须抛错而不是 return：return 会把「扫了一半」伪装成「完整结果」，
      // 模型据此下「不存在」的结论；而且调用方 glob/grep 的部分结果分支依赖
      // partialResults 非空，以前这里先 return 了，导致那两个分支永远走不到（死接线）。
      throw new RipgrepTimeoutError(formatTimeoutMessage(timeoutMs), lines);
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
