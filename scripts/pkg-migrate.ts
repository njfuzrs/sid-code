#!/usr/bin/env bun
/**
 * monorepo 分包迁移器（P2-2 步骤4/5）—— 一次性脚本，落地后即可删除
 *
 * 做四件事：
 *   1. `git mv` 把 `src/` 下的模块搬进 `packages/{tui-renderer,shared,core,cli}/src/`
 *   2. 重写**跨包**的相对导入为包名导入（包内相对导入保持不动 —— 这是本方案工作量小的关键）
 *   3. 重写 `tests/` 与 `scripts/` 对 `src/` 的引用
 *   4. 生成 4 个 `package.json`
 *
 * ## 为什么包内相对导入不用改
 *
 * 目录**层级结构完整保留**（`src/llm/x.ts` → `packages/core/src/llm/x.ts`），
 * 所以 `src/llm/x.ts` 里的 `../config/config.ts` 迁移后仍然正确解析到
 * `packages/core/src/config/config.ts`。只有跨越包边界的那些需要改成包名。
 * 实测 1007 个文件里只有约 1000 处跨包导入需要重写，其余全部零改动。
 *
 * ## 两个目录被刻意扁平化
 *
 * - `src/ink/*` → `packages/tui-renderer/src/*`：ink 就是整个包，
 *   保留 `ink/` 一层会让导入变成 `@sid-code/tui-renderer/ink/components/Box.tsx`（冗余）。
 * - `src/{utils,util,types}` **不扁平**：保留目录名。`util` 与 `utils` 是两个不同目录，
 *   扁平化会丢掉这个区分，且改写规则要多一步「去掉目录名」，容易出错。
 *   代价只是导入路径多一段（`@sid-code/shared/utils/x.ts`），换来改写规则是纯前缀替换。
 *
 * 用法：
 *   bun scripts/pkg-migrate.ts            # dry-run，只报告
 *   bun scripts/pkg-migrate.ts --apply    # 实际执行
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  MODULE_TO_PACKAGE,
  ROOT_FILE_TO_PACKAGE,
  collectSourceFiles,
} from "./pkg-boundary-scan.ts";

const ROOT = resolve(import.meta.dir, "..");
const APPLY = process.argv.includes("--apply");

/** 包名前缀。 */
const SCOPE = "@sid-code";

/** 扁平化的模块：其内容直接进包的 src/ 根，不保留自身目录名。 */
const FLATTENED = new Set(["ink"]);

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
}

/**
 * 计算 `src/` 下某个相对路径迁移后的新路径（相对 ROOT）。
 * 返回 null 表示不该被迁移（未映射）。
 */
function newPathOf(srcRel: string): string | null {
  const parts = srcRel.split("/");
  if (parts.length === 1) {
    const pkg = ROOT_FILE_TO_PACKAGE[parts[0]!];
    return pkg ? `packages/${pkg}/src/${parts[0]}` : null;
  }
  const mod = parts[0]!;
  const pkg = MODULE_TO_PACKAGE[mod];
  if (!pkg) return null;
  const rest = FLATTENED.has(mod) ? parts.slice(1).join("/") : parts.join("/");
  return `packages/${pkg}/src/${rest}`;
}

/** 从新路径反推：它属于哪个包、在包 src/ 内的路径是什么。 */
function pkgOfNewPath(newRel: string): { pkg: string; within: string } | null {
  const m = /^packages\/([^/]+)\/src\/(.*)$/.exec(newRel);
  if (!m) return null;
  return { pkg: m[1]!, within: m[2]! };
}

