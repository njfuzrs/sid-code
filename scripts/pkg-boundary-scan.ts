#!/usr/bin/env bun
/**
 * 分包边界扫描器 —— P2-2 monorepo 分包的核心工具。
 *
 * 两个用途：
 * 1. 拆包**前**：在扁平 `src/` 结构上按「模块 → 包」映射试算越界数（`--src` 模式）。
 * 2. 拆包**后**：在 `packages/` 结构上校验真实包边界（`--packages` 模式，供门禁测试复用）。
 *
 * 为什么必须是脚本而不是目测：一个模块放错位置能让工作量翻数倍（实测 58 → 11），
 * 而试算一次只要几秒。见方案 §4.1。
 *
 * ⚠️ **分包已完成（2026-08-11），默认模式是 `--packages`。** `--src` 模式是试算工具，
 * 旧的扁平 `src/` 已经不存在，跑它只会拿到「目录不存在」的报错 —— 保留它是为了
 * 将来再做同类拆分时能复用，不是当前的门禁路径。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * 包的层级 rank：低 rank 不得导入高 rank。
 *
 * ⚠️ `shared` 是 rank 0（真叶子），`tui-renderer` 是 rank 1 —— 与方案 §6.1 写的
 * 「tui-renderer(0) < shared(1)」相反。这是**方案内部两处自相矛盾**，落地时必须择一：
 *
 * - §2.1 说 tui-renderer「无内部依赖（叶子）」；
 * - §4.4 却裁决「把 Color 类型下移到 shared，**tui-renderer 与 core 都从 shared 导入**，
 *   让 core → tui-renderer 归零」。
 *
 * 两条不可能同时成立 —— 一旦 tui-renderer 从 shared 取 Color，它就不再是叶子。
 * 采用 §4.4 的目标（core 完全不知道 TUI 的存在，这是「core 能当库用」的前提），
 * 于是唯一自洽的顺序是 shared(0) < tui-renderer(1) < core(2) < cli(3)：
 * shared 零内部依赖，是真正的叶子。
 *
 * 实测印证：`src/utils`、`src/util`、`src/types` 对 ink 的引用数为 0（反向为 2）。
 */
export const PACKAGE_RANK: Record<string, number> = {
  shared: 0,
  "tui-renderer": 1,
  core: 2,
  cli: 3,
};

/** `src/` 一级目录 → 包名。拆包前试算用。 */
export const MODULE_TO_PACKAGE: Record<string, string> = {
  // tui-renderer：vendor 的 ink fork
  ink: "tui-renderer",

  // shared：纯叶子工具层
  utils: "shared",
  util: "shared",
  types: "shared",

  // core：agent 运行时
  "command-contract": "core", // 命令契约类型（P2-2 修法①：从 cli 的 command/types.ts 下移）
  llm: "core",
  api: "core",
  config: "core",
  query: "core",
  context: "core",
  session: "core",
  "session-memory": "core",
  memory: "core",
  tool: "core",
  permission: "core",
  hook: "core",
  agent: "core",
  task: "core",
  skill: "core",
  mcp: "core",
  trace: "core",
  telemetry: "core",
  analytics: "core",
  lsp: "core",
  checkpoint: "core",
  worktree: "core",
  plan: "core",
  goal: "core",
  workflow: "core",
  swarm: "core",
  cron: "core",
  extension: "core",
  daemon: "core",
  bridge: "core",
  ide: "core",
  sdk: "core",
  debug: "core",
  migrations: "core",
  coordinator: "core",
  bootstrap: "core",

  // cli：TUI + 命令 + 入口
  ui: "cli",
  command: "cli",
  entrypoints: "cli",
  plugin: "cli",
  state: "cli",
};

/** `src/` 根文件 → 包名。 */
export const ROOT_FILE_TO_PACKAGE: Record<string, string> = {
  "version.ts": "shared",
  "app.ts": "cli",
  "cli.ts": "cli",
  "help.ts": "cli",
  "vendor-embed.d.ts": "cli",
};

export interface Violation {
  file: string;
  line: number;
  fromPkg: string;
  toPkg: string;
  spec: string;
  isTypeOnly: boolean;
}

/** 递归收集 .ts/.tsx 文件。 */
export function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 抽取一个文件里的所有导入说明符。
 *
 * 覆盖四种形态（静态 import / export from / 动态 import() / inline 类型 import("...")），
 * 因为「类型依赖也是依赖」—— 漏掉 inline 类型 import 会让 config.ts:192 那处越界隐身。
 */
