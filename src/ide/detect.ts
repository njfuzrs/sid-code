/**
 * IDE 检测与匹配
 * 对标 Claude Code 的 IDE 发现逻辑
 */

import { getSortedIDELockfiles, cleanupStaleLockfiles } from "./lockfile.ts";
import type { DetectedIDE, IDELockfileContent } from "./types.ts";

/**
 * 检测可用的 IDE
 * 匹配策略（对标 Claude Code）：
 * 1. 环境变量端口匹配：SID_CODE_SSE_PORT
 * 2. 工作区目录匹配：cwd ∈ workspaceFolders
 */
export async function detectIDEs(cwd: string): Promise<DetectedIDE[]> {
  await cleanupStaleLockfiles();
  const lockfiles = await getSortedIDELockfiles();

  if (lockfiles.length === 0) return [];

  const envPort = process.env.SID_CODE_SSE_PORT
    ? parseInt(process.env.SID_CODE_SSE_PORT, 10)
    : null;

  const matches: DetectedIDE[] = [];

  for (const { port, content } of lockfiles) {
    // 环境变量端口精确匹配
    if (envPort !== null && port === envPort) {
      matches.push(lockfileToDetectedIDE(port, content));
      continue;
    }

    // 工作区目录匹配
    if (content.workspaceFolders?.some(folder => isSubPath(cwd, folder))) {
      matches.push(lockfileToDetectedIDE(port, content));
    }
  }

  return matches;
}

/**
 * 查找可用 IDE（带轮询）
 * 最多等待 timeoutMs，每秒检测一次。
 * 恰好一个匹配时返回，多个匹配返回 null（需要用户手动选择）。
 */
export async function findAvailableIDE(
  cwd: string,
  timeoutMs: number = 30_000,
  signal?: AbortSignal,
): Promise<DetectedIDE | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (signal?.aborted) return null;

    const matches = await detectIDEs(cwd);

    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) return null; // 多个匹配，需要用户手动选择

    // 等待 1 秒后重试
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return null;
}

/** 将 lockfile 转换为 DetectedIDE */
export function lockfileToDetectedIDE(port: number, content: IDELockfileContent): DetectedIDE {
  const transport = content.transport ?? "sse";
  const protocol = transport === "ws" ? "ws" : "http";
  return {
    url: `${protocol}://127.0.0.1:${port}`,
    name: content.ideName ?? "Unknown IDE",
    port,
    authToken: content.authToken,
    ideRunningInWindows: content.runningInWindows,
  };
}

/** 检查 child 是否是 parent 的子路径（或相等） */
export function isSubPath(child: string, parent: string): boolean {
  const normalizedChild = child.replace(/\/$/, "");
  const normalizedParent = parent.replace(/\/$/, "");
  return normalizedChild === normalizedParent
    || normalizedChild.startsWith(normalizedParent + "/");
}