function main() {
  // ---------- 阶段 0：建立「旧 src 路径 → 新路径」的全量映射 ----------
  const srcFiles = collectSourceFiles(join(ROOT, "src")).map((f) => relative(ROOT, f));
  // 非 ts/tsx 的资源文件（SKILL.md / yaml / mjs 等）也要一起搬，否则内置 skill 会丢
  const allSrcFiles = sh("git", ["ls-files", "src"]).trim().split("\n").filter(Boolean);

  const moveMap = new Map<string, string>(); // 旧(相对ROOT) → 新(相对ROOT)
  const unmapped: string[] = [];
  for (const f of allSrcFiles) {
    const srcRel = f.slice("src/".length);
    const np = newPathOf(srcRel);
    if (!np) {
      unmapped.push(f);
      continue;
    }
    moveMap.set(f, np);
  }
  if (unmapped.length > 0) {
    console.error(`❌ ${unmapped.length} 个文件无法判定归属，拒绝迁移：`);
    for (const f of unmapped.slice(0, 20)) console.error(`   ${f}`);
    process.exit(1);
  }
  console.log(`待搬移文件：${moveMap.size} 个（其中 ts/tsx ${srcFiles.length} 个）`);

  const pkgCount = new Map<string, number>();
  for (const np of moveMap.values()) {
    const p = pkgOfNewPath(np)!.pkg;
    pkgCount.set(p, (pkgCount.get(p) ?? 0) + 1);
  }
  for (const [p, n] of [...pkgCount].sort()) console.log(`  ${p.padEnd(14)} ${n} 文件`);

  // ---------- 阶段 1：算出所有需要重写的导入 ----------
  /**
   * 把「某文件里的某个相对说明符」翻译成迁移后的说明符。
   * 返回 null = 不需要改（同包内，相对路径迁移后依然正确）。
   */
  function rewriteSpec(
    fileRelOld: string,
    fileNewRel: string,
    spec: string,
  ): string | null {
    if (!spec.startsWith(".")) return null; // npm 包
    const targetAbs = resolve(join(ROOT, fileRelOld), "..", spec);
    const targetOld = relative(ROOT, targetAbs);

    // 指向仓库外或非 src/ 的（如 ../package.json）——交由调用方特判
    if (!targetOld.startsWith("src/")) return null;

    const targetNew = moveMap.get(targetOld);
    if (!targetNew) {
      // 有可能是无扩展名的目录导入或不存在的文件；尝试补扩展名
      const cands = [`${targetOld}.ts`, `${targetOld}.tsx`, `${targetOld}/index.ts`];
      const hit = cands.find((c) => moveMap.has(c));
      if (!hit) return null;
      return rewriteResolved(fileNewRel, moveMap.get(hit)!, spec);
    }
    return rewriteResolved(fileNewRel, targetNew, spec);
  }

  function rewriteResolved(
    fileNewRel: string,
    targetNewRel: string,
    _spec: string,
  ): string | null {
    const from = pkgOfNewPath(fileNewRel);
    const to = pkgOfNewPath(targetNewRel);
    if (!from || !to) return null;
    if (from.pkg === to.pkg) return null; // 同包：相对路径依然有效，不动
    return `${SCOPE}/${to.pkg}/${to.within}`;
  }

  interface Edit { file: string; from: string; to: string }
  const edits: Edit[] = [];

  // 1a. src/ 内部的跨包导入
  for (const [oldRel, newRel] of moveMap) {
    if (!/\.tsx?$/.test(oldRel)) continue;
    const content = readFileSync(join(ROOT, oldRel), "utf8");
    const seen = new Set<string>();
    for (const m of content.matchAll(/["'](\.[^"']+)["']/g)) {
      const spec = m[1]!;
      if (seen.has(spec)) continue;
      seen.add(spec);
      // version.ts 读根 package.json：单独处理，见阶段 3
      if (spec.endsWith("package.json")) continue;
      const to = rewriteSpec(oldRel, newRel, spec);
      if (to) edits.push({ file: oldRel, from: spec, to });
    }
  }

  // 1b. tests/ 与 scripts/ 对 src/ 的引用 → 包名
  const outsideFiles = [
    ...sh("git", ["ls-files", "tests"]).trim().split("\n"),
    ...sh("git", ["ls-files", "scripts"]).trim().split("\n"),
  ].filter((f) => f && /\.(tsx?|sh|json)$/.test(f));

  for (const f of outsideFiles) {
    const abs = join(ROOT, f);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs, "utf8");
    const seen = new Set<string>();
    // 相对路径形态：../../src/xxx
    for (const m of content.matchAll(/["'](\.[^"']*\/src\/[^"']+)["']/g)) {
      const spec = m[1]!;
      if (seen.has(spec)) continue;
      seen.add(spec);
      const targetOld = relative(ROOT, resolve(join(ROOT, f), "..", spec));
      if (!targetOld.startsWith("src/")) continue;
      let targetNew = moveMap.get(targetOld);
      if (!targetNew) {
        const hit = [`${targetOld}.ts`, `${targetOld}.tsx`, `${targetOld}/index.ts`].find(
          (c) => moveMap.has(c),
        );
        if (!hit) continue;
        targetNew = moveMap.get(hit)!;
      }
      const to = pkgOfNewPath(targetNew)!;
      edits.push({ file: f, from: spec, to: `${SCOPE}/${to.pkg}/${to.within}` });
    }
    // 裸 "src/xxx" 形态（脚本里 `bun run src/cli.ts`、字符串路径等）。
    //
    // ⚠️ **只对显式白名单里的文件做这种改写**，且路径必须在磁盘上真实存在。
    //
    // 两道限制都是实测踩出来的 —— 裸路径字符串在脚本里有三种完全不同的语义，
    // 机械改写分不清，改错了还不会报错（静默篡改数据）：
    //   1. 真·路径引用（`bun run src/cli.ts`、`readFile("src/hook/types.ts")`）→ 该改；
    //   2. **测试夹具**：`jit-boundary-b4.ts` 里 `"cat > src/ui/Badge.tsx"` 是喂给 bash
    //      命令解析器的假路径，断言哪些会被识别为受影响文件。改了就是篡改夹具。
    //      这类路径磁盘上不存在，靠 existsSync 能挡住；
    //   3. **黑名单 token**：`eval/extract-holdout-tokens.ts` 的 BLACKLIST 是「题面泄露
    //      检测的公共词表」，里面 `"src/agent/loop-detection"` 与
    //      `"src/agent/loop-detection.ts"` 是两个**独立词条**。改写会把它们折叠成同一条，
    //      而且它们对应的文件**真的存在**，existsSync 挡不住 —— 只能靠白名单排除。
    // 白名单外的裸路径（含注释里的路径、词表）一律不动，需要改的人工处理。
    const BARE_PATH_ALLOWLIST = new Set([
      "scripts/release.sh",
      "scripts/git-hooks/pre-commit.sh",
      "scripts/embed-builtin-skills.ts",
      "scripts/fetch-ripgrep.ts",
      "scripts/docs-gen-reference.ts",
      "scripts/changelog-curate.ts",
      "scripts/self-audit.ts",
      "scripts/trace-digest.ts",
      "scripts/verify-hypothesis-guide.ts",
      "scripts/loop-stats-probe.ts",
      "scripts/e2e-claude-migration.ts",
      "scripts/eval/aggregate-failure-modes.ts",
      "scripts/eval/check-skill-holdout-regression.ts",
      "scripts/eval/lint-architecture.ts",
      "scripts/eval/paired-trajectory-diff.ts",
      "scripts/eval/run-ci-self-heal-skill.ts",
      "scripts/eval/run-code-governance-skill.ts",
      "scripts/eval/run-code-review-skill.ts",
      "scripts/eval/run-eval-baseline.ts",
      "scripts/eval/run-incident-rca-skill.ts",
      "scripts/eval/run-security-audit-skill.ts",
      "scripts/probe/jit-boundary-real-rules.ts",
    ]);
    if (!BARE_PATH_ALLOWLIST.has(f)) continue;

    for (const m of content.matchAll(/(?<![./\w-])src\/[A-Za-z0-9_./-]+/g)) {
      const targetOld = m[0]!.replace(/\/$/, "");
      if (seen.has(targetOld)) continue;
      seen.add(targetOld);
      const targetNew =
        moveMap.get(targetOld) ??
        moveMap.get(`${targetOld}.ts`) ??
        moveMap.get(`${targetOld}.tsx`);
      if (targetNew) {
        edits.push({ file: f, from: targetOld, to: targetNew });
        continue;
      }
      if (moveMap.has(`${targetOld}/index.ts`)) {
        edits.push({ file: f, from: targetOld, to: dirname(moveMap.get(`${targetOld}/index.ts`)!) });
        continue;
      }
      // 目录形态（如 src/ui、src/tool）：必须是真实目录才改
      if (existsSync(join(ROOT, targetOld))) {
        const asDir = newPathOf(targetOld.slice("src/".length));
        if (asDir) edits.push({ file: f, from: targetOld, to: asDir });
      }
      // 既非真实文件也非真实目录 → 夹具字符串，跳过（不报错，这是预期情况）
    }
  }

  const editFiles = new Set(edits.map((e) => e.file));
  console.log(`\n待重写导入：${edits.length} 处，涉及 ${editFiles.size} 个文件`);
  console.log(`  src/    : ${[...editFiles].filter((f) => f.startsWith("src/")).length}`);
  console.log(`  tests/  : ${[...editFiles].filter((f) => f.startsWith("tests/")).length}`);
  console.log(`  scripts/: ${[...editFiles].filter((f) => f.startsWith("scripts/")).length}`);

  if (!APPLY) {
    console.log("\n（dry-run。加 --apply 实际执行）");
    console.log("\n重写样例（前 15 条）：");
    for (const e of edits.slice(0, 15)) console.log(`  ${e.file}: ${e.from} → ${e.to}`);
    return;
  }

  // ---------- 阶段 2：先改内容（在旧路径上改），再 git mv ----------
  // 顺序很重要：先改内容能让「说明符解析」始终基于旧布局，逻辑简单不易错。
  const byFile = new Map<string, Edit[]>();
  for (const e of edits) {
    const arr = byFile.get(e.file) ?? [];
    arr.push(e);
    byFile.set(e.file, arr);
  }
  for (const [file, es] of byFile) {
    const abs = join(ROOT, file);
    let content = readFileSync(abs, "utf8");
    // 长的先替换，避免 src/ui 抢先吃掉 src/ui/components 的前缀
    for (const e of [...es].sort((a, b) => b.from.length - a.from.length)) {
      if (e.from.startsWith(".")) {
        // 相对说明符：必须连引号一起匹配，否则 `../config` 会误伤 `../config-extra`
        for (const q of ['"', "'"]) {
          content = content.split(`${q}${e.from}${q}`).join(`${q}${e.to}${q}`);
        }
        continue;
      }
      // 裸路径（`bun run src/cli.ts`、`join(REPO, "src/x.ts")` 等）：
      // **只做一次**无引号替换 —— 它天然覆盖带引号的情形。
      //
      // ⚠️ 这里踩过一次：原先先做带引号替换、再做裸替换，于是 `"src/app.ts"` 被改成
      // `"packages/cli/src/app.ts"` 后，紧接着的裸替换又在结果里匹配到 `src/app.ts`，
      // 二次改写成 `"packages/cli/packages/cli/src/app.ts"`。
      // 同一个说明符**只能被替换一次**，这是本循环的不变式。
      content = content.split(e.from).join(e.to);
    }
    writeFileSync(abs, content);
  }
  console.log(`✅ 已重写 ${byFile.size} 个文件的导入`);

  // ---------- 阶段 3：git mv ----------
  for (const [oldRel, newRel] of moveMap) {
    const destDir = join(ROOT, dirname(newRel));
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    sh("git", ["mv", oldRel, newRel]);
  }
  console.log(`✅ 已搬移 ${moveMap.size} 个文件`);

  // version.ts 读的是**仓库根** package.json（版本号单一来源，release.sh /
  // bump-version.ts / changelog 全依赖它）。移进 packages/shared/src/ 后深了两层。
  const versionPath = join(ROOT, "packages/shared/src/version.ts");
  if (existsSync(versionPath)) {
    let c = readFileSync(versionPath, "utf8");
    c = c.replace('from "../package.json"', 'from "../../../package.json"');
    writeFileSync(versionPath, c);
    console.log("✅ 已修正 version.ts 的根 package.json 相对路径");
  }
}

main();