export function extractImports(
  content: string,
): Array<{ line: number; spec: string; isTypeOnly: boolean }> {
  const results: Array<{ line: number; spec: string; isTypeOnly: boolean }> = [];

  // 先剥掉注释再匹配。必须这么做而不是「跳过注释行」——
  // 实测 src/ink/hooks/use-input.ts 的文档注释里有 `from 'ink'` 示例代码，
  // 而多行 import 块又跨越了行边界，两者只能靠「先剥注释、再全文匹配」同时满足。
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));

  /** 由字符偏移量算行号（1-based）。 */
  const lineAt = (idx: number) => stripped.slice(0, idx).split("\n").length;

  // 静态 import / export ... from "spec"（[\s\S] 以覆盖多行 import 块）
  for (const m of stripped.matchAll(
    /\b(import|export)\s+(type\s+)?[\s\S]*?from\s*["']([^"']+)["']/g,
  )) {
    results.push({
      line: lineAt(m.index!),
      spec: m[3]!,
      isTypeOnly: Boolean(m[2]),
    });
  }
  // 裸 import "spec"（副作用导入）
  for (const m of stripped.matchAll(/\bimport\s+["']([^"']+)["']/g)) {
    results.push({ line: lineAt(m.index!), spec: m[1]!, isTypeOnly: false });
  }
  // import("spec") —— 动态导入，或 inline 类型位置
  for (const m of stripped.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    // `: import("x").Y` / `typeof import("x")` 属类型位置
    const before = stripped.slice(0, m.index);
    const isType = /[:<|&]\s*$|typeof\s+$/.test(before);
    results.push({ line: lineAt(m.index!), spec: m[1]!, isTypeOnly: isType });
  }
  return results;
}

/** 判定 `src/` 下某个文件属于哪个包。 */
export function packageOfSrcFile(relPath: string): string | null {
  const parts = relPath.split("/");
  if (parts.length === 1) return ROOT_FILE_TO_PACKAGE[parts[0]!] ?? null;
  return MODULE_TO_PACKAGE[parts[0]!] ?? null;
}

/** 在扁平 `src/` 结构上试算越界。 */
export function scanSrcMode(srcRoot: string): {
  violations: Violation[];
  edges: Map<string, number>;
  sizes: Map<string, { files: number; lines: number }>;
} {
  const files = collectSourceFiles(srcRoot);
  const violations: Violation[] = [];
  const edges = new Map<string, number>();
  const sizes = new Map<string, { files: number; lines: number }>();

  // 未映射的模块必须报错，绝不静默跳过。
  //
  // 为什么这道检查是必需的：漏映射的模块会被「跳过」——它的越界不计入总数，
  // 于是新增一个目录就等于给自己开了个后门，而门禁照样绿。这正是
  // `lint-architecture.ts` 记录的「`if (!existsSync) return []` 是一道
  // 永远不会红的门禁，比没有门禁更糟」的同族故障。
  const unmapped = new Set<string>();
  for (const file of files) {
    const rel = relative(srcRoot, file);
    if (!packageOfSrcFile(rel)) {
      unmapped.add(rel.includes("/") ? rel.split("/")[0]! : rel);
    }
  }
  if (unmapped.size > 0) {
    throw new Error(
      `以下 src/ 模块未在 MODULE_TO_PACKAGE / ROOT_FILE_TO_PACKAGE 中映射，` +
        `无法判定包归属（漏映射会让越界静默不计数）：\n  ` +
        [...unmapped].sort().join("\n  "),
    );
  }

  for (const file of files) {
    const rel = relative(srcRoot, file);
    const fromPkg = packageOfSrcFile(rel);
    if (!fromPkg) continue;

    const content = readFileSync(file, "utf8");
    const size = sizes.get(fromPkg) ?? { files: 0, lines: 0 };
    size.files += 1;
    size.lines += content.split("\n").length;
    sizes.set(fromPkg, size);

    for (const imp of extractImports(content)) {
      if (!imp.spec.startsWith(".")) continue; // 外部 npm 依赖，不管
      // 解析成相对 srcRoot 的路径
      const abs = resolve(join(srcRoot, rel), "..", imp.spec);
      const targetRel = relative(srcRoot, abs);
      if (targetRel.startsWith("..")) continue; // 指向 src/ 之外（如 package.json）
      const toPkg = packageOfSrcFile(targetRel);
      if (!toPkg || toPkg === fromPkg) continue;

      edges.set(`${fromPkg}→${toPkg}`, (edges.get(`${fromPkg}→${toPkg}`) ?? 0) + 1);
      if (PACKAGE_RANK[fromPkg]! < PACKAGE_RANK[toPkg]!) {
        violations.push({
          file: `src/${rel}`,
          line: imp.line,
          fromPkg,
          toPkg,
          spec: imp.spec,
          isTypeOnly: imp.isTypeOnly,
        });
      }
    }
  }
  return { violations, edges, sizes };
}

