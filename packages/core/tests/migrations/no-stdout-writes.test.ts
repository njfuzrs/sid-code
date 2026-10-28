/**
 * #7（2026-10-27）：迁移在 `-p --output-format json` 之前执行，任何写 stdout 的提示都会排在
 * JSON 前面，让严格 `JSON.parse(stdout)` 的调用方失败（bug2mr P2 首次运行实测）。
 * 迁移的用户提示一律走 stderr。静态扫描而非逐个跑迁移：新增迁移时最容易顺手写 console.log。
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = resolve(import.meta.dir, "../../src/migrations");

describe("迁移不写 stdout", () => {
  test("migrations/*.ts 不含 console.log / console.info / process.stdout.write", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(DIR).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(DIR, f), "utf-8");
      src.split("\n").forEach((line, i) => {
        if (/^\s*\/\//.test(line)) return;
        if (/console\.(log|info)\s*\(|process\.stdout\.write\s*\(/.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
