#!/usr/bin/env bun
/**
 * 修复「被误改成包名的**文件系统路径**」（P2-2 步骤4 的收尾）—— 一次性脚本
 *
 * ## 问题
 *
 * `pkg-migrate.ts` 把 `"../../src/llm/anthropic.ts"` 一律改成 `"@sid-code/core/llm/anthropic.ts"`。
 * 对 `import` / `require` 是对的（包名由 node_modules 软链解析），
 * 但仓库里有一类用法是**把同样形状的字符串当文件系统路径用**：
 *
 *   join(import.meta.dir, "../../src/llm/anthropic.ts")      // 读源码做静态审计
 *   new URL("../../src/agent/tool.ts", import.meta.url)      // 同上
 *   spawn([bun, "../../src/entrypoints/bootstrap.ts"])       // 起子进程
 *   readFileSync(SKILL_DIR + "/SKILL.md")                    // 读 skill 原文
 *
 * 包名对 `join()` / `readFileSync` / `spawn` 毫无意义 —— 它们要的是真实路径。
 * 这类调用改完会 ENOENT 或 "Module not found"，实测炸了 173 个测试。
 *
 * ## 判据
 *
 * 只改**不在 import/require/动态 import 位置**的 `@sid-code/<pkg>/<rest>` 字符串，
 * 把它还原成仓库相对路径 `packages/<pkg>/src/<rest>`。
 * 是否处于导入位置，看紧邻的前缀是不是 `from ` / `import(` / `require(`。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const APPLY = process.argv.includes("--apply");

const files = execFileSync("git", ["ls-files", "tests", "scripts"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter((f) => /\.tsx?$/.test(f));

let total = 0;
const touched: string[] = [];

for (const rel of files) {
  const abs = join(ROOT, rel);
  const original = readFileSync(abs, "utf8");
  let out = "";
  let idx = 0;
  let count = 0;

  const re = /(["'])@sid-code\/(shared|tui-renderer|core|cli)\/([^"']+)\1/g;
  for (const m of original.matchAll(re)) {
    const start = m.index!;
    // 看这个字符串字面量前面是不是导入语法
    // 前缀窗口取够大，并允许跨行空白 —— 实测有大量写法把说明符单独放一行：
    //   const x = await import(
    //     "@sid-code/core/llm/x.ts"
    //   );
    // 窗口太小 / 不允许换行都会把它误判成「非导入位置」，进而错误地改成路径。
    const before = original.slice(Math.max(0, start - 200), start);
    const isImport =
      /(?:\bfrom|\bimport|\brequire)\s*\(?\s*$/.test(before) ||
      /(?:\bimport|\brequire)\s*\(\s*$/.test(before);
    if (isImport) continue;

    const [q, , pkg, rest] = [m[1]!, m[0], m[2]!, m[3]!];
    out += original.slice(idx, start);
    out += `${q}packages/${pkg}/src/${rest}${q}`;
    idx = start + m[0].length;
    count++;
  }
  if (count === 0) continue;
  out += original.slice(idx);

  total += count;
  touched.push(`${rel} (${count})`);
  if (APPLY) writeFileSync(abs, out);
}

console.log(`${APPLY ? "已修复" : "待修复"}：${total} 处，涉及 ${touched.length} 个文件`);
for (const t of touched) console.log(`  ${t}`);
if (!APPLY) console.log("\n（dry-run。加 --apply 实际改写）");
