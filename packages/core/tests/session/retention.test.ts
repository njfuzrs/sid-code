/**
 * 会话保留策略：默认值与体积兜底
 *
 * 钉住三件事：
 * 1. 默认值 —— 365 天、**不限数量**、10GB 体积上限。此前是 30 天 + maxCount 50
 *    （50 是把 Gemini CLI 文档的示例值当成了默认值），一天几十个会话的用户只留得住一两天。
 * 2. cleanupPeriodDays 是 maxAge 的别名 —— 会话与轨迹只剩一个保留期。
 * 3. maxTotalSize 体积兜底只删最旧的、且不越过保护（当前会话 / minRetention）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import {
  resolveRetentionSettings,
  parseRetentionSize,
  retentionMaxAgeMs,
  DEFAULT_SESSION_MAX_AGE,
} from "@sid-code/core/session/retention.ts";
import { identifySessionsToDelete, getRetentionSettings } from "@sid-code/core/session/cleanup.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("resolveRetentionSettings 默认值", () => {
  test("缺省：365 天、不限数量、10GB、最短 1 天", () => {
    const r = resolveRetentionSettings(undefined);
    expect(r.enabled).toBe(true);
    expect(r.maxAge).toBe("365d");
    expect(r.maxCount).toBeUndefined();
    expect(r.maxTotalSize).toBe("10GB");
    expect(r.minRetention).toBe("1d");
  });

  test("反向门禁：默认值不得回到 30d / 50", () => {
    const r = resolveRetentionSettings({});
    expect(r.maxAge).not.toBe("30d");
    expect(r.maxCount).not.toBe(50);
  });

  test("用户显式值原样生效", () => {
    const r = resolveRetentionSettings({
      enabled: false,
      maxAge: "90d",
      maxCount: 200,
      maxTotalSize: "2GB",
      minRetention: "2d",
    });
    expect(r).toEqual({
      enabled: false,
      maxAge: "90d",
      maxCount: 200,
      maxTotalSize: "2GB",
      minRetention: "2d",
    });
  });

  test("maxCount 非正数视为不限，绝不解读成「保留 0 个」", () => {
    expect(resolveRetentionSettings({ maxCount: 0 }).maxCount).toBeUndefined();
    expect(resolveRetentionSettings({ maxCount: -5 }).maxCount).toBeUndefined();
    expect(resolveRetentionSettings({ maxCount: Number.NaN }).maxCount).toBeUndefined();
  });

  test("cleanupPeriodDays 作为 maxAge 别名；两者都写时 maxAge 优先", () => {
    expect(resolveRetentionSettings(undefined, 90).maxAge).toBe("90d");
    expect(resolveRetentionSettings({ maxAge: "14d" }, 90).maxAge).toBe("14d");
    // 非法别名值忽略，回退默认
    expect(resolveRetentionSettings(undefined, 0).maxAge).toBe(DEFAULT_SESSION_MAX_AGE);
  });

  test("getRetentionSettings 读 Config 上的 sessionRetention 与 cleanupPeriodDays", () => {
    expect(getRetentionSettings({} as any).maxAge).toBe("365d");
    expect(getRetentionSettings({ cleanupPeriodDays: 60 } as any).maxAge).toBe("60d");
    expect(getRetentionSettings({ sessionRetention: { maxCount: 10 } } as any).maxCount).toBe(10);
  });

  test("retentionMaxAgeMs：格式写错回退默认，不变成「立刻全删」", () => {
    expect(retentionMaxAgeMs({ enabled: true, maxAge: "oops" })).toBe(365 * DAY_MS);
    expect(retentionMaxAgeMs({ enabled: true, maxAge: "7d" })).toBe(7 * DAY_MS);
  });
});

describe("parseRetentionSize", () => {
  test("各单位与小数", () => {
    expect(parseRetentionSize("10GB")).toBe(10 * 1024 ** 3);
    expect(parseRetentionSize("512mb")).toBe(512 * 1024 ** 2);
    expect(parseRetentionSize("1.5 GB")).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(parseRetentionSize("2TB")).toBe(2 * 1024 ** 4);
  });

  test("非法格式抛错", () => {
    expect(() => parseRetentionSize("10")).toThrow();
    expect(() => parseRetentionSize("ten GB")).toThrow();
  });
});

describe("identifySessionsToDelete：默认策略与体积兜底", () => {
  let testDir: string;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-retention-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, "sessions"), { recursive: true });
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = testDir;
  });

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  /** 造 n 个会话，第 i 个距今 ageDays(i) 天，最新在前 */
  function entries(n: number, ageDays: (i: number) => number) {
    const now = Date.now();
    return Array.from({ length: n }, (_, i) => {
      const t = new Date(now - ageDays(i) * DAY_MS).toISOString();
      return {
        fileName: `s${i}.jsonl`,
        dirPath: sidPaths.sessions(),
        sessionInfo: {
          id: `s${i}`,
          file: `s${i}`,
          fileName: `s${i}.jsonl`,
          startTime: t,
          lastUpdated: t,
          messageCount: 3,
          firstUserMessage: "",
          isCurrentSession: false,
          index: i,
        },
      } as any;
    });
  }

  test("一天产生 80 个会话、跨 2 天：默认策略一个都不删（旧默认会删 110 个）", async () => {
    // 160 个会话，前 80 个今天之内（< 1d），后 80 个 1.5 天前
    const all = entries(160, (i) => (i < 80 ? 0.01 : 1.5));
    const toDelete = await identifySessionsToDelete(all, resolveRetentionSettings(undefined));
    expect(toDelete.length).toBe(0);

    // 对照：旧默认（30d + maxCount 50）在同一批输入下删掉 1.5 天前的全部 80 个
    const legacy = await identifySessionsToDelete(all, {
      enabled: true,
      maxAge: "30d",
      maxCount: 50,
      minRetention: "1d",
    });
    expect(legacy.length).toBe(80);
  });

  test("默认策略：40 天前的会话保留，400 天前的删", async () => {
    const all = entries(3, (i) => [2, 40, 400][i]);
    const toDelete = await identifySessionsToDelete(all, resolveRetentionSettings(undefined));
    expect(toDelete.map((e: any) => e.sessionInfo.id)).toEqual(["s2"]);
  });

  test("maxTotalSize：超限时从最旧的开始删，删到不超为止", async () => {
    // 10 个会话各 100 字节，上限 0.5KB(=512B) → 留 5 个（500B），删最旧 5 个
    const all = entries(10, (i) => 2 + i);
    const toDelete = await identifySessionsToDelete(
      all,
      { enabled: true, maxAge: "365d", maxTotalSize: "0.5KB", minRetention: "1d" },
      undefined,
      undefined,
      { sizeOf: () => 100 },
    );
    expect(toDelete.map((e: any) => e.sessionInfo.id).sort()).toEqual(
      ["s5", "s6", "s7", "s8", "s9"].sort(),
    );
  });

  test("maxTotalSize：受保护会话计入总量但不被删（保护优先于配额）", async () => {
    // 全部 1 天内（受 minRetention 保护），体积远超上限 → 一个都不许删
    const all = entries(5, () => 0.01);
    const toDelete = await identifySessionsToDelete(
      all,
      { enabled: true, maxTotalSize: "1KB", minRetention: "1d" },
      "s4",
      undefined,
      { sizeOf: () => 10_000 },
    );
    expect(toDelete.length).toBe(0);
  });

  test("maxTotalSize 写错：跳过体积清理，绝不当成 0 字节全删", async () => {
    const all = entries(5, (i) => 2 + i);
    const toDelete = await identifySessionsToDelete(
      all,
      { enabled: true, maxAge: "365d", maxTotalSize: "lots", minRetention: "1d" },
      undefined,
      undefined,
      { sizeOf: () => 10_000 },
    );
    expect(toDelete.length).toBe(0);
  });

  test("不传 sizeOf 时不做体积判定（纯函数调用方行为不变）", async () => {
    const all = entries(5, (i) => 2 + i);
    const toDelete = await identifySessionsToDelete(all, {
      enabled: true,
      maxAge: "365d",
      maxTotalSize: "1KB",
      minRetention: "1d",
    });
    expect(toDelete.length).toBe(0);
  });
});
