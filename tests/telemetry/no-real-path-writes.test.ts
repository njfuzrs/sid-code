/**
 * 遥测隔离防复发哨兵（C1）
 *
 * 背景：`recordCacheBreak()` 除了推内存环形缓冲，还会**同步落盘**到
 * ~/.sid-code/cache-breaks.jsonl（src/api/cache-detection.ts:428）。落盘是
 * fire-and-forget 且吞异常，所以调它的测试不做隔离时——测试全绿、断言全过、
 * 数据静静灌进用户真实文件。实测污染 6 万余行假数据（ts=1700000000 等测试字面量），
 * 把 `/cache --history` 冲成"尾部 20 条里一条真记录都看不到"。
 *
 * 靠"下一个人记得设环境变量"是靠不住的：机制存在（SID_CODE_CACHE_BREAKS 早在
 * cache-telemetry.ts:15 的文件头注释里写明"测试隔离用"），但三个写入方测试里
 * 只有一个用了。本哨兵把这条判据从"人记住"变成"门禁挡住"。
 *
 * 两道防线：
 *  1. 运行时契约：未设环境变量时 cacheBreaksPath() 落在配置根目录下（默认路径没被改坏），
 *     设了则严格采纳——即隔离机制本身有效。
 *  2. 静态扫描（核心）：扫 tests/ 下所有 import 了落盘类导出的文件，断言每个都声明了
 *     隔离（SID_CODE_CACHE_BREAKS 或 SID_CONFIG_DIR）。新增测试漏设 → 本测试失败并点名文件。
 *
 * 判据（源自 docs/bugfixes/todo/20260803-单测污染用户遥测数据-隔离缺口根治方案.md §2.4）：
 *   只要一个函数除返回值外还有「写用户家目录」这种进程外副作用，
 *   调它的测试就必须显式隔离。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cacheBreaksPath } from "../../src/telemetry/cache-telemetry.ts";
import { getSidHome } from "../../src/config/paths.ts";

/**
 * 会触发落盘的导出。import 了其中任意一个的测试文件都必须声明隔离。
 *
 * - recordCacheBreak：内存缓冲 + 落盘（cache-detection.ts:421-432）
 * - emitCacheBreakTelemetry：直接落盘（cache-telemetry.ts:50）
 *
 * 注：checkResponseForCacheBreak 刻意**不在**此列——它只做检测与归因，
 * 落盘由主循环（query/loop.ts:2453）另行调 recordCacheBreak 完成，
 * 实测调它不写盘。把它加进来会制造假阳性。
 */
const WRITING_EXPORTS = ["recordCacheBreak", "emitCacheBreakTelemetry"] as const;

/** 认可的隔离手段：专用重定向，或整体改写配置根目录 */
const ISOLATION_MARKERS = ["SID_CODE_CACHE_BREAKS", "SID_CONFIG_DIR"] as const;

describe("cacheBreaksPath 隔离契约", () => {
  const saved = process.env.SID_CODE_CACHE_BREAKS;
  afterEach(() => {
    if (saved === undefined) delete process.env.SID_CODE_CACHE_BREAKS;
    else process.env.SID_CODE_CACHE_BREAKS = saved;
  });

  test("未设环境变量时落在配置根目录下（默认路径未被改坏）", () => {
    delete process.env.SID_CODE_CACHE_BREAKS;
    const p = cacheBreaksPath();
    expect(p.startsWith(getSidHome())).toBe(true);
    expect(p.endsWith("cache-breaks.jsonl")).toBe(true);
  });

  test("设了环境变量则严格采纳（重定向真的生效）", () => {
    process.env.SID_CODE_CACHE_BREAKS = "/tmp/sentinel-probe/cache-breaks.jsonl";
    expect(cacheBreaksPath()).toBe("/tmp/sentinel-probe/cache-breaks.jsonl");
  });

  test("空串 / 纯空白视为未设置，回落默认路径（避免误重定向到空路径）", () => {
    process.env.SID_CODE_CACHE_BREAKS = "   ";
    expect(cacheBreaksPath().startsWith(getSidHome())).toBe(true);
  });
});

describe("防复发哨兵：扫描 tests/ 下所有落盘调用方", () => {
  /** 递归收集 tests/ 下所有 .test.ts（排除本哨兵自身——它 import 的是路径函数不是落盘函数） */
  function collectTestFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) collectTestFiles(full, acc);
      else if (entry.endsWith(".test.ts") && !full.endsWith("no-real-path-writes.test.ts")) {
        acc.push(full);
      }
    }
    return acc;
  }

  test("每个 import 了落盘类导出的测试文件都声明了隔离", () => {
    const testsRoot = join(import.meta.dir, "..");
    const files = collectTestFiles(testsRoot);
    // 断言扫描面非空——目录结构变动导致空扫时，这条门禁会静默变成"永远通过"
    expect(files.length).toBeGreaterThan(100);

    const violations: Array<{ file: string; usedExport: string }> = [];
    let scanned = 0;

    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      const used = WRITING_EXPORTS.find((name) => new RegExp(`\\b${name}\\b`).test(text));
      if (!used) continue;
      scanned++;
      const isolated = ISOLATION_MARKERS.some((marker) => text.includes(marker));
      if (!isolated) {
        violations.push({ file: file.replace(testsRoot, "tests"), usedExport: used });
      }
    }

    // 已知调用方至少 3 个（cache-detection / clear-resets-cache-state / cache-telemetry-rotation）。
    // 若正则或导出名漂移导致一个都匹配不上，这条会先失败，而不是让门禁空转成绿灯。
    expect(scanned).toBeGreaterThanOrEqual(3);

    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  - ${v.file}（用了 ${v.usedExport}，未设 ${ISOLATION_MARKERS.join(" / ")}）`)
        .join("\n");
      throw new Error(
        `以下测试会往用户真实的 ~/.sid-code/cache-breaks.jsonl 写数据：\n${detail}\n\n` +
          `修法：在 beforeAll 里把 SID_CODE_CACHE_BREAKS 指向 mkdtempSync 的临时目录，` +
          `afterAll 恢复原值（不要无条件 delete——bun test 同进程跑多文件）。\n` +
          `参考 tests/telemetry/cache-telemetry-rotation.test.ts:38。`,
      );
    }
  });
});
