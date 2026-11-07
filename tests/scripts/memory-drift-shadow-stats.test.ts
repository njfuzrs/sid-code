/**
 * memory-drift-shadow-stats 的影子统计口径测试（2026-11-07）
 *
 * ## 为什么这三个函数值得单测
 *
 * 脚本本身是一次性统计工具，但它的**口径**会被写进方案文档，成为 T2/T3 的参数依据：
 *
 * 1. `extractRepoPaths` —— T3 的分子。多认一条 URL 或少认一条 `src/x.ts`，
 *    「失效比例」就会整体平移，而脚本跑完看不出差异（它只打印总数）。
 * 2. `bucketizeAges` —— T2 的分子分母。分母为 0 时必须给 0 而不是 NaN：
 *    `NaN` 在比较里恒 false，会让「↑7 天覆盖率」这类阈值判断静默失效。
 * 3. `projectKeyFor` —— 目录名派生。自己写一份 sanitize 在中文路径下会算出
 *    另一个目录名，表现为「这个项目一条记忆都没有」而不是报错。这里断言它与内核
 *    同口径，防止有人把内核调用改回手写实现。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectRoot, sanitizeProjectKey } from "@sid-code/core/memory/paths.ts";
import {
  bucketizeAges,
  extractRepoPaths,
  projectKeyFor,
} from "../../scripts/memory-drift-shadow-stats.ts";

describe("extractRepoPaths — 仓内相对路径提取", () => {
  test("认带 / 与扩展名的路径，剥掉行号", () => {
    const body =
      "结论成立，但 `src/api/ontology.ts:556` 已经挪到别处；另见 packages/core/src/a/b.ts:12-18。";
    expect(extractRepoPaths(body)).toEqual(["packages/core/src/a/b.ts", "src/api/ontology.ts"]);
  });

  test("排除 URL、绝对路径、家目录路径与 node_modules", () => {
    const body = [
      "见 https://github.com/foo/bar.ts 和 /Users/someone/code/x/y.ts",
      "还有 ~/.sid-code/projects/a/b.md",
      "以及 node_modules/pkg/dist/index.js",
    ].join("\n");
    expect(extractRepoPaths(body)).toEqual([]);
  });

  test("裸文件名与无扩展名路径不算（没有 / 或扩展名就无法定位）", () => {
    expect(extractRepoPaths("改 store.ts 里的 load()，看 src/query 目录")).toEqual([]);
  });

  test("去重后排序，同一路径出现多次只算一条", () => {
    const body = "src/a.ts 与 src/a.ts 还有 src/b.ts";
    expect(extractRepoPaths(body)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("bucketizeAges — 年龄覆盖率分档", () => {
  test("按阈值分组统计，ratio 是 aged/total", () => {
    // 年龄：今天、5 天、40 天 → ≥1天 2/3、≥7天 1/3、≥30天 1/3
    const buckets = bucketizeAges([0, 5, 40], [1, 7, 30]);
    expect(buckets.map((b) => [b.threshold, b.aged, b.total])).toEqual([
      [1, 2, 3],
      [7, 1, 3],
      [30, 1, 3],
    ]);
    expect(buckets[0].ratio).toBeCloseTo(2 / 3, 6);
  });

  test("空样本给 0 而不是 NaN（NaN 会让阈值判断静默失效）", () => {
    const buckets = bucketizeAges([], [7]);
    expect(buckets[0]).toEqual({ threshold: 7, aged: 0, total: 0, ratio: 0 });
    expect(Number.isNaN(buckets[0].ratio)).toBe(false);
  });
});

describe("projectKeyFor — 与内核 sanitizeProjectKey 同口径", () => {
  test("普通 ASCII 路径：派生结果一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "shadow-stats-ascii-"));
    try {
      expect(projectKeyFor(dir)).toBe(sanitizeProjectKey(resolveProjectRoot(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("含非 ASCII 字符的路径：带 6 位哈希后缀（手写 sanitize 会漏掉它）", () => {
    const dir = mkdtempSync(join(tmpdir(), "shadow-stats-中文-"));
    try {
      expect(projectKeyFor(dir)).toBe(sanitizeProjectKey(resolveProjectRoot(dir)));
      expect(projectKeyFor(dir)).toMatch(/-[0-9a-f]{6}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
