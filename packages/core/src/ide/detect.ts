/**
 * IDE 检测与匹配
 * 对标 Claude Code 的 IDE 发现逻辑
 */

import { getSortedIDELockfiles, cleanupStaleLockfiles, isProcessRunning } from "./lockfile.ts";
import type { DetectedIDE, IDELockfileContent } from "./types.ts";
import { resolveIDEHost } from "./wsl.ts";
import { getAncestorPids, type AncestorLookup, type ProcessTableRunner } from "./process-tree.ts";

/**
 * 检测可用的 IDE
 * 匹配策略（对标 Claude Code）：
 * 1. 环境变量端口匹配：SID_CODE_SSE_PORT（命中即有效，且**不做祖先消歧** ——
 *    端口是用户显式指定的，消歧反而会把指定的那个滤掉）
 * 2. 工作区目录匹配：cwd ∈ workspaceFolders
 * 3. 多个窗口的工作区重叠时，用 PID 祖先消歧（见 {@link belongsToThisTerminal}）
 *
 * `options` 只给测试注入用：生产调用不传，祖先链查真实进程表。
 */
export async function detectIDEs(
  cwd: string,
  options?: {
    /**
     * 注入祖先链（含直接父进程）。只给测试用：生产不传，查真实进程表。
     * 必须**包含**直接父进程 —— {@link getAncestorPids} 返回的是父进程的祖先，不含父进程自己，
     * 而「父进程就是该 IDE」是最常见的命中形态，漏了它消歧会把真正的窗口滤掉。
     *
     * 语义是「查询成功，链就是这些」：传空集表示链上一个都没有，
     * 消歧会据此滤掉所有候选。要表达「查询失败、没有把握」用 {@link ancestorLookup}。
     */
    ancestorPids?: Set<number>;
    /**
     * 注入完整的查询结果，用于测试「查询失败」这条退路。
     * `{ ok: false }` 与 `ancestorPids: new Set()` 对消歧的效果正好相反
     * （前者保留全部候选，后者全部滤掉），两者不可互相替代。给出时优先于 ancestorPids。
     */
    ancestorLookup?: AncestorLookup;
    processTable?: ProcessTableRunner;
  },
): Promise<DetectedIDE[]> {
  await cleanupStaleLockfiles();
  const lockfiles = await getSortedIDELockfiles();

  if (lockfiles.length === 0) return [];

  const envPort = process.env.SID_CODE_SSE_PORT
    ? parseInt(process.env.SID_CODE_SSE_PORT, 10)
    : null;

  // 祖先链查询是懒的，而且整次检测只查一次：绝大多数 lockfile 在工作区匹配时
  // 就被排除了，只有真的重叠时才值得为它付一次 ps。
  let lookup: AncestorLookup | null =
    options?.ancestorLookup !== undefined
      ? options.ancestorLookup
      : options?.ancestorPids !== undefined
        ? { ok: true, pids: options.ancestorPids }
        : null;
  const loadAncestors = async (): Promise<AncestorLookup> => {
    if (lookup === null) {
      const walked = await getAncestorPids(process.ppid, options?.processTable);
      // 查询成功才补父进程：getAncestorPids 从父进程往上走，不含父进程自己，
      // 而「父进程就是该 IDE」是最常见的命中。查询失败时不能补 —— 补了就把
      // 「没查到」伪装成「链上只有父进程」，消歧会据此滤掉所有别的窗口。
      if (walked.ok) walked.pids.add(process.ppid);
      lookup = walked;
    }
    return lookup;
  };

  const matches: DetectedIDE[] = [];

  for (const { port, content } of lockfiles) {
    // 环境变量端口精确匹配：用户显式指定，不做消歧
    if (envPort !== null && port === envPort) {
      matches.push(lockfileToDetectedIDE(port, content));
      continue;
    }

    // 工作区目录匹配
    const sub = content.workspaceFolders?.some((folder) => isSubPath(cwd, folder));
    if (sub) {
      const detected = lockfileToDetectedIDE(port, content);
      if (await belongsToThisTerminal(detected, loadAncestors)) {
        matches.push(detected);
      }
    }
  }

  return matches;
}

/**
 * 这个 lockfile 的 IDE 是不是「启动我们的那个窗口」。
 *
 * 只在受支持 IDE 的内置终端里才过滤（`TERM_PROGRAM` 命中）：
 * 外部终端里我们的祖先是 shell/tmux，lockfile 的 PID 不可能在里面，
 * 过滤恒为空 —— 那样会把所有 IDE 都滤掉，自动连接整体失灵。
 *
 * 返回 false（滤掉）的前提是**消歧有把握**：祖先链查到了，且该 PID 不在其中。
 * 下面几种一律返回 true（保留），因为滤掉一个不该滤的候选，
 * 代价是 IDE 明明开着却发现不了：
 *   - 不在 IDE 内置终端里
 *   - lockfile 没有活着的 PID（死进程的清理由 cleanupStaleLockfiles 负责）
 *   - 祖先链查不到（进程查询失败、Windows 上没有 ps）
 */
async function belongsToThisTerminal(
  detected: DetectedIDE,
  loadAncestors: () => Promise<Set<number>>,
): Promise<boolean> {
  if (!isSupportedIdeTerminal()) return true;
  if (detected.pid === undefined) return true;

  const ancestors = await loadAncestors();
  // 查询失败 = 没有把握。保留候选：滤掉的代价是 IDE 明明开着却发现不了。
  if (!ancestors.ok) return true;
  return ancestors.pids.has(detected.pid);
}

/**
 * 查找可用 IDE（带轮询）
 * 最多等待 timeoutMs，每秒检测一次。
 *
 * 恰好一个匹配时返回。多于一个时返回 null（需要用户手动选择）——
 * 多个窗口工作区重叠时的 PID 祖先消歧发生在 {@link detectIDEs} 里，
 * 能消歧的到这里已经只剩一个了。
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
    // 多于一个：消歧已经在 detectIDEs 里做过了（祖先链之外的候选被滤掉），
    // 走到这里说明剩下的确实分不清，不再轮询空等，直接交给手动选择。
    if (matches.length > 1) return null;

    // 等待 1 秒后重试
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return null;
}

/** 当前是否跑在受支持 IDE 的内置终端里（与 integration.ts 的 isSupportedTerminal 同一判据） */
function isSupportedIdeTerminal(): boolean {
  const termProgram = process.env.TERM_PROGRAM?.toLowerCase() ?? "";
  return ["vscode", "cursor", "windsurf"].includes(termProgram);
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
    // 只在进程确实活着时才带上 PID：死进程的 PID 会在消歧时被误当成「不是我们的祖先」
    // 而丢掉一个本该保留的候选（进程死了的 lockfile 由 cleanupStaleLockfiles 负责清）。
    pid: content.pid !== undefined && isProcessRunning(content.pid) ? content.pid : undefined,
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
