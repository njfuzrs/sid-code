/**
 * `~/.sid-code/` 磁盘占用可观测性测试（2026-08-16）
 *
 * 治的缺陷：七个子目录、四套互不知晓的保留策略、**零个总量视图** ——
 * 没有任何命令能回答「我的 ~/.sid-code/ 为什么占了 N MB、哪块在涨」，
 * 上一轮只能靠人工 `du -sh *` 一个个看。
 *
 * ## 这组用例最要紧的两条断言
 *
 * 1. **只读** —— 本模块一个字节都不许删。它是"先做可观测、不做自动删"这个
 *    取舍的载体，一旦哪天有人往里加了删除逻辑，这条要立刻红。
 * 2. **未登记策略必须能被识别出来** —— `retention: null` 的含义是"这块没人管"，
 *    正是最该被看见的状态。若把未登记静默当成"有策略"，这个视图就失去了它
 *    唯一的价值（上一轮 checkpoints 那个「代码全在、调用全 0」的缺陷，
 *    本来看一眼这张表就能发现）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectDiskUsage, formatBytes } from "@sid-code/core/config/disk-usage.ts";

let tmpHome: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-disk-usage-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterEach(() => {
  // 存/恢复原值，不无条件 delete（同进程多文件跑，会抹掉 preload 兜底）
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 造一个含 n 个 size 字节文件的子目录 */
function seedDir(name: string, n: number, size: number, ageDays = 0): string {
  const dir = join(tmpHome, name);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const f = join(dir, `f${i}.bin`);
    writeFileSync(f, "x".repeat(size));
    if (ageDays > 0) {
      const t = new Date(Date.now() - ageDays * 24 * 3600_000);
      utimesSync(f, t, t);
    }
  }
  return dir;
}

describe("collectDiskUsage — 基本统计", () => {
  test("按占用降序，合计等于各项之和", () => {
    seedDir("trajectories", 5, 1000);
    seedDir("sessions", 2, 100);
    seedDir("logs", 1, 5000);

    const r = collectDiskUsage();

    expect(r.root).toBe(tmpHome);
    const names = r.entries.map((e) => e.name);
    expect(names).toContain("trajectories");
    // 降序：每一项都 >= 后一项
    for (let i = 1; i < r.entries.length; i++) {
      expect(r.entries[i - 1]!.bytes).toBeGreaterThanOrEqual(r.entries[i]!.bytes);
    }
    expect(r.totalBytes).toBe(r.entries.reduce((a, b) => a + b.bytes, 0));
    // logs 5000 > trajectories 5000？两者相等时不断言顺序，只断言数值
    expect(r.entries.find((e) => e.name === "sessions")!.bytes).toBe(200);
  });

  test("递归统计子目录（会话目录套 tool-outputs 是真实形态）", () => {
    const root = join(tmpHome, "trajectories", "sessions", "s1", "tool-outputs");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "a.txt"), "y".repeat(4096));

    const r = collectDiskUsage();
    expect(r.entries.find((e) => e.name === "trajectories")!.bytes).toBe(4096);
  });

  test("配置目录不存在时返回空报告而不抛", () => {
    rmSync(tmpHome, { recursive: true, force: true });
    const r = collectDiskUsage();
    expect(r.totalBytes).toBe(0);
    expect(r.entries).toEqual([]);
  });

  test("顶层文件（如 session-index.jsonl）也纳入统计", () => {
    writeFileSync(join(tmpHome, "session-index.jsonl"), "z".repeat(777));
    const r = collectDiskUsage();
    const e = r.entries.find((x) => x.name === "session-index.jsonl")!;
    expect(e.bytes).toBe(777);
    expect(e.isDir).toBe(false);
  });
});