/** 参与边界校验的 4 个包，按 rank 升序。eval-framework 是独立 vendor 包，不在此列。 */
export const PACKAGES = ["shared", "tui-renderer", "core", "cli"] as const;

/**
 * 在真实 `packages/` 结构上校验包边界（拆包**后**的门禁路径）。
 *
 * 与 `--src` 试算模式的关键差异：这里判定「目标属于哪个包」不靠 MODULE_TO_PACKAGE 映射，
 * 而是直接看导入说明符 ——
 *
 * - `@sid-code/<pkg>/...` → 跨包导入，按 rank 判越界；
 * - 相对路径 → 解析后必须仍落在**本包**内，落到别的包里就是「绕过 bare specifier 偷渡」，
 *   哪怕方向合法也算违规：它绕过了 package.json 的 exports 契约，让依赖关系在
 *   `bun.lock` / dependencies 字段里查不到，未来单独发包时才会炸。
 *
 * 两类违规分开报（`kind`），因为修法不同：rank 违规要下移类型或反转依赖，
 * cross-package-relative 只要改成 bare specifier。
 */
export interface PackageViolation extends Violation {
  kind: "rank" | "cross-package-relative" | "self-bare-import";
}

export function scanPackagesMode(packagesRoot: string): {
  violations: PackageViolation[];
  edges: Map<string, number>;
  sizes: Map<string, { files: number; lines: number }>;
} {
  const violations: PackageViolation[] = [];
  const edges = new Map<string, number>();
  const sizes = new Map<string, { files: number; lines: number }>();

  for (const pkg of PACKAGES) {
    const pkgSrc = join(packagesRoot, pkg, "src");
    // 防空转：包目录必须存在。缺了就抛 —— 一个不存在的目录会让 collectSourceFiles
    // 直接报错，但若哪天改成「静默跳过」，这道门禁就会在包被重命名后永远绿。
    // 这与 lint-architecture.ts 记录的「`if (!existsSync) return []` 比没有门禁更糟」同族。
    const files = collectSourceFiles(pkgSrc);
    if (files.length === 0) {
      throw new Error(
        `包 ${pkg} 的 src/ 下扫到 0 个 .ts/.tsx 文件（路径：${pkgSrc}）——` +
          `要么包结构变了、要么这道门禁在空转。`,
      );
    }

    for (const file of files) {
      const relInPkg = relative(pkgSrc, file);
      const content = readFileSync(file, "utf8");
      const size = sizes.get(pkg) ?? { files: 0, lines: 0 };
      size.files += 1;
      size.lines += content.split("\n").length;
      sizes.set(pkg, size);

      for (const imp of extractImports(content)) {
        const displayFile = `packages/${pkg}/src/${relInPkg}`;

        // ---- 形态 A：bare specifier `@sid-code/<pkg>[/...]` ----
        const bare = /^@sid-code\/([a-z-]+)(?:\/|$)/.exec(imp.spec);
        if (bare) {
          const toPkg = bare[1]!;
          if (toPkg === pkg) {
            // 自包不该走 bare specifier：绕一圈 node_modules symlink，
            // 既拖慢解析又让「这文件属于哪个包」在阅读时失去局部性。
            violations.push({
              file: displayFile,
              line: imp.line,
              fromPkg: pkg,
              toPkg,
              spec: imp.spec,
              isTypeOnly: imp.isTypeOnly,
              kind: "self-bare-import",
            });
            continue;
          }
          if (PACKAGE_RANK[toPkg] === undefined) continue; // 非 4 包之一，跳过
          edges.set(`${pkg}→${toPkg}`, (edges.get(`${pkg}→${toPkg}`) ?? 0) + 1);
          if (PACKAGE_RANK[pkg]! < PACKAGE_RANK[toPkg]!) {
            violations.push({
              file: displayFile,
              line: imp.line,
              fromPkg: pkg,
              toPkg,
              spec: imp.spec,
              isTypeOnly: imp.isTypeOnly,
              kind: "rank",
            });
          }
          continue;
        }

        // ---- 形态 B：相对路径，必须落在本包内 ----
        if (!imp.spec.startsWith(".")) continue; // 外部 npm 依赖
        const abs = resolve(file, "..", imp.spec);
        const relToPkgSrc = relative(pkgSrc, abs);
        if (!relToPkgSrc.startsWith("..")) continue; // 仍在本包 src/ 内 → 合法

        // 逃出了 src/ 但仍在**本包目录内** → 合法。
        //
        // 判据是"同一个包"，不是"同一个 src/"：包的边界是 packages/<pkg>/，
        // src/ 只是它的一个子目录。包内非 src 资产同样属于本包，引用它不跨任何边界。
        //
        // 实测触发者：packages/core/src/tool/rg-embedded.ts 引
        // `../../vendor/rg-embed`（P2-3 把 vendor/ 从仓库根下沉到 packages/core/ 之后）。
        // 迁移前那个 import 指向仓库根，落在 packages/ 之外，被下面的 `toPkg === null`
        // 分支放过；下沉后它落进 packages/core/ 内，如果只比 src/ 就会被误报成
        // "core→core 越界" —— 而它恰恰是**本包自己的**资产，比迁移前更内聚。
        const relToPkgRoot = relative(join(packagesRoot, pkg), abs);
        if (!relToPkgRoot.startsWith("..")) continue;

        // 逃出了本包目录。判断它落到哪个包（可能只是指向仓库根的 package.json 等，那不算）
        const relToPackages = relative(packagesRoot, abs);
        const hit = /^([a-z-]+)\//.exec(relToPackages);
        const toPkg = hit && PACKAGE_RANK[hit[1]!] !== undefined ? hit[1]! : null;
        if (!toPkg) continue; // 指向 packages/ 之外（仓库根文件等），不属边界问题

        edges.set(`${pkg}→${toPkg}`, (edges.get(`${pkg}→${toPkg}`) ?? 0) + 1);
        violations.push({
          file: displayFile,
          line: imp.line,
          fromPkg: pkg,
          toPkg,
          spec: imp.spec,
          isTypeOnly: imp.isTypeOnly,
          kind: "cross-package-relative",
        });
      }
    }
  }
  return { violations, edges, sizes };
}

