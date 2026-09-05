/**
 * IDE Lockfile 协议实现
 * 对标 Claude Code 的 src/utils/ide.ts
 *
 * IDE 扩展在 ~/.sid-code/ide/ 目录下创建 <port>.lock 文件，
 * sid-code 轮询发现后将其注册为动态 MCP Server。
 */

import { readdir, readFile, unlink, stat } from "fs/promises";
import { join } from "path";
import { createConnection } from "net";
import { sidPaths } from "../config/paths.ts";
import type { IDELockfileContent } from "./types.ts";

/**
 * 端口探活超时。取 300ms 的理由：探的是 **127.0.0.1**，正常情形下
 * TCP 握手在个位数毫秒内完成或立刻 ECONNREFUSED；300ms 已是极宽的上界。
 * 而 cleanupStaleLockfiles 在 detectIDEs 里被**每秒轮询一次**地调用
 * （见 detect.ts 的 findAvailableIDE），超时值定大了会直接拖慢 IDE 发现。
 */
const PORT_PROBE_TIMEOUT_MS = 300;

/** Lockfile 目录 */
export function getIDELockfileDir(): string {
  return sidPaths.ideLockDir();
}

/** 读取单个 lockfile */
export async function readIDELockfile(filePath: string): Promise<{
  port: number;
  content: IDELockfileContent;
} | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const content: IDELockfileContent = JSON.parse(raw);
    // 端口从文件名提取：12345.lock → 12345
    const port = parseInt(filePath.match(/(\d+)\.lock$/)?.[1] ?? "0", 10);
    if (!port) return null;
    return { port, content };
  } catch {
    return null;
  }
}

/** 获取所有 lockfile，按修改时间排序（最新优先） */
export async function getSortedIDELockfiles(): Promise<
  Array<{
    port: number;
    content: IDELockfileContent;
    mtime: number;
  }>
> {
  try {
    const files = await readdir(getIDELockfileDir());
    const lockfiles = files.filter((f) => f.endsWith(".lock"));

    const results = await Promise.all(
      lockfiles.map(async (file) => {
        const filePath = join(getIDELockfileDir(), file);
        const [lockfile, fileStat] = await Promise.all([
          readIDELockfile(filePath),
          stat(filePath).catch(() => null),
        ]);
        if (!lockfile || !fileStat) return null;
        return { ...lockfile, mtime: fileStat.mtimeMs };
      }),
    );

    return results
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.mtime - a.mtime); // 最新优先
  } catch {
    return []; // 目录不存在等情况
  }
}

/**
 * 探测某个本地端口是否真的有人在监听。
 *
 * 为什么光验 PID 不够（D7）：IDE **进程活着**但扩展的监听端口已经没了
 * 是很常见的一种状态 —— 扩展崩了 / 被禁用 / 正在重载。这种 lockfile 用
 * PID 判据清不掉，于是 agent 会去连一个不响应的端口，症状是连接挂到超时。
 *
 * 只做一次短超时的 TCP 连接尝试，连上立刻拆掉（不发任何字节）：
 * 这里要回答的问题只是"有没有人 listen"，不是"对端是不是我们要的那个扩展"
 * （后者由 MCP 握手负责）。
 *
 * 判据是**三态**而不是布尔，这一点是刻意的：`unknown` 用于"探测本身出岔子"
 * （比如 fd 耗尽）。把 unknown 折叠成 false 会导致删掉本来健康的 lockfile ——
 * 清理动作必须**保守**：留一个过期文件的代价是一次连接失败并重试，
 * 删一个健康文件的代价是 IDE 明明开着却再也发现不了。
 */
export async function isPortListening(
  port: number,
  timeoutMs: number = PORT_PROBE_TIMEOUT_MS,
): Promise<boolean | "unknown"> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: boolean | "unknown") => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* 已经关了 */
      }
      resolve(result);
    };

    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(timeoutMs);

    socket.once("connect", () => done(true));
    // 超时不等于"没人听" —— 也可能是对端 accept 了但迟迟不回。
    // 但对 127.0.0.1 而言这已经足够异常，按"不可用"处理（清掉重新发现比连着挂住好）。
    socket.once("timeout", () => done(false));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      // ECONNREFUSED / EADDRNOTAVAIL = 明确没人监听
      if (err.code === "ECONNREFUSED" || err.code === "EADDRNOTAVAIL") return done(false);
      // 其余（EMFILE 等）是**我们这边**的问题，不能据此判定对端死了
      done("unknown");
    });
  });
}

/**
 * 清理过期 lockfile。
 *
 * 两道判据，任一确定性地指向"死了"就删：
 *   ① PID 不存活 —— IDE 进程本身没了
 *   ② PID 活着但端口没人监听 —— 扩展崩了/被禁用/重载中（D7）
 *
 * 探测失败（`unknown`）时**保留**文件：见 isPortListening 的注释，
 * 清理动作必须保守。
 */
export async function cleanupStaleLockfiles(): Promise<void> {
  const lockfiles = await getSortedIDELockfiles();

  await Promise.all(
    lockfiles.map(async ({ port, content }) => {
      const filePath = join(getIDELockfileDir(), `${port}.lock`);

      if (content.pid && !isProcessRunning(content.pid)) {
        await unlink(filePath).catch(() => {});
        return;
      }

      // 端口探活：PID 活着不代表扩展还在听
      const listening = await isPortListening(port);
      if (listening === false) {
        await unlink(filePath).catch(() => {});
      }
    }),
  );
}

/** 检查进程是否存活 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // 信号 0 不杀进程，只检查是否存在
    return true;
  } catch {
    return false;
  }
}
