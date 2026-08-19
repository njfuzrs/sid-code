/**
 * persist() 的并发写合并语义（方案 D7 / PR11）。
 *
 * 被测的不变量只有一条：**原子写防的是「半截文件」，不防「丢更新」**。
 * 两个 sid-code 进程并存时（开两个终端、`sc-dev` 与 `sc` 并存、子代理并发），
 * 后写的那个曾把前一个刚采到的条目整份覆盖掉——而两边轨迹都显示采集成功，
 * 于是「明明采到了却没生效」成了查不出来的问题。
 *
 * ⚠ 落盘隔离（这个文件天生就在测写文件，风险最高）：
 * 每个用例把 `SID_CONFIG_DIR` 指到 mkdtemp 出来的临时目录，afterEach **存/恢复原值**
 * 而不是无条件 delete —— `bun test` 同批多文件跑在同一进程里，直接删会把
 * `bunfig.toml` preload 的兜底一起抹掉。期望路径一律走 `sidPaths.modelCapabilities()`
 * 派生，不硬编码 `join(homedir(), ".sid-code", ...)`。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import {
  __resetCapabilityCacheForTest,
  __enablePersistForTest,
  __persistForTest,
  // ⚠ 从源码取版本号，不要硬编码字面量：schema bump 一次，硬编码 fixture 会被
  // readCacheFile 当成过期版本整份丢弃，这一批与版本无关的用例就会集体报红。
  __SCHEMA_VERSION_FOR_TEST as SCHEMA_VERSION,
  type ModelCapabilityEntry,
} from "@sid-code/core/llm/model-capabilities.ts";

let tmpDir: string;
let prevConfigDir: string | undefined;

/** 模拟「另一个进程」的落盘结果：直接写一份缓存文件到隔离目录。 */
function writeDiskFile(file: unknown): void {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(sidPaths.modelCapabilities(), JSON.stringify(file, null, 2), "utf8");
}

function readDiskFile(): {
  schema_version: number;
  models: Record<string, ModelCapabilityEntry>;
  catalog_synced_at?: number;
  catalog_fail_count?: number;
} {
  return JSON.parse(readFileSync(sidPaths.modelCapabilities(), "utf8"));
}

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "model-cap-concurrent-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  __resetCapabilityCacheForTest({});
});

