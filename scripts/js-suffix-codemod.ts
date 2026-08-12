#!/usr/bin/env bun
/**
 * `.js` 后缀导入 → 真实后缀（`.ts` / `.tsx`）的 codemod（P2-2 步骤3）
 *
 * ## 为什么必须改
 *
 * 存量代码里有 `import Box from "../ink/components/Box.js"` 这种写法
 * （TS NodeNext 惯例：源码是 `.tsx`，导入写 `.js`）。分包后 `src/ink` 成为
 * `@sid-code/tui-renderer`，其 `exports` 是 `{"./*": "./src/*"}` —— 导入侧必须写
 * **真实扩展名**，`Box.js` 会解析失败。
 *
 * ## 为什么不用 exports 双通配绕过
 *
 * 方案 §3.5 实测过 `{"./*.js": "./src/*.tsx", "./*": "./src/*"}`：能用，但**一条通配
 * 只能映射到一种扩展名**，而被 `.js` 导入的 ink 文件里 `.ts` 与 `.tsx` 两种都有。
 * 所以只能 codemod。
 *
 * ## 安全性判据（不是"觉得安全"，是脚本证过的）
 *
 * 每个 `.js` 说明符必须能**唯一**映射到磁盘上真实存在的文件：
 * - 歧义（同名 `.ts` 与 `.tsx` 并存）→ 报错退出，绝不猜；
 * - 悬空（两种都不存在）→ 报错退出。
 * 两者都为 0 才允许改写。
 *
 * ## 范围
 *
 * 默认只改**跨包**的（方案决策3：最小必要范围）：
 *   - `src/` 下非 ink 目录 → ink 的导入
 *   - `tests/` → ink 的导入
 * 包内自引用（ink 内部、非 ink 同包内）不受 exports 约束，保持原样 ——
 * 拆包 diff 本身已经很大，不要把无关的风格统一混进同一批改动。
 *
 * 用法：
 *   bun scripts/js-suffix-codemod.ts            # 只报告，不改（dry-run）
 *   bun scripts/js-suffix-codemod.ts --apply    # 实际改写
 *   bun scripts/js-suffix-codemod.ts --all      # 含包内自引用（可选，默认不做）
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { collectSourceFiles } from "./pkg-boundary-scan.ts";

const ROOT = resolve(import.meta.dir, "..");

interface Rewrite {
  file: string;
  line: number;
  from: string;
  to: string;
}

interface Problem {
  file: string;
  line: number;
  spec: string;
  kind: "ambiguous" | "dangling";
  detail: string;
}

/** 该说明符是否跨越 ink（tui-renderer）包边界。 */
function crossesInkBoundary(fileRel: string, spec: string): boolean {
  // 导入目标解析后落在 src/ink/ 内，且导入方**不在** src/ink/ 内
  const abs = resolve(join(ROOT, fileRel), "..", spec);
  const targetRel = relative(ROOT, abs);
  return targetRel.startsWith("src/ink/") && !fileRel.startsWith("src/ink/");
}

function main() {
  const apply = process.argv.includes("--apply");
  const all = process.argv.includes("--all");

  const files = [
    ...collectSourceFiles(join(ROOT, "src")),
    ...collectSourceFiles(join(ROOT, "tests")),
  ];

  const rewrites: Rewrite[] = [];
  const problems: Problem[] = [];
  let skippedInPackage = 0;

  for (const abs of files) {
    const fileRel = relative(ROOT, abs);
    const content = readFileSync(abs, "utf8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // 只处理相对路径的 .js 说明符（npm 包的 .js 不碰）
      for (const m of line.matchAll(/["'](\.[^"']*?)\.js["']/g)) {
        const spec = `${m[1]!}.js`;
        const inScope = all || crossesInkBoundary(fileRel, spec);
        if (!inScope) {
          skippedInPackage++;
          continue;
        }

        const base = resolve(join(ROOT, fileRel), "..", m[1]!);
        const hasTs = existsSync(`${base}.ts`);
        const hasTsx = existsSync(`${base}.tsx`);

        if (hasTs && hasTsx) {
          problems.push({
            file: fileRel,
            line: i + 1,
            spec,
            kind: "ambiguous",
            detail: `同名 .ts 与 .tsx 并存：${relative(ROOT, base)}`,
          });
          continue;
        }
        if (!hasTs && !hasTsx) {
          problems.push({
            file: fileRel,
            line: i + 1,
            spec,
            kind: "dangling",
            detail: `目标不存在：${relative(ROOT, base)}.{ts,tsx}`,
          });
          continue;
        }
        rewrites.push({
          file: fileRel,
          line: i + 1,
          from: spec,
          to: `${m[1]!}${hasTs ? ".ts" : ".tsx"}`,
        });
      }
    }
  }

  console.log(`范围：${all ? "全部 .js 导入" : "仅跨 ink 包边界（方案决策3：最小必要）"}`);
  console.log(`待改写：${rewrites.length} 处`);
  console.log(`  → .ts : ${rewrites.filter((r) => r.to.endsWith(".ts")).length}`);
  console.log(`  → .tsx: ${rewrites.filter((r) => r.to.endsWith(".tsx")).length}`);
  if (!all) console.log(`跳过（包内自引用，不受 exports 约束）：${skippedInPackage} 处`);

  const byFile = new Map<string, Rewrite[]>();
  for (const r of rewrites) {
    const arr = byFile.get(r.file) ?? [];
    arr.push(r);
    byFile.set(r.file, arr);
  }
  console.log(`涉及文件：${byFile.size} 个`);
  console.log(`  src/  : ${[...byFile.keys()].filter((f) => f.startsWith("src/")).length}`);
  console.log(`  tests/: ${[...byFile.keys()].filter((f) => f.startsWith("tests/")).length}`);

  if (problems.length > 0) {
    console.error(`\n❌ ${problems.length} 处无法唯一映射，拒绝改写（绝不猜）：`);
    for (const p of problems) {
      console.error(`  [${p.kind}] ${p.file}:${p.line}  ${p.spec}  —— ${p.detail}`);
    }
    process.exit(1);
  }
  console.log("\n✅ 零歧义、零悬空 —— 全部可唯一映射到真实文件");

  if (!apply) {
    console.log("\n（dry-run。加 --apply 实际改写）");
    return;
  }

  for (const [file, rs] of byFile) {
    const abs = join(ROOT, file);
    let content = readFileSync(abs, "utf8");
    for (const r of rs) {
      // 带引号整体替换，避免 `Box.js` 误伤同名子串
      for (const q of ['"', "'"]) {
        content = content.split(`${q}${r.from}${q}`).join(`${q}${r.to}${q}`);
      }
    }
    writeFileSync(abs, content);
  }
  console.log(`\n✅ 已改写 ${byFile.size} 个文件、${rewrites.length} 处导入`);
}

main();
