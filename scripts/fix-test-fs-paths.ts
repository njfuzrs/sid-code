#!/usr/bin/env bun
/**
 * 修复 tests/ 里指向 `src/` 的**文件系统路径**（P2-2 步骤4 收尾）—— 一次性脚本
 *
 * ## 与 fix-fs-path-specifiers.ts 的分工
 *
 * 那个脚本修「被误改成包名的路径」；本脚本修「压根没被改、仍写着 src/ 的路径」——
 * `pkg-migrate.ts` 只重写了 `import`/`require` 的说明符，没碰这类字符串：
 *
 *   join(REPO_ROOT, "src/query/types.ts")                    // 读源码做静态审计
 *   join(__dirname, "..", "..", "src", "command", "review.ts")  // 分段写法
 *   read("src/cli.ts")                                        // 自定义 helper
 *
 * 这些是**真·文件系统路径**，`src/` 被搬空后一律 ENOENT。
 *
 * ## 为什么必须逐个映射到包，不能统一加前缀
 *
 * `src/query/` 归 core、`src/ui/` 归 cli、`src/utils/` 归 shared ——
 * 目标包由模块名决定，复用 `pkg-boundary-scan.ts` 的 MODULE_TO_PACKAGE 单一事实源，
 * 避免这里再抄一份映射（抄一份就会漂移）。
 *
 * ## 跳过规则
 *
 * - import/require 位置：已由 pkg-migrate 处理，且包名形式是对的，不动。
 * - 测试夹具字符串：目标文件在磁盘上不存在 → 跳过（如 jit-boundary 的假路径、
 *   dynamic-conditional 的 `packages/app/src/index.ts`）。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { MODULE_TO_PACKAGE, ROOT_FILE_TO_PACKAGE } from "./pkg-boundary-scan.ts";

const ROOT = resolve(import.meta.dir, "..");
const APPLY = process.argv.includes("--apply");

/** `src/<rest>` → `packages/<pkg>/src/<rest>`；判不出包或目标不存在则返回 null。 */
function mapSrcPath(rest: string): string | null {
  const parts = rest.split("/");
  const pkg = parts.length === 1 ? ROOT_FILE_TO_PACKAGE[parts[0]!] : MODULE_TO_PACKAGE[parts[0]!];
  if (!pkg) return null;
  // ink 被扁平化进 tui-renderer 的 src 根
  const within = parts[0] === "ink" ? parts.slice(1).join("/") : parts.join("/");
  const candidate = `packages/${pkg}/src/${within}`;
  return existsSync(join(ROOT, candidate)) ? candidate : null;
}

const files = execFileSync("git", ["ls-files", "tests"], { cwd: ROOT, encoding: "utf8" })
  .trim()
  .split("\n")
  .filter((f) => /\.tsx?$/.test(f));

let total = 0;
const touched: string[] = [];

for (const rel of files) {
  const abs = join(ROOT, rel);
  const original = readFileSync(abs, "utf8");
  let content = original;
  let count = 0;

  // ---- 形态 A：整串 "src/a/b.ts"，且**必须是文件系统调用的实参** ----
  //
  // ⚠️ 「路径在磁盘上存在」这个判据**不够**。实测两处反例：
  //   - jit-context-gaps.test.ts:  discoverContext("src/ui/Footer.tsx", ".")
  //     —— 测「相对路径能否被正确解析」的夹具，而 packages/cli/src/ui/Footer.tsx 真的存在；
  //   - rules-active-scope.test.ts: expect(files).toContain("src/ui/")
  //     —— 测 glob 匹配语义的夹具，`src/ui/` 也真的存在。
  // 两者改写后测试语义就变了（断言的是解析行为，不是那个文件的内容）。
  //
  // 所以判据加严成「这个字符串是不是被喂给了真正读磁盘的函数」：
  // 只认 join / resolve / readFileSync / readFile / Bun.file / existsSync / read 等实参位置。
  const FS_CALLEES =
    /\b(join|resolve|readFileSync|readFile|existsSync|statSync|readdirSync|read|file)\s*\(\s*(?:[^()]*,\s*)?$/;
  content = content.replace(
    /(["'])src\/([^"']+)\1/g,
    (whole: string, q: string, rest: string, at: number) => {
      const before = content.slice(Math.max(0, at - 120), at);
      // import/require 位置不动（pkg-migrate 已处理成包名）
      if (/(?:\bfrom|\bimport|\brequire)\s*\(?\s*$/.test(before)) return whole;
      if (!FS_CALLEES.test(before)) return whole;
      const mapped = mapSrcPath(rest);
      if (!mapped) return whole;
      count++;
      return `${q}${mapped}${q}`;
    },
  );

  // ---- 形态 B：分段 join(<仓库根>, "..", "..", "src", "command", "review.ts") ----
  //
  // ⚠️ **必须确认 join 的基准是仓库根**，不能只看到 "src" 分段就改。实测反例：
  //   jit-context-gaps.test.ts:  writeFileSync(join(proj, "src", "ui", "CLAUDE.md"), ...)
  //   rules-active-scope.test.ts: join(proj, "src", "ui", "CLAUDE.md")
  // 这里 `proj` 是 mkdtemp 出来的**临时夹具工程**，它下面的 src/ui/ 是测试自己造的，
  // 与本仓库的分包毫无关系。改了就是把夹具路径写成 packages/cli/src/...，
  // 测试要么找不到文件、要么在验证一个不存在的场景。
  //
  // 只认这几个明确指向仓库根的基准标识符。新增基准变量名时补进来。
  const REPO_BASES = /\b(__dirname|import\.meta\.dir|REPO_ROOT|REPO|ROOT|repoRoot)\s*,\s*$/;
  content = content.replace(
    /(["'])src\1(\s*,\s*(["'])[^"']+\3)+/g,
    (whole: string, ...rest: unknown[]) => {
      const at = rest[rest.length - 2] as number;
      // 往前看：跳过任意多个 ".."/"." 分段，落到基准标识符上
      let before = content.slice(Math.max(0, at - 200), at);
      before = before.replace(/(\s*(["'])\.{1,2}\2\s*,\s*)+$/, "");
      if (!REPO_BASES.test(before)) return whole;

      const segs = [...whole.matchAll(/(["'])([^"']+)\1/g)].map((m) => m[2]!);
      const relPath = segs.slice(1).join("/"); // 去掉开头的 "src"
      const mapped = mapSrcPath(relPath);
      if (!mapped) return whole;
      count++;
      // packages/<pkg>/src/<...> → 拆回分段字面量，保持原有 join(...) 风格
      const q = whole[0]!;
      return mapped
        .split("/")
        .map((p) => `${q}${p}${q}`)
        .join(", ");
    },
  );

  if (count === 0) continue;
  total += count;
  touched.push(`${rel} (${count})`);
  if (APPLY) writeFileSync(abs, content);
}

console.log(`${APPLY ? "已修复" : "待修复"}：${total} 处，涉及 ${touched.length} 个文件`);
for (const t of touched) console.log(`  ${t}`);
if (!APPLY) console.log("\n（dry-run。加 --apply 实际改写）");
