/**
 * 命令使用频率追踪
 *
 * 算法：7 天半衰期的指数衰减
 * - 一周前的使用只值当前的 50%
 * - 最低衰减因子 0.1，防止高频命令完全消失
 * - 60 秒防抖，避免频繁写入配置文件
 *
 * 存储位置：~/.sid-code/command-usage.json
 * 格式：{ "compact": { "usageCount": 15, "lastUsedAt": 1711900000000 }, ... }
 *
 * 注意：读写均同步且容错（文件不存在/损坏时退化为"无记录"），不抛错，
 * 以免影响命令补全这条热路径。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sidPaths } from "../config/paths.ts";

const HALF_LIFE_DAYS = 7;
const MIN_DECAY_FACTOR = 0.1;
const DEBOUNCE_MS = 60_000;
const DAY_MS = 1000 * 60 * 60 * 24;

interface UsageRecord {
  usageCount: number;
  lastUsedAt: number; // timestamp(ms)
}

type UsageStore = Record<string, UsageRecord>;

// 内存缓存（读一次，写时更新），避免每次补全都读盘
let cache: UsageStore | null = null;
// 防抖：记录每个命令上次写盘时间
const lastWriteByCommand = new Map<string, number>();

function usageFilePath(): string {
  // 测试可通过环境变量重定向，避免污染真实 ~/.sid-code/
  const override = process.env.SID_CODE_USAGE_FILE;
  if (override) return override;
  return sidPaths.commandUsage();
}

function loadStore(): UsageStore {
  if (cache) return cache;
  try {
    const path = usageFilePath();
    if (!existsSync(path)) {
      cache = {};
      return cache;
    }
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    cache = {}; // 损坏文件退化为空
  }
  return cache!;
}

function saveStore(store: UsageStore): void {
  try {
    const path = usageFilePath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(store), "utf-8");
  } catch {
    // 写盘失败静默忽略（不影响补全）
  }
}

/**
 * 获取命令的使用分数（已衰减）
 * @param now 当前时间戳（可注入便于测试），默认 Date.now()
 */
export function getUsageScore(commandName: string, now: number = Date.now()): number {
  const store = loadStore();
  const record = store[commandName];
  if (!record) return 0;

  const daysSinceUse = (now - record.lastUsedAt) / DAY_MS;
  const recencyFactor = Math.pow(0.5, daysSinceUse / HALF_LIFE_DAYS);
  return record.usageCount * Math.max(recencyFactor, MIN_DECAY_FACTOR);
}

/**
 * 记录一次命令使用（60 秒防抖写盘）
 * @param now 当前时间戳（可注入便于测试），默认 Date.now()
 */
export function recordUsage(commandName: string, now: number = Date.now()): void {
  const store = loadStore();
  const record = store[commandName] ?? { usageCount: 0, lastUsedAt: 0 };
  record.usageCount += 1;
  record.lastUsedAt = now;
  store[commandName] = record;

  // 60 秒防抖：内存始终更新，写盘节流
  const lastWrite = lastWriteByCommand.get(commandName);
  if (lastWrite !== undefined && now - lastWrite < DEBOUNCE_MS) {
    return;
  }
  lastWriteByCommand.set(commandName, now);
  saveStore(store);
}

/** 清除内存缓存（测试用） */
export function _resetUsageCache(): void {
  cache = null;
  lastWriteByCommand.clear();
}
