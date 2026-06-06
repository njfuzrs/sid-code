#!/usr/bin/env bun
/**
 * UI 测试独立统计 — D4-4
 *
 * 系统级查漏补缺方案 §防线4 D4-4：确保 UI 测试在 sprint 末回归矩阵里有**独立统计**，
 * 而非淹没在 `bun test` 全量数字里。本脚本只跑 UI 测试（tests/ui + src/ui），解析
 * bun test 输出，打印结构化统计（文件数 / 用例数 / pass / fail），并以 JSON 摘要收尾，
 * 便于回归矩阵脚本采集。
 *
 * 用法：
 *   bun run scripts/ui-test-stats.ts          # 人类可读 + JSON 摘要
 *   bun run scripts/ui-test-stats.ts --json    # 只输出 JSON（供 CI 采集）
 *
 * 退出码：UI 测试有 fail → 1；全过 → 0。
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const JSON_ONLY = process.argv.includes("--json");

// UI 测试分布在两处：tests/ui（多数）+ src/ui（就近放置的 .test.ts/.tsx）
const UI_TEST_PATHS = ["tests/ui", "src/ui"];

function runUITests(): { stdout: string; stderr: string; code: number } {
  const res = spawnSync("bun", ["test", ...UI_TEST_PATHS], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, NODE_ENV: "test" },
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    code: res.status ?? 1,
  };
}

/** 从 bun test 输出解析统计（bun 把汇总写在 stderr） */
function parseStats(output: string): {
  pass: number;
  fail: number;
  files: number;
  tests: number;
} {
  // 形如：" 27 pass" / " 0 fail" / "Ran 27 tests across 1 file."
  const pass = Number(/(\d+)\s+pass/.exec(output)?.[1] ?? 0);
  const fail = Number(/(\d+)\s+fail/.exec(output)?.[1] ?? 0);
  const ran = /Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?/.exec(output);
  const tests = Number(ran?.[1] ?? pass + fail);
  const files = Number(ran?.[2] ?? 0);
  return { pass, fail, files, tests };
}

function main(): void {
  const { stdout, stderr, code } = runUITests();
  const combined = stdout + "\n" + stderr;
  const stats = parseStats(combined);

  const summary = {
    kind: "ui-test-stats",
    paths: UI_TEST_PATHS,
    files: stats.files,
    tests: stats.tests,
    pass: stats.pass,
    fail: stats.fail,
    passed: stats.fail === 0,
  };

  if (JSON_ONLY) {
    console.log(JSON.stringify(summary));
    process.exit(code === 0 && stats.fail === 0 ? 0 : 1);
  }

  console.log("─── UI 测试独立统计（D4-4）───");
  console.log(`  测试路径: ${UI_TEST_PATHS.join(", ")}`);
  console.log(`  测试文件: ${stats.files}`);
  console.log(`  用例总数: ${stats.tests}`);
  console.log(`  通过: ${stats.pass} | 失败: ${stats.fail}`);
  console.log(`  结果: ${stats.fail === 0 ? "✅ 全过" : "❌ 有失败"}`);
  console.log("\nJSON 摘要（供回归矩阵采集）:");
  console.log(JSON.stringify(summary));

  process.exit(code === 0 && stats.fail === 0 ? 0 : 1);
}

main();