afterEach(() => {
  // ⚠ 存/恢复原值，不无条件 delete（见文件头注释）。
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  // 重新置位 persistDisabled，避免本文件的开关泄漏到同批其它测试文件。
  __resetCapabilityCacheForTest({});
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("persist() — 写盘前重读磁盘并合并（防并发进程丢更新）", () => {
  test("核心断言：磁盘上的条目 A 与内存态的条目 B 写盘后都在", () => {
    // 「另一个进程」刚采到 A 并落盘。
    writeDiskFile({
      schema_version: SCHEMA_VERSION,
      models: { "model-a": { contextWindow: 128_000, source: "catalog", fetchedAt: 1_000 } },
      catalog_synced_at: 1_000,
      catalog_fail_count: 0,
    });

    // 本进程内存态里只有 B（它在 A 落盘之前就载入了缓存，对 A 一无所知）。
    __resetCapabilityCacheForTest({
      "model-b": { contextWindow: 256_000, source: "probe", fetchedAt: 2_000 },
    });
    __enablePersistForTest({ syncedAt: 2_000, failCount: 0 });
    __persistForTest();

    const disk = readDiskFile();
    expect(Object.keys(disk.models).sort()).toEqual(["model-a", "model-b"]);
    expect(disk.models["model-a"]!.contextWindow).toBe(128_000);
    expect(disk.models["model-b"]!.contextWindow).toBe(256_000);
  });

  test("修复前的行为会丢更新：整份覆盖时磁盘上的 A 会消失（反向自证）", () => {
    // 这个用例锁的是「差异存在」——直接模拟旧实现（整份覆盖）在同样输入下的结果，
    // 证明上一个用例的断言不是恒真的：没有合并，A 一定丢。
    writeDiskFile({
      schema_version: SCHEMA_VERSION,
      models: { "model-a": { contextWindow: 128_000 } },
    });
    const overwritten = {
      schema_version: SCHEMA_VERSION,
      models: { "model-b": { contextWindow: 256_000 } },
    };
    writeFileSync(sidPaths.modelCapabilities(), JSON.stringify(overwritten), "utf8");
    expect(Object.keys(readDiskFile().models)).toEqual(["model-b"]);
  });

  test("同一个键：内存态覆盖磁盘（内存态不可能比磁盘旧）", () => {
    writeDiskFile({
      schema_version: SCHEMA_VERSION,
      models: { "model-x": { contextWindow: 100_000, source: "catalog", fetchedAt: 1_000 } },
    });
    __resetCapabilityCacheForTest({
      "model-x": { contextWindow: 200_000, source: "healed", fetchedAt: 9_000 },
    });
    __enablePersistForTest({ syncedAt: 9_000 });
    __persistForTest();

    const entry = readDiskFile().models["model-x"]!;
    expect(entry.contextWindow).toBe(200_000);
    expect(entry.source).toBe("healed");
  });

  test("同一个键：磁盘独有的字段被保留（逐字段合并，不整条替换）", () => {
    // 别的进程用探针学到了 effortValues，本进程只采到窗口 —— 两边的信息都该留下。
    writeDiskFile({
      schema_version: SCHEMA_VERSION,
      models: {
        "model-y": { effortValues: ["low", "high"], supportsReasoning: true, fetchedAt: 1_000 },
      },
    });
    __resetCapabilityCacheForTest({ "model-y": { contextWindow: 64_000, fetchedAt: 5_000 } });
    __enablePersistForTest({ syncedAt: 5_000 });
    __persistForTest();

    const entry = readDiskFile().models["model-y"]!;
    expect(entry.contextWindow).toBe(64_000);
    expect(entry.effortValues).toEqual(["low", "high"]);
    expect(entry.supportsReasoning).toBe(true);
  });

  test("内存态里的显式 undefined 不得击穿磁盘上的真实值", () => {
    // `{...disk, ...mem}` 式展开会让一个显式 undefined 覆盖掉磁盘真值，
    // 把「未知」错记成「已知为空」。
    writeDiskFile({
      schema_version: SCHEMA_VERSION,
      models: { "model-z": { contextWindow: 32_000, maxOutputTokens: 8_192 } },
    });
    __resetCapabilityCacheForTest({
      "model-z": { contextWindow: undefined, maxOutputTokens: 16_384 },
    });
    __enablePersistForTest({ syncedAt: 1 });
    __persistForTest();

    const entry = readDiskFile().models["model-z"]!;
    expect(entry.contextWindow).toBe(32_000); // 磁盘真值保住
    expect(entry.maxOutputTokens).toBe(16_384); // 内存态的真值生效
  });

  test("磁盘上的毒数据不被合并回写（Infinity 等仍走 sanitizeEntry）", () => {
    // JSON 里的 1e400 解析后是 Infinity：typeof === "number" 且 > 0，
    // 放过它会让上下文预算永远「还有空间」，auto-compact 彻底失效。
    // ⚠ 这里必须走裸字符串写盘（不能 JSON.stringify 一个对象）：`1e400` 只有在 JSON 文本里
    // 才能表达出「解析后是 Infinity」这个形态，stringify(Infinity) 会得到 `null`。
    writeFileSync(
      sidPaths.modelCapabilities(),
      `{"schema_version":${SCHEMA_VERSION},"models":{"poison":{"contextWindow":1e400},"ok":{"contextWindow":8000}}}`,
      "utf8",
    );
    __resetCapabilityCacheForTest({ mine: { contextWindow: 4_000 } });
    __enablePersistForTest({ syncedAt: 1 });
    __persistForTest();

    const disk = readDiskFile();
    expect(Object.keys(disk.models).sort()).toEqual(["mine", "ok"]);
    expect(disk.models["poison"]).toBeUndefined();
  });

  test("磁盘 JSON 损坏 / schema 版本不匹配 → 退化成整份覆盖，不抛异常", () => {
    writeFileSync(sidPaths.modelCapabilities(), "{ 半截 JSON", "utf8");
    __resetCapabilityCacheForTest({ "model-b": { contextWindow: 256_000 } });
    __enablePersistForTest({ syncedAt: 3_000 });
    expect(() => __persistForTest()).not.toThrow();
    expect(Object.keys(readDiskFile().models)).toEqual(["model-b"]);

    // schema 版本不匹配同理（readCacheFile 返回 null）。
    writeDiskFile({ schema_version: 999, models: { "old-schema": { contextWindow: 1 } } });
    __persistForTest();
    expect(Object.keys(readDiskFile().models)).toEqual(["model-b"]);
  });

  describe("元数据字段（catalog_synced_at / catalog_fail_count）整对取更新的那一份", () => {
    test("磁盘更新 → 整对取磁盘（不与内存态的 failCount 拼接）", () => {
      writeDiskFile({
        schema_version: SCHEMA_VERSION,
        models: {},
        catalog_synced_at: 9_000,
        catalog_fail_count: 0, // 别的进程刚同步成功
      });
      __resetCapabilityCacheForTest({});
      __enablePersistForTest({ syncedAt: 1_000, failCount: 3 }); // 本进程是旧的失败态
      __persistForTest();

      const disk = readDiskFile();
      expect(disk.catalog_synced_at).toBe(9_000);
      expect(disk.catalog_fail_count).toBe(0);
    });

    test("内存态更新 → 整对取内存态", () => {
      writeDiskFile({
        schema_version: SCHEMA_VERSION,
        models: {},
        catalog_synced_at: 1_000,
        catalog_fail_count: 0,
      });
      __resetCapabilityCacheForTest({});
      __enablePersistForTest({ syncedAt: 9_000, failCount: 2 });
      __persistForTest();

      const disk = readDiskFile();
      expect(disk.catalog_synced_at).toBe(9_000);
      expect(disk.catalog_fail_count).toBe(2);
    });

    test("绝不拼出「从未发生过的同步事件」：不会出现 syncedAt 取一边、failCount 取另一边", () => {
      // 反例：若各自取 max/min，会得到 syncedAt=9000（内存的失败时刻）+ failCount=0
      //（磁盘的成功计数）=「9000 时刻同步成功」——退避被取消、TTL 从 9000 重新起算，
      // 最坏把采集抑制整整一天。
      writeDiskFile({
        schema_version: SCHEMA_VERSION,
        models: {},
        catalog_synced_at: 1_000,
        catalog_fail_count: 0,
      });
      __resetCapabilityCacheForTest({});
      __enablePersistForTest({ syncedAt: 9_000, failCount: 4 });
      __persistForTest();

      const disk = readDiskFile();
      // 内存态更新 → 整对来自内存态，failCount 必须是 4，不能是磁盘的 0。
      expect([disk.catalog_synced_at, disk.catalog_fail_count]).toEqual([9_000, 4]);
    });

    test("磁盘无 catalog_synced_at → 用内存态（缺值不算更新）", () => {
      writeDiskFile({ schema_version: SCHEMA_VERSION, models: { a: { contextWindow: 1_000 } } });
      __resetCapabilityCacheForTest({});
      __enablePersistForTest({ syncedAt: 5_000, failCount: 1 });
      __persistForTest();

      const disk = readDiskFile();
      expect(disk.catalog_synced_at).toBe(5_000);
      expect(disk.catalog_fail_count).toBe(1);
    });

    test("时间戳平局 → 用内存态（本进程的判断至少不比磁盘旧）", () => {
      writeDiskFile({
        schema_version: SCHEMA_VERSION,
        models: {},
        catalog_synced_at: 7_000,
        catalog_fail_count: 0,
      });
      __resetCapabilityCacheForTest();
      __enablePersistForTest({ syncedAt: 7_000, failCount: 5 });
      __persistForTest();
      expect(readDiskFile().catalog_fail_count).toBe(5);
    });
  });

  test("原子写行为没被破坏：仍是 tmp → rename，落地后不留 .tmp", () => {
    __resetCapabilityCacheForTest({ m: { contextWindow: 1_000 } });
    __enablePersistForTest({ syncedAt: 1 });
    __persistForTest();

    const path = sidPaths.modelCapabilities();
    expect(existsSync(path)).toBe(true);
    // rename 成功后临时文件不该残留；同时目录里不该有任何别的 .tmp 尾巴。
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("persistDisabled 为真时一个字节都不写", () => {
    // __resetCapabilityCacheForTest 会置位 persistDisabled，这里刻意不调
    // __enablePersistForTest —— 模拟普通单测路径。
    __resetCapabilityCacheForTest({ m: { contextWindow: 1_000 } });
    __persistForTest();
    expect(existsSync(sidPaths.modelCapabilities())).toBe(false);
    expect(readdirSync(tmpDir)).toEqual([]);
  });
});