/**
 * 校验 `packages/<pkg>/tests/` 的包边界（P1-2 测试迁进包之后新增的扫描面）。
 *
 * ## 为什么这里**不**套 rank 规则
 *
 * `scanPackagesMode` 对 `src/` 判两类事：rank 方向 + 相对路径越境。测试只判后者。
 *
 * rank 的意义是「低层不得知道高层的存在，否则单独发包时炸」——这约束的是**产物**。
 * 测试不是产物、不进发布包，而且本仓大量测试**刻意**跨层：`packages/core/tests/` 下
 * 有 13 个文件 import `@sid-code/cli`，比如 `context/context-display-alignment.test.ts`
 * 同时取 core 的压缩阈值与 cli 的 Footer 显示逻辑，断言「展示口径与真实阈值同源」——
 * 这正是 2026-07-29「Footer 显示 17% 却在 82% 压缩」事故的回归测试。
 * 跨层是它的**目的**，套 rank 会把这类守卫判成违规，逼人把测试拆成两半、
 * 从而失去"两层是否一致"这个唯一能钉住的断言。实测若套 rank：28 处立刻变红
 * （core→cli 21 处、shared→core/cli 7 处），全是同类的层间一致性守卫。
 *
 * ## 那为什么相对路径越境仍要管
 *
 * `import "../../core/src/x.ts"` 绕过了 package.json 的 exports 契约，
 * 让依赖在 `bun.lock` / dependencies 里查不到。这一条与"是不是产物"无关：
 * 测试里这么写同样会在包被单独 checkout 时解析失败。修法也很轻——改成 bare specifier。
 */
export function scanPackageTestsMode(packagesRoot: string): {
  violations: PackageViolation[];
  files: number;
} {
  const violations: PackageViolation[] = [];
  let total = 0;

  for (const pkg of PACKAGES) {
    const pkgTests = join(packagesRoot, pkg, "tests");
    let files: string[];
    try {
      files = collectSourceFiles(pkgTests);
    } catch {
      continue; // 该包还没有 tests/ —— 不是错误（tui-renderer 之外都有，但不强制）
    }
    total += files.length;

    for (const file of files) {
      const relInPkg = relative(pkgTests, file);
      const content = readFileSync(file, "utf8");

      for (const imp of extractImports(content)) {
        if (!imp.spec.startsWith(".")) continue; // bare specifier 或 npm 依赖 → 合法
        const abs = resolve(file, "..", imp.spec);

        // 仍在本包内（tests/ 或 src/ 都算）→ 合法
        const relToPkg = relative(join(packagesRoot, pkg), abs);
        if (!relToPkg.startsWith("..")) continue;

        // 逃出了本包。落到别的 package 里才算违规；指向仓库根（tests/ 的预载、
        // scripts/、evals/ 等）不属包边界问题 —— 那类测的是仓库级设施。
        const relToPackages = relative(packagesRoot, abs);
        const hit = /^([a-z-]+)\//.exec(relToPackages);
        const toPkg = hit && PACKAGE_RANK[hit[1]!] !== undefined ? hit[1]! : null;
        if (!toPkg) continue;

        violations.push({
          file: `packages/${pkg}/tests/${relInPkg}`,
          line: imp.line,
          fromPkg: pkg,
          toPkg,
          spec: imp.spec,
          isTypeOnly: imp.isTypeOnly,
          kind: "cross-package-relative",
        });
      }
    }
  }
  return { violations, files: total };
}

