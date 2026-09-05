/**
 * IDE 检测与匹配
 * 对标 Claude Code 的 IDE 发现逻辑
 */

import { getSortedIDELockfiles, cleanupStaleLockfiles } from "./lockfile.ts";
import type { DetectedIDE, IDELockfileContent } from "./types.ts";
import { resolveIDEHost } from "./wsl.ts";

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
    if (content.workspaceFolders?.some((folder) => isSubPath(cwd, folder))) {
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return null;
}

/**
 * 将 lockfile 转换为 DetectedIDE。
 *
 * host 不再硬编码 `127.0.0.1`（D8）：WSL 里 agent 与 Windows 侧 IDE 的回环
 * **不是同一个网络栈**，照着回环连永远连不上。`resolveIDEHost` 只在
 * 「我们在 WSL 里」且「lockfile 明说 IDE 在 Windows 上」时才偏离回环，
 * 其余一切情形逐字节保持原行为 —— 这也是 `runningInWindows` 这个字段
 * 从"一路传递但无人消费的死字段"变成真有效果的那个接点。
 */
export function lockfileToDetectedIDE(port: number, content: IDELockfileContent): DetectedIDE {
  const transport = content.transport ?? "sse";
  const protocol = transport === "ws" ? "ws" : "http";
  const host = resolveIDEHost(content.runningInWindows);
  return {
    url: `${protocol}://${host}:${port}`,
    name: content.ideName ?? "Unknown IDE",
    port,
    authToken: content.authToken,
    ideRunningInWindows: content.runningInWindows,
  };
}

/**
 * 检查 child 是否是 parent 的子路径（或相等）。
 *
 * ⚠️ **两侧必须先做 Unicode NFC 归一化，这不是可选的洁癖**（D6）：
 * macOS 的文件系统把路径按 **NFD** 存（`café` = `cafe` + U+0301 组合重音，5 个码位），
 * 而 VS Code 报上来的路径通常是 **NFC**（`café` = 4 个码位）。
 * 两个字符串**肉眼完全一样**，`===` 却返回 false。
 *
 * 后果是路径里含重音符或某些 CJK 组合字符的用户，工作区匹配 **100% 失败**
 * → IDE 发现永久失败，而**日志里打出来的两个路径看起来一模一样** ——
 * 这是最难排查的一类失效（属于「静默的边界失配」：两个系统在边界上对不齐，
 * 而边界本身不会报错）。
 *
 * 选 NFC 而不是 NFD：NFC 是 W3C / VS Code / 绝大多数上游的表示，
 * 归一到少数派一侧只会把问题挪个地方。
 */
export function isSubPath(child: string, parent: string): boolean {
  const normalizedChild = child.normalize("NFC").replace(/\/$/, "");
  const normalizedParent = parent.normalize("NFC").replace(/\/$/, "");
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + "/");
}
