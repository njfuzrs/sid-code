/**
 * D4 §5.3 —— 编译期模型目录快照的合并逻辑单测。
 *
 * `applyBuildTimeSnapshot` 整个函数体在 `bun test` 下永远短路（IS_DEV_MODE 恒为 true，
 * 见该函数头部注释），所以这里直接测被拆出来的纯合并逻辑 `__applySnapshotForTest`——
 * 它跳过 IS_DEV_MODE 与 require 嵌入文件两步，直接对内存态应用一份构造的快照，
 * 覆盖两条边界约束：
 *   1. 只填补缺失键，磁盘已有的模型不被快照覆盖；
 *   2. 时间戳判定：快照不比磁盘更新时整体跳过。
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  lookupCapability,
  __resetCapabilityCacheForTest,
  __applySnapshotForTest,
} from "@sid-code/core/llm/model-capabilities.ts";

beforeEach(() => {
  __resetCapabilityCacheForTest({});
});

describe("编译期快照合并 — 只填补磁盘缺失的键", () => {
  test("磁盘为空（diskSyncedAt=undefined）：快照全量填补", () => {
    __applySnapshotForTest(
      { generatedAt: 1000, models: { "snapshot-only-model": { contextWindow: 128_000 } } },
      undefined,
    );
    expect(lookupCapability("snapshot-only-model")?.contextWindow).toBe(128_000);
  });

  test("磁盘已有同名模型：快照不覆盖", () => {
    __resetCapabilityCacheForTest({ "shared-model": { contextWindow: 999_999 } });
    __applySnapshotForTest(
      { generatedAt: 1000, models: { "shared-model": { contextWindow: 1 } } },
      undefined,
    );
    // 磁盘数据原样保留，没被快照的 1 覆盖——磁盘永远更权威。
    expect(lookupCapability("shared-model")?.contextWindow).toBe(999_999);
  });

  test("快照补的模型与磁盘已有模型共存（互不影响）", () => {
    __resetCapabilityCacheForTest({ "disk-model": { contextWindow: 200_000 } });
    __applySnapshotForTest(
      { generatedAt: 1000, models: { "snapshot-model": { contextWindow: 300_000 } } },
      undefined,
    );
    expect(lookupCapability("disk-model")?.contextWindow).toBe(200_000);
    expect(lookupCapability("snapshot-model")?.contextWindow).toBe(300_000);
  });
});

describe("编译期快照合并 — 时间戳判定（不用旧快照覆盖新磁盘数据）", () => {
  test("快照比磁盘更新（generatedAt > diskSyncedAt）：应用快照", () => {
    __applySnapshotForTest(
      { generatedAt: 2000, models: { "fresher-model": { contextWindow: 400_000 } } },
      1000,
    );
    expect(lookupCapability("fresher-model")?.contextWindow).toBe(400_000);
  });

  test("快照与磁盘同龄或更旧（generatedAt <= diskSyncedAt）：整体跳过，不污染内存", () => {
    __applySnapshotForTest(
      { generatedAt: 1000, models: { "stale-model": { contextWindow: 500_000 } } },
      1000, // 相等 —— 边界情形，也必须跳过
    );
    expect(lookupCapability("stale-model")).toBeNull();

    __applySnapshotForTest(
      { generatedAt: 500, models: { "older-model": { contextWindow: 500_000 } } },
      1000, // 快照比磁盘旧
    );
    expect(lookupCapability("older-model")).toBeNull();
  });
});

describe("编译期快照合并 — 非法/空快照静默跳过", () => {
  test("null 快照（嵌入缺失/require 失败的等价形态）不抛错", () => {
    expect(() => __applySnapshotForTest(null, undefined)).not.toThrow();
  });

  test("快照里的非法数值字段被丢弃（不当成合法窗口），不影响其它合法条目", () => {
    __applySnapshotForTest(
      {
        generatedAt: 1000,
        models: {
          "garbage-model": { contextWindow: "not-a-number" },
          "valid-model": { contextWindow: 128_000 },
        },
      },
      undefined,
    );
    // sanitizeEntry 对「全字段都不合法」的定义里，本函数统一补写的 `source: "catalog"`
    // 本身算一个合法字段——所以 garbage-model 会留下一条只有 source 的空壳记录（与
    // mergeEntry 对生产 patch 的既有语义一致），但污染性字段 contextWindow 必须被拦住。
    expect(lookupCapability("garbage-model")?.contextWindow).toBeUndefined();
    expect(lookupCapability("valid-model")?.contextWindow).toBe(128_000);
  });
});