if (import.meta.main) {
  // 默认 --packages（分包已完成）。--src 是拆包前的试算模式，需显式指定。
  const useSrcMode = process.argv.includes("--src");
  const root = resolve(import.meta.dir, "..");

  if (!useSrcMode) {
    const { violations, edges, sizes } = scanPackagesMode(join(root, "packages"));

    console.log("=== 包规模 ===");
    for (const pkg of PACKAGES) {
      const s = sizes.get(pkg)!;
      console.log(
        `  ${pkg.padEnd(14)} ${String(s.lines).padStart(7)} 行  ${String(s.files).padStart(4)} 文件`,
      );
    }

    console.log("\n=== 包间边（引用数）===");
    for (const [edge, n] of [...edges.entries()].sort((a, b) => b[1] - a[1])) {
      const [from, to] = edge.split("→");
      const bad = PACKAGE_RANK[from!]! < PACKAGE_RANK[to!]!;
      console.log(`  ${bad ? "❌" : "✅"} ${edge.padEnd(28)} ${n}`);
    }

    console.log(`\n=== 越界依赖：${violations.length} 处 ===`);
    for (const v of violations) {
      console.log(
        `  [${v.kind}] ${v.fromPkg}→${v.toPkg}  ${v.file}:${v.line}  ${v.spec}` +
          `  ${v.isTypeOnly ? "[type]" : "[运行时]"}`,
      );
    }
    if (violations.length === 0) {
      console.log("  ✅ 包边界干净：低 rank 不导入高 rank、无跨包相对路径、无自包 bare 导入。");
    }

    // P1-2：测试迁进包后，测试也要扫。只查相对路径越境，不套 rank
    // （层间一致性守卫刻意跨层，理由见 scanPackageTestsMode 文件注释）。
    const t = scanPackageTestsMode(join(root, "packages"));
    console.log(`\n=== 包内测试（${t.files} 文件）跨包相对路径：${t.violations.length} 处 ===`);
    for (const v of t.violations) {
      console.log(`  [${v.kind}] ${v.fromPkg}→${v.toPkg}  ${v.file}:${v.line}  ${v.spec}`);
    }
    if (t.violations.length === 0) {
      console.log("  ✅ 测试无跨包相对路径（跨包一律走 @sid-code/* bare specifier）。");
    }

    process.exit(violations.length + t.violations.length > 0 ? 1 : 0);
  }

  const srcRoot = join(root, "src");
  const { violations, edges, sizes } = scanSrcMode(srcRoot);

  console.log("=== 包规模 ===");
  for (const [pkg, s] of [...sizes.entries()].sort(
    (a, b) => PACKAGE_RANK[a[0]]! - PACKAGE_RANK[b[0]]!,
  )) {
    console.log(
      `  ${pkg.padEnd(14)} ${String(s.lines).padStart(7)} 行  ${String(s.files).padStart(4)} 文件`,
    );
  }

  console.log("\n=== 包间边（引用数）===");
  for (const [edge, n] of [...edges.entries()].sort((a, b) => b[1] - a[1])) {
    const [from, to] = edge.split("→");
    const bad = PACKAGE_RANK[from!]! < PACKAGE_RANK[to!]!;
    console.log(`  ${bad ? "❌" : "✅"} ${edge.padEnd(28)} ${n}`);
  }

  console.log(`\n=== 越界依赖：${violations.length} 处 ===`);
  const typeOnly = violations.filter((v) => v.isTypeOnly).length;
  for (const v of violations) {
    console.log(
      `  ${v.fromPkg}→${v.toPkg}  ${v.file}:${v.line}  ${v.spec}  ${v.isTypeOnly ? "[type]" : "[运行时]"}`,
    );
  }
  console.log(`\n  其中 import type: ${typeOnly} / ${violations.length}`);
  process.exit(violations.length > 0 ? 1 : 0);
}
