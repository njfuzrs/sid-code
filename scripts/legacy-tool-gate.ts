#!/usr/bin/env bun
/**
 * 工具接口棘轮门禁：引用旧接口 `LegacyTool` / `LegacyToolResult` 的生产文件数只允许减少。
 *
 * ## 为什么需要它
 *
 * 工具接口新旧并存（新 `Tool` + `buildTool()`，旧 `LegacyTool`），迁移从接入起停在
 * 「只有 think 一个采用者」。`command-system-gate` 的 G2 已经证明了同一件事：
 * **门禁只防新增、不推动减少时，存量数字会一直不动**；而没有门禁时更糟，
 * 新工具照抄周边的 `import { LegacyTool as Tool }` 写法，旧接口的面只会变大。
 *
 * 所以这道门禁只说一句话：那个文件数只能降，不能升。终点是 0（删掉 `LegacyTool` 与
 * `tool/bridge.ts`）。
 *
 * ## 口径（每一条都对应一个会让门禁恒绿的错误写法）
 *
 * - **按标识符计，不按 `implements LegacyTool` 计**：全仓没有一处 `implements`，
 *   工具文件普遍写 `import { LegacyTool as Tool }`。按 `implements` 数恒为 0，门禁恒绿。
 * - **`LegacyToolResult` 也算**：只导入结果类型的文件同样依赖旧接口形态。
 * - **词边界**：`toLegacyTool`（bridge 的函数名）不是对旧接口类型的依赖，不能算。
 * - **注释不算**：注释里提一句「LegacyTool」不构成依赖，算进去会让「删干净了代码、
 *   留着解释性注释」的文件永远减不下来，逼人删有用的注释。
 * - **测试不算**：测试文件跟着被测对象走，迁移完成时自然消失；算进去只会让基线噪声变大。
 *
 * ## 用法
 *
 *   bun run scripts/legacy-tool-gate.ts                    # 校验（超基线退 1）
 *   bun run scripts/legacy-tool-gate.ts --report           # 只打印现状与清单
 *   bun run scripts/legacy-tool-gate.ts --update-baseline  # 迁完几个工具后收紧基线
 *
 * ⚠️ `--update-baseline` **只允许收紧**。允许放宽，棘轮就成了摆设：
 * 新写一个旧接口工具、顺手把数字调高，全程绿。
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const BASELINE_PATH = join(import.meta.dir, "legacy-tool-gate.baseline.json");

/** 旧接口标识符。词边界排除 `toLegacyTool` 这类只是名字里含它的符号 */
const LEGACY_IDENT_RE = /\bLegacyTool(?:Result)?\b/;

interface Baseline {
  /** 引用旧接口的生产文件数上限 */
  legacyToolFiles: number;
  /** 记录基线是怎么来的，便于下一个人判断能不能动 */
  note: string;
}

export interface SourceFile {
  path: string;
  source: string;
}

function isTestPath(relPath: string): boolean {
  return /\.test\.tsx?$/.test(relPath) || relPath.split("/").includes("tests");
}

/** 列出 `packages/<pkg>/src/` 下全部 .ts / .tsx 生产文件（仓库相对路径）。 */
function listProductionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      const rel = relative(ROOT, full);
      if (!isTestPath(rel)) out.push(rel);
    }
  };
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const src = join(PACKAGES_DIR, pkg, "src");
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // 没有 src/ 的包（纯数据 / 文档）跳过
    }
  }
  return out.sort();
}

/**
 * 去掉注释后判断文件是否在代码里引用旧接口。
 *
 * 用一个小状态机处理块注释（含跨行 JSDoc）与行注释；字符串字面量里的 `//` 会被当成
 * 注释起点而少算——少算只会让结论偏向「已不依赖」，但生产代码里不存在
 * 「把 LegacyTool 写进字符串」的用法，这个偏差在当前仓里为 0，换实现复杂度不值。
 */
export function referencesLegacyTool(source: string): boolean {
  let inBlock = false;
  for (const rawLine of source.split("\n")) {
    let line = rawLine;
    let code = "";
    while (line.length > 0) {
      if (inBlock) {
        const end = line.indexOf("*/");
        if (end === -1) {
          line = "";
          break;
        }
        inBlock = false;
        line = line.slice(end + 2);
        continue;
      }
      const block = line.indexOf("/*");
      const lineComment = line.indexOf("//");
      if (lineComment !== -1 && (block === -1 || lineComment < block)) {
        code += line.slice(0, lineComment);
        break;
      }
      if (block !== -1) {
        code += line.slice(0, block);
        inBlock = true;
        line = line.slice(block + 2);
        continue;
      }
      code += line;
      break;
    }
    if (LEGACY_IDENT_RE.test(code)) return true;
  }
  return false;
}

/** 在给定文件集合里找出引用旧接口的生产文件。纯函数，供测试做变异自证。 */
export function findLegacyToolFiles(files: SourceFile[]): string[] {
  return files
    .filter((f) => !isTestPath(f.path) && referencesLegacyTool(f.source))
    .map((f) => f.path)
    .sort();
}

/** 扫真实仓库。 */
export function scanRepo(): string[] {
  const files = listProductionFiles().map((p) => ({
    path: p,
    source: readFileSync(join(ROOT, p), "utf8"),
  }));
  return findLegacyToolFiles(files);
}

export function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

function main(): void {
  const args = process.argv.slice(2);
  const report = args.includes("--report");
  const update = args.includes("--update-baseline");

  const hits = scanRepo();
  const baseline = readBaseline();

  console.log("工具接口棘轮门禁");
  console.log(`  引用 LegacyTool 的生产文件: ${hits.length}  基线 ${baseline.legacyToolFiles}`);
  if (report) {
    for (const h of hits) console.log(`    - ${h}`);
    return;
  }

  if (update) {
    if (hits.length > baseline.legacyToolFiles) {
      console.error("\n✗ --update-baseline 只允许收紧（新值必须 ≤ 旧值）。");
      console.error("  放宽基线等于取消门禁：新写一个旧接口工具、顺手调高数字，全程绿。");
      process.exit(1);
    }
    writeFileSync(
      BASELINE_PATH,
      JSON.stringify({ legacyToolFiles: hits.length, note: baseline.note }, null, 2) + "\n",
    );
    console.log("\n✓ 基线已收紧。");
    return;
  }

  if (hits.length > baseline.legacyToolFiles) {
    console.error(
      `\n✗ 引用旧接口的生产文件从 ${baseline.legacyToolFiles} 增至 ${hits.length}。` +
        `\n  新工具请用 buildTool() 写成 Tool<Input, Output>，直接 registry.register(tool)` +
        `\n  （注册表会经 tool/bridge.ts 归一），不要照抄 \`import { LegacyTool as Tool }\`。` +
        `\n  清单：bun run scripts/legacy-tool-gate.ts --report`,
    );
    process.exit(1);
  }
  if (hits.length < baseline.legacyToolFiles) {
    console.log(
      `\n  实测低于基线 ${baseline.legacyToolFiles - hits.length} 个 —— 跑 --update-baseline 收紧，` +
        `否则这段余量会被下一个新增的旧接口文件悄悄吃掉。`,
    );
  }
  console.log("\n✓ 工具接口棘轮通过。");
}

if (import.meta.main) main();
