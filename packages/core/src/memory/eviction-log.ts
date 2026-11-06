/**
 * 满额淘汰账本（PR-A / D2）—— 回答「这条记忆是被哪次写入挤走的」。
 *
 * ## 为什么需要账本
 *
 * `store.set()` 在超过 `STORE_MAX_ENTRIES` 时会把旧记忆 `rename` 进 `archive/`（P0-2）。
 * 归档只是「不删数据」，系统并不会主动把被挤走的记忆放回来 —— 对用户来说，
 * 写一条临时记忆、再把它删掉，那条旧记忆**仍然回不到索引**，效果等同于丢失。
 *
 * 2026-11-06 的真实事故：满额状态下连写 5 条测试暗号 → 5 条真实记忆被挤进 archive →
 * 删掉暗号后 4 个空位空着，被挤走的记忆没有回来。当时的代码**根本不知道**
 * 「这条记忆当初挤走过谁」，所以撤销无从谈起。
 *
 * 账本把因果关系落盘：每淘汰一条就追加一行 `{ evictedKey, archivedAs, evictedBy, at }`。
 * `delete(evictedBy)` 成功后按它回填 —— 只撤销「这次删除造成的淘汰」，
 * 语义精确（不做「删任意一条就恢复最近被淘汰的一条」那种用户无法预期的行为）。
 *
 * ## 为什么只追加、不改已有行
 *
 * 账本是 append-only 的因果日志：一行代表一次真实发生过的淘汰。回填后不回写、
 * 不删行 —— 回填判据里的「归档文件还在吗」会让失效记录自然失效。
 * 改写历史行需要读整份 JSONL、定位、重写，在多进程并发写记忆时会丢行；
 * 而追加一行的成本与风险都低得多。
 *
 * ## 格式与容错
 *
 * 一行一个 JSON 对象，`JSONL` 容忍部分损坏：解析失败的行直接跳过，
 * 不影响其它行。`.jsonl` 不是 `.md`，`enumerateMemoryFiles` 不会把它当记忆条目，
 * 也不会进索引 —— 与 `.read-stats.json` 同一种旁路文件。
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 账本文件名（记忆目录内，与 `MEMORY.md` / `.read-stats.json` 并列） */
export const EVICTIONS_FILE = ".evictions.jsonl";

/** 一次满额淘汰的因果记录。字段名与方案文档 A4 一致，不另起别名。 */
export interface EvictionRecord {
  /** 被挤走的那条记忆的 key */
  evictedKey: string;
  /** 它在 `archive/` 里的文件名（可能带 `-N` 后缀） */
  archivedAs: string;
  /** 造成这次淘汰的新写入 key —— 删除它时按这个字段回填 */
  evictedBy: string;
  /** 淘汰发生时刻（epoch ms） */
  at: number;
}

/**
 * 追加一条淘汰记录。失败只吞掉（返回 false）：账本写不进去，
 * 不能让功能路径上的记忆写入跟着失败。
 */
export function appendEvictionRecord(memoryDir: string, rec: EvictionRecord): boolean {
  try {
    if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
    appendFileSync(join(memoryDir, EVICTIONS_FILE), `${JSON.stringify(rec)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 读账本。文件缺失 / 整份读不动返回空数组；单行损坏只跳过该行。
 *
 * 同步读：账本只随淘汰增长，正常使用下是几十行的小文件，
 * 与 `readMemoryReadStats` 同口径（`delete` 路径上不值得为一次小读引入异步）。
 */
export function readEvictionRecords(memoryDir: string): EvictionRecord[] {
  const p = join(memoryDir, EVICTIONS_FILE);
  if (!existsSync(p)) return [];
  let text: string;
  try {
    text = readFileSync(p, "utf-8");
  } catch {
    return [];
  }
  const out: EvictionRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<EvictionRecord>;
      if (
        parsed &&
        typeof parsed.evictedKey === "string" &&
        typeof parsed.archivedAs === "string" &&
        typeof parsed.evictedBy === "string" &&
        typeof parsed.at === "number"
      ) {
        out.push({
          evictedKey: parsed.evictedKey,
          archivedAs: parsed.archivedAs,
          evictedBy: parsed.evictedBy,
          at: parsed.at,
        });
      }
    } catch {
      /* 单行损坏跳过：账本是尽力而为的因果线索，不是事实源 */
    }
  }
  return out;
}
