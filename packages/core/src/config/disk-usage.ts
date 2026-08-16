/**
 * `~/.sid-code/` 磁盘占用可观测性（2026-08-16）
 *
 * ## 治的是什么
 *
 * 实测配置目录 209MB，七个子目录**四套互不知晓的保留策略、零个总量视图**。
 * 没有任何命令能回答「我的 ~/.sid-code/ 为什么占了 N MB、哪块在涨」——
 * 上一轮是靠人工 `du -sh *` 一个个看出来的。
 *
 * 北极星四大方向里「可观测」写的是**会话级**指标（耗时、成本、决策），
 * **磁盘占用这一维完全在观测范围之外**。而它直接影响用户体验：看不见就只能
 * `rm -rf` 整个目录，那会连带删掉 `session-index.jsonl` —— 那个文件是设计上
 * **永不自动清理**的长期趋势底座（`paths.ts:138` 注释：它存在的唯一理由就是
 * "轨迹被 LRU 删掉后指标还在"）。**看不见导致的粗暴清理，比占用本身更伤。**
 *
 * ## 刻意只做可观测，不做自动删
 *
 * 上一轮方案 §P2-12 否决过"统一总量管理"（怕过度设计），本模块不与之冲突：
 * 这里**只读、只报告，一个字节都不删**。让人能看见，比让程序替人决定删什么更安全。
 * 真正的删除动作在各模块自己的策略里（见 `retentionOf()` 的登记表），
 * 以及 `startup-housekeeping.ts` 的启动期兜底。
 *
 * ## 为什么要连「保留策略」一起报，而不只报大小
 *
 * 只报大小会让人对着 `52M shell-snapshots` 无从判断：这是正常水位，还是某个
 * 清理坏了？把策略并排列出来，"零策略"和"有策略但超期未回收"就直接可见 ——
 * 上一轮 checkpoints 那个「代码全在、调用全 0」的缺陷，本来看一眼这张表就能发现。
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { getSidHome } from "./paths.ts";

/** 单个目录/文件的占用与策略信息 */
export interface DiskUsageEntry {
  /** 相对 ~/.sid-code/ 的名字，如 "shell-snapshots" */
  name: string;
  /** 字节数（目录为递归合计） */
  bytes: number;
  /** 条目数（目录内直接子项数；文件为 1） */
  count: number;
  /** 是否目录 */
  isDir: boolean;
  /** 人类可读的保留策略描述；null 表示未登记（= 没人管） */
  retention: string | null;
  /**
   * 超期未回收量（字节）。仅对"有明确 mtime 阈值"的目录给出；
   * undefined 表示该目录没有可机械判定的阈值（不是 0 —— 0 意味着"查过且没有"）。
   */
  staleBytes?: number;
  /** 超期未回收的条目数，与 staleBytes 同口径 */
  staleCount?: number;
}

/** 扫描结果 */
export interface DiskUsageReport {
  /** 配置根目录绝对路径 */
  root: string;
  /** 合计字节 */
  totalBytes: number;
  /** 按占用降序 */
  entries: DiskUsageEntry[];
  /** 扫描过程中无法读取的路径（权限等），如实报出而不静默吞掉 */
  unreadable: string[];
}

/**
 * 各子路径的保留策略登记表 + 可机械判定的过期阈值（天）。
 *
 * `days: null` 表示**没有基于时间的自动回收**（可能有别的策略，如 LRU 按条数，
 * 或压根没有策略）。这张表是"人读的说明"与"机器判超期"的唯一来源 ——
 * 分成两处写必然漂移。
 *
 * ⚠ 这里描述的是**当前事实**，不是应有状态。写"零保留策略"就是承认那块没人管；
 * 把它美化成"按需清理"会让这张表失去它唯一的价值。
 */
const RETENTION: Record<string, { text: string; days: number | null }> = {
  "shell-snapshots": {
    text: "退出钩子清理 + 启动期兜底回收 24h 孤儿",
    days: 1,
  },
  trajectories: { text: "LRU 保留最近 100 会话 + 30 天过期清理", days: 30 },
  checkpoints: { text: "30 天过期 + 200MB LRU（启动期兜底触发）", days: 30 },
  tasks: { text: "驱逐时删盘 + 启动期兜底回收 7 天孤儿", days: 7 },
  projects: { text: "无自动清理（用户记忆资产，刻意不删）", days: null },
  logs: { text: "按大小轮转，各保留 1 代", days: null },
  sessions: { text: "无自动清理", days: null },
  telemetry: { text: "无自动清理", days: null },
  "protocol-violations": { text: "LRU 保留最近 500 份（仅落盘时触发）", days: null },
  plans: { text: "无自动清理（用户资产）", days: null },
  "active-sessions": { text: "按 pid 存活自动清理 stale 注册", days: null },
  bin: { text: "随版本释放，不清理", days: null },
  "session-index.jsonl": {
    text: "刻意永不自动清理（长期趋势底座，删了指标就断）",
    days: null,
  },
  "usage-ledger.jsonl": { text: "刻意不轮转（成本/缓存命中率事实源）", days: null },
  "cache-breaks.jsonl": { text: "按大小轮转，保留 1 代", days: null },
};

