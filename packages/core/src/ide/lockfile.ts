/**
 * IDE Lockfile 协议实现
 * 对标 Claude Code 的 src/utils/ide.ts
 *
 * IDE 扩展在 ~/.sid-code/ide/ 目录下创建 <port>.lock 文件，
 * sid-code 轮询发现后将其注册为动态 MCP Server。
 */

import { readdir, readFile, unlink, stat } from "fs/promises";
import { join } from "path";
import { sidPaths } from "../config/paths.ts";
import type { IDELockfileContent } from "./types.ts";

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
export async function getSortedIDELockfiles(): Promise<Array<{
  port: number;
  content: IDELockfileContent;
  mtime: number;
}>> {
  try {
    const files = await readdir(getIDELockfileDir());
    const lockfiles = files.filter(f => f.endsWith(".lock"));

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
 * 清理过期 lockfile
 * 检查 PID 是否存活，不存活则删除。
 */
export async function cleanupStaleLockfiles(): Promise<void> {
  const lockfiles = await getSortedIDELockfiles();

  for (const { port, content } of lockfiles) {
    if (content.pid && !isProcessRunning(content.pid)) {
      const filePath = join(getIDELockfileDir(), `${port}.lock`);
      await unlink(filePath).catch(() => {});
    }
  }
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
