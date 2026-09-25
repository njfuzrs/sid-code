/**
 * 进程树查询与「IDE 进程是否在跑」的检测。
 *
 * 两个能力回答的问题不同，所以分开实现：
 *   - {@link getAncestorPids}：我们是被谁启动的 —— 用于多个 IDE 窗口打开同一份
 *     工作区时，挑出「这个窗口才是启动我们的那个」。
 *   - {@link detectRunningIDEs}：机器上有哪些 IDE 进程在跑 —— 用于 lockfile 一个
 *     都没有时，告诉用户「IDE 开着但扩展没装」，而不是一句「未发现可用 IDE」。
 *
 * ⚠️ 两者都是**尽力而为**：查询失败（没有 ps、被权限拦、超时）一律返回空，
 * 调用方必须能在空结果下完全照旧工作。它们是消歧与提示的增强，
 * 不该有能力让 IDE 发现整体失败。
 *
 * ⚠️ 查询做成**可注入**（`run` 参数）：测试注入固定输出，生产走真实 `ps`。
 * 不注入就没法单测 —— 测试环境的真实进程树既不稳定也不可复现。
 */

import { execFile } from "child_process";
import { getLogger } from "../debug/logger.ts";

/** 祖先链最多向上走多少层。10 层覆盖 shell → IDE helper → IDE 本体，再往上是 init，没有信息量 */
const MAX_ANCESTOR_DEPTH = 10;

/** ps 查询超时。这是本地进程表查询，正常在几十毫秒内返回；3s 已是极宽上界 */
const PS_TIMEOUT_MS = 3_000;