/** 取某个名字的保留策略（未登记返回 null，调用方据此显示"未登记"） */
function retentionOf(name: string): { text: string; days: number | null } | null {
  return RETENTION[name] ?? null;
}

/**
 * 递归统计目录大小。
 *
 * 失败路径记进 `unreadable` 而**不是**静默当 0 —— 权限问题导致的"这个目录只有 0 字节"
 * 会让用户以为占用不在这里，正是这类报告最容易骗人的地方。
 */
function dirSize(dir: string, unreadable: string[]): { bytes: number; count: number } {
  let bytes = 0;
  let count = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    unreadable.push(dir);
    return { bytes: 0, count: 0 };
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    try {
      if (e.isDirectory()) {
        const sub = dirSize(full, unreadable);
        bytes += sub.bytes;
      } else {
        bytes += statSync(full).size;
      }
      count++;
    } catch {
      unreadable.push(full);
    }
  }
  return { bytes, count };
}

/**
 * 统计某目录下 mtime 超过 `days` 天的直接子项（不递归进子项内部计龄——
 * 会话目录的"年龄"看它自己的 mtime，与 checkpoints/trajectories 的清理判据一致）。
 */
function staleUnder(
  dir: string,
  days: number,
  now: number,
  unreadable: string[],
): { staleBytes: number; staleCount: number } {
  const maxAgeMs = days * 24 * 3600_000;
  let staleBytes = 0;
  let staleCount = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    unreadable.push(dir);
    return { staleBytes: 0, staleCount: 0 };
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    try {
      const st = statSync(full);
      if (now - st.mtimeMs <= maxAgeMs) continue;
      staleCount++;
      staleBytes += e.isDirectory() ? dirSize(full, unreadable).bytes : st.size;
    } catch {
      unreadable.push(full);
    }
  }
  return { staleBytes, staleCount };
}

/**
 * 扫描 `~/.sid-code/`，返回按占用降序的条目 + 各自保留策略 + 超期未回收量。
 *
 * **只读**：本函数不删除、不移动、不创建任何文件。
 *
 * @param now 当前时间戳，显式传入便于测试
 * @param minBytes 低于此值的条目并入返回结果但调用方可自行过滤（默认 0 = 全报）
 */
export function collectDiskUsage(now: number = Date.now(), minBytes = 0): DiskUsageReport {
  const root = getSidHome();
  const unreadable: string[] = [];
  const entries: DiskUsageEntry[] = [];

  if (!existsSync(root)) {
    return { root, totalBytes: 0, entries, unreadable };
  }

  let top;
  try {
    top = readdirSync(root, { withFileTypes: true });
  } catch {
    unreadable.push(root);
    return { root, totalBytes: 0, entries, unreadable };
  }

  for (const e of top) {
    const full = join(root, e.name);
    const ret = retentionOf(e.name);
    try {
      if (e.isDirectory()) {
        const { bytes, count } = dirSize(full, unreadable);
        const entry: DiskUsageEntry = {
          name: e.name,
          bytes,
          count,
          isDir: true,
          retention: ret?.text ?? null,
        };
        if (ret?.days != null) {
          const s = staleUnder(full, ret.days, now, unreadable);
          entry.staleBytes = s.staleBytes;
          entry.staleCount = s.staleCount;
        }
        entries.push(entry);
      } else {
        entries.push({
          name: e.name,
          bytes: statSync(full).size,
          count: 1,
          isDir: false,
          retention: ret?.text ?? null,
        });
      }
    } catch {
      unreadable.push(full);
    }
  }

  const totalBytes = entries.reduce((a, b) => a + b.bytes, 0);
  entries.sort((a, b) => b.bytes - a.bytes);
  return {
    root,
    totalBytes,
    entries: entries.filter((x) => x.bytes >= minBytes),
    unreadable,
  };
}

/**
 * 字节转人类可读（1024 进位，与 `du -h` 的单位写法一致）。
 *
 * ⚠ **单位写法一致，但数值口径不同，别当成 `du` 的替代品**：
 * 本模块统计的是 `stat().size`（**逻辑字节**），`du` 报的是**已分配块**。
 * 实测 `checkpoints/`：本模块 22.3MB、`du -sh` 34MB —— 差的 12MB 是 5461 个
 * 小目录/小文件的块粒度开销（每个文件至少占一个块）。
 *
 * 两个数都没错，问的是不同问题：「这些数据有多少内容」用逻辑字节，
 * 「腾出多少盘」用 du。这里选逻辑字节，因为本视图的用途是**看哪块在涨**、
 * 与保留策略对账，而块开销会随文件数而非数据量变化，反而模糊了信号。
 * 顺带一说，两者差距本身就是个信号：差得越多说明碎文件越多。
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["K", "M", "G", "T"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // <10 时保留一位小数，够看趋势又不啰嗦
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}
