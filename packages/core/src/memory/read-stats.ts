/**
 * 记忆逐条读计数（记忆横向剖析 T1.1）—— 回答「哪条记忆从没被读过」。
 *
 * `memory_read` 事件按漏斗纪律不记路径（analytics/events.ts），只能说「读了几次」，
 * 说不出「读了哪条」。这里在**本地**补上逐条信号：不上报、不进遥测，只落在记忆目录自己旁边。
 *
 * ## 为什么是旁路文件，而不是方案原文的 frontmatter 回写
 *
 * 1. **会打断模型的「读后编辑」**：FileReadTracker 按 mtime + 内容判「读后被改」
 *    （tool/file-read-tracker.ts）。Read 一结束就改写文件，模型随后 edit 同一条记忆会被拒。
 *    `utimes` 保 mtime 也不可靠：mtimeMs 是亚毫秒浮点，回写后不保证逐位相等。
 * 2. **会被 store 抹掉**：`MemoryStore.set` 用 `serializeMemoryFile` 重写整个文件，
 *    只序列化 5 个已知字段 —— 一条记忆被更新一次，读计数就归零，报告会系统性低估。
 * 3. **会改 mtime 污染新鲜度**：scan / recall 的 `buildFreshnessWarning(header.mtimeMs)`
 *    按 mtime 算年龄，「最近读过」会被当成「最近改过」（方案 §四 已点出）。
 *
 * 旁路文件以 `.` 开头且不是 `.md`：`enumerateMemoryFiles` 只认 `.md`，团队同步走
 * `listTeamMemoryFiles` 也只认 `.md`，所以它不进索引、不进清单、不会被同步给协作者。
 *
 * ## 范围
 *
 * 只记 project / global 的**记忆条目**：MEMORY.md 索引本身不算（它每轮常驻，读它不说明
 * 任何一条被用到）；team 不记（共享目录，写它等于给协作者造噪声文件）；agent 线有自己的
 * agent-store，口径不同，暂不纳入。
 *
 * ## 并发
 *
 * 进程内用 promise 链串行（同一进程的并发 Read 不丢计数）。跨进程不加锁：两个会话同时读
 * 记忆时后写者覆盖，最多少记一次 —— 这是计数器，不是账本，丢一次的代价远低于引入文件锁。
 * 写入走临时文件 + rename，读侧永远看不到半截 JSON。
 */

import { join, relative, resolve, sep } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { getSidHome } from "../config/paths.ts";
import { getAutoMemPath } from "./paths.ts";

export const READ_STATS_FILE = ".read-stats.json";

export interface MemoryReadStat {
  /** 最近一次被成功 Read 的时刻（epoch ms） */
  lastRead: number;
  /** 累计被成功 Read 的次数（一次 Read 调用 = 1，与 memory_read 事件同口径） */
  readCount: number;
}

interface ReadStatsFile {
  version: 1;
  /** 键 = 相对记忆目录的路径（与索引链接同形，如 `feedback_x.md` / `sub/y.md`） */
  entries: Record<string, MemoryReadStat>;
}

/** 读某个记忆目录的读计数。文件缺失 / 损坏返回空表（不抛）。 */
export function readMemoryReadStats(memoryDir: string): Record<string, MemoryReadStat> {
  const p = join(memoryDir, READ_STATS_FILE);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as Partial<ReadStatsFile>;
    if (!parsed || typeof parsed !== "object" || !parsed.entries) return {};
    const out: Record<string, MemoryReadStat> = {};
    for (const [k, v] of Object.entries(parsed.entries)) {
      if (v && typeof v.lastRead === "number" && typeof v.readCount === "number") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

let chain: Promise<void> = Promise.resolve();

/**
 * 记录一次记忆被读。由 tool/read.ts 在成功路径、`classifyMemoryReadPath` 命中后调用。
 *
 * 返回的 promise 永不 reject（失败只吞掉）：埋点绝不能影响读取结果。
 */
export function recordMemoryRead(
  absolutePath: string,
  hit: { scope: string; isIndex: boolean },
  opts: { cwd?: string; now?: number } = {},
): Promise<void> {
  if (hit.isIndex) return Promise.resolve();
  let root: string;
  if (hit.scope === "project") root = getAutoMemPath(opts.cwd ?? process.cwd());
  else if (hit.scope === "global") root = join(getSidHome(), "memory");
  else return Promise.resolve();

  const target = resolve(absolutePath);
  const normRoot = resolve(root);
  if (!target.startsWith(normRoot + sep)) return Promise.resolve();
  const rel = relative(normRoot, target).split(sep).join("/");
  const now = opts.now ?? Date.now();

  const task = chain.then(async () => {
    const entries = readMemoryReadStats(normRoot);
    const prev = entries[rel];
    entries[rel] = { lastRead: now, readCount: (prev?.readCount ?? 0) + 1 };
    const body: ReadStatsFile = { version: 1, entries };
    await mkdir(normRoot, { recursive: true });
    const p = join(normRoot, READ_STATS_FILE);
    const tmp = `${p}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(body) + "\n", "utf-8");
    await rename(tmp, p);
  });
  // 链上任何一环失败都不能卡住后续计数
  chain = task.catch(() => {});
  return chain;
}