/** 一行进程记录（ppid 用于祖先回溯，command 用于 IDE 关键词匹配） */
export interface ProcessRecord {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * 进程表查询的注入点。返回 `ps -ax -o pid=,ppid=,command=` 形态的文本，
 * 失败时抛异常（调用方统一按「查不到」处理）。
 */
export type ProcessTableRunner = () => Promise<string>;

/**
 * 可识别的 IDE 种类。
 *
 * 只列我们的扩展安装路径覆盖得到的三种（见 extension-install.ts 的 InstallableIDE）——
 * JetBrains 一族 CC 能识别，但 sid-code 既没有对应扩展也装不上，
 * 识别出来只能给出一条我们兑现不了的「去装扩展」提示，所以刻意不列。
 */
export type DetectableIDE = "vscode" | "cursor" | "windsurf";

/**
 * 进程命令行关键词，按 IDE 分。
 *
 * macOS 上 IDE 的真实进程名是 Helper（`Cursor Helper (Plugin)`），
 * 主进程命令行里才带 `.app`；两种形态都要覆盖，否则只能命中其中一半。
 * 用「包含」而不是「等于」匹配：进程参数会跟在名字后面。
 */
const IDE_PROCESS_KEYWORDS: Record<DetectableIDE, readonly string[]> = {
  cursor: ["Cursor Helper", "Cursor.app"],
  windsurf: ["Windsurf Helper", "Windsurf.app"],
  // vscode 的关键词是另外两个的子串（"Code" 出现在很多进程里），
  // 所以它的判定要排除 cursor / windsurf，见 detectRunningIDEs。
  vscode: ["Visual Studio Code", "Code Helper"],
};

/** 生产用的进程表查询：一次 `ps` 拿全表，祖先回溯与 IDE 匹配都在内存里做 */
export function runSystemProcessTable(): Promise<string> {
  return new Promise((resolve, reject) => {
    // -ax：包含别的 tty 的进程（IDE 本体不在我们这个 tty 上）。
    // pid=,ppid=,command=：BSD 风格 ps 的空表头输出，macOS 与 Linux 都认。
    execFile(
      "ps",
      ["-ax", "-o", "pid=,ppid=,command="],
      { timeout: PS_TIMEOUT_MS },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

/**
 * 解析 `ps -o pid=,ppid=,command=` 的输出。
 *
 * 单独导出是为了让解析逻辑有自己的用例：ps 的列之间是**不定数量的空格**，
 * command 本身也含空格，按空白切分会把命令行切碎。
 * 行格式是「前导空格 + pid + 空格 + ppid + 空格 + 剩余全部是 command」。
 */
export function parseProcessTable(stdout: string): ProcessRecord[] {
  const records: ProcessRecord[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    records.push({ pid, ppid, command: match[3] ?? "" });
  }
  return records;
}

/**
 * 从一张进程表里回溯 pid 的祖先链。
 *
 * 在 ppid 为 0 或 1（init）处停下：再往上没有信息量，而且 1 是所有进程的祖先，
 * 留着它会让「祖先链包含某个 PID」这个判断失去区分度。
 * 遇到环（PID 复用或 ps 输出异常）也停下，不无限转。
 */
export function ancestorPidsFrom(records: readonly ProcessRecord[], startPid: number): Set<number> {
  const ppidByPid = new Map<number, number>();
  for (const record of records) ppidByPid.set(record.pid, record.ppid);

  const ancestors = new Set<number>();
  let current = startPid;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    const parent = ppidByPid.get(current);
    if (parent === undefined || parent === 0 || parent === 1) break;
    if (ancestors.has(parent)) break;
    ancestors.add(parent);
    current = parent;
  }
  return ancestors;
}

/**
 * 祖先链查询的结果。
 *
 * `ok: false` 与「链是空的」必须分开：空链是一种正常结果（父进程就是 init，
 * 再往上没有信息量），而查询失败是「没有把握」。调用方对两者的处理相反 ——
 * 空链可以照用，失败必须放弃消歧。混成同一个空集，失败会被补上的父进程 PID
 * 伪装成一条「只有一环」的链，于是消歧把不在这条假链上的 IDE 全部滤掉。
 */
export type AncestorLookup = { ok: true; pids: Set<number> } | { ok: false };

/**
 * 我们进程的祖先 PID 集合（不含起点自己，不含 init）。
 *
 * 失败（没有 ps、超时、权限）返回 `{ ok: false }` 而不是空集，理由见 {@link AncestorLookup}。
 */
export async function getAncestorPids(
  startPid: number = process.ppid,
  run: ProcessTableRunner = runSystemProcessTable,
): Promise<AncestorLookup> {
  try {
    const stdout = await run();
    return { ok: true, pids: ancestorPidsFrom(parseProcessTable(stdout), startPid) };
  } catch (err) {
    getLogger().debug("IDE", `进程祖先查询失败，放弃消歧: ${(err as Error).message}`);
    return { ok: false };
  }
}

/**
 * 从一张进程表里识别正在运行的 IDE。
 *
 * vscode 的判定要排除 cursor 与 windsurf：它们的命令行里同样含 "Code"
 * （Cursor 基于 VS Code），不排除会把 Cursor 误报成 VS Code，
 * 于是提示用户去装一个装不上的扩展。
 */
export function runningIDEsFrom(records: readonly ProcessRecord[]): DetectableIDE[] {
  const commands = records.map((r) => r.command);
  const matches = (keywords: readonly string[]) =>
    commands.some((command) => keywords.some((keyword) => command.includes(keyword)));

  const found: DetectableIDE[] = [];
  if (matches(IDE_PROCESS_KEYWORDS.cursor)) found.push("cursor");
  if (matches(IDE_PROCESS_KEYWORDS.windsurf)) found.push("windsurf");
  if (
    matches(IDE_PROCESS_KEYWORDS.vscode) &&
    !found.includes("cursor") &&
    !found.includes("windsurf")
  ) {
    found.push("vscode");
  }
  return found;
}

/**
 * 机器上正在运行、且我们能给它装扩展的 IDE。
 *
 * 失败一律返回空数组（与 {@link getAncestorPids} 同一条理由）：
 * 这条检测只决定「未发现 lockfile」时的提示文案，查不到就退回原来的通用文案。
 */
export async function detectRunningIDEs(
  run: ProcessTableRunner = runSystemProcessTable,
): Promise<DetectableIDE[]> {
  try {
    const stdout = await run();
    return runningIDEsFrom(parseProcessTable(stdout));
  } catch (err) {
    getLogger().debug("IDE", `运行中 IDE 检测失败，退回通用提示: ${(err as Error).message}`);
    return [];
  }
}
