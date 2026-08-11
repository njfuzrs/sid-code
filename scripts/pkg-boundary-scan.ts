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
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** 包的层级 rank：低 rank 不得导入高 rank。 */
export const PACKAGE_RANK: Record<string, number> = {
  "tui-renderer": 0,
  shared: 1,
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

if (import.meta.main) {
  const srcRoot = resolve(import.meta.dir, "..", "src");
  const { violations, edges, sizes } = scanSrcMode(srcRoot);

  console.log("=== 包规模 ===");
  for (const [pkg, s] of [...sizes.entries()].sort(
    (a, b) => PACKAGE_RANK[a[0]]! - PACKAGE_RANK[b[0]]!,
  )) {
    console.log(`  ${pkg.padEnd(14)} ${String(s.lines).padStart(7)} 行  ${String(s.files).padStart(4)} 文件`);
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