describe("保留策略登记：未登记必须能被识别", () => {
  test("已登记目录带策略文案", () => {
    seedDir("shell-snapshots", 1, 10);
    const e = collectDiskUsage().entries.find((x) => x.name === "shell-snapshots")!;
    expect(e.retention).toBeTruthy();
    expect(e.retention).toContain("24h");
  });

  test("未登记目录 retention 为 null（= 这块没人管，必须能被渲染层标出来）", () => {
    seedDir("some-brand-new-dir", 1, 10);
    const e = collectDiskUsage().entries.find((x) => x.name === "some-brand-new-dir")!;
    expect(
      e.retention,
      "未登记的目录必须返回 null —— 静默当成'有策略'会让这个视图失去唯一价值",
    ).toBeNull();
  });

  test("长期趋势底座的策略文案点明「刻意不清理」而非「无策略」", () => {
    // session-index.jsonl 存在的唯一理由是"轨迹被 LRU 删掉后指标还在"（paths.ts:138）。
    // 它和"没人管"是两件完全不同的事，文案必须区分，否则下一个人会去"修"它。
    writeFileSync(join(tmpHome, "session-index.jsonl"), "{}");
    const e = collectDiskUsage().entries.find((x) => x.name === "session-index.jsonl")!;
    expect(e.retention).toContain("刻意");
  });
});

describe("超期未回收量", () => {
  test("有时间阈值的目录报 staleBytes/staleCount，未超期的不计入", () => {
    // shell-snapshots 阈值 1 天
    const dir = join(tmpHome, "shell-snapshots");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.sh"), "o".repeat(1000));
    writeFileSync(join(dir, "new.sh"), "n".repeat(1000));
    const t = new Date(Date.now() - 5 * 24 * 3600_000);
    utimesSync(join(dir, "old.sh"), t, t);

    const e = collectDiskUsage().entries.find((x) => x.name === "shell-snapshots")!;
    expect(e.staleCount).toBe(1);
    expect(e.staleBytes).toBe(1000);
  });

  test("无时间阈值的目录 staleBytes 为 undefined 而不是 0", () => {
    // 0 的含义是"查过且没有超期"，undefined 是"没有可机械判定的阈值"。
    // 混成 0 会让渲染层报出一个"很健康"的假象。
    seedDir("sessions", 1, 10, 400);
    const e = collectDiskUsage().entries.find((x) => x.name === "sessions")!;
    expect(e.staleBytes).toBeUndefined();
  });

  test("超期为零时报 0（区别于 undefined）", () => {
    seedDir("shell-snapshots", 2, 10, 0);
    const e = collectDiskUsage().entries.find((x) => x.name === "shell-snapshots")!;
    expect(e.staleCount).toBe(0);
    expect(e.staleBytes).toBe(0);
  });
});

describe("只读契约（本模块的核心取舍）", () => {
  test("扫描不删除、不新建、不改动任何文件", () => {
    seedDir("shell-snapshots", 3, 100, 90); // 全部超期
    seedDir("checkpoints", 2, 100, 90); // 全部超期
    writeFileSync(join(tmpHome, "settings.json"), "{}");

    const before = readdirSync(tmpHome).sort();
    const snapsBefore = readdirSync(join(tmpHome, "shell-snapshots")).sort();

    collectDiskUsage();

    // 即便一眼看去"全都该删"，本模块也一个都不许动 ——
    // "先做可观测、不做自动删"这个取舍就靠这条守住。
    expect(readdirSync(tmpHome).sort()).toEqual(before);
    expect(readdirSync(join(tmpHome, "shell-snapshots")).sort()).toEqual(snapsBefore);
  });
});

describe("formatBytes", () => {
  test("按 1024 进位，<10 保留一位小数", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(1024)).toBe("1.0K");
    expect(formatBytes(1536)).toBe("1.5K");
    expect(formatBytes(20 * 1024)).toBe("20K");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0M");
    expect(formatBytes(52 * 1024 * 1024)).toBe("52M");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0G");
  });

  test("0 与极小值不炸", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(1)).toBe("1B");
  });
});
