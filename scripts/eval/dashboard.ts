/**
 * eval:dashboard — 生成 evals/DASHBOARD.md
 *
 * 用法:
 *   bun run eval:dashboard                              # 默认 evals/ 在 cwd
 *   bun run eval:dashboard -- --project-root /path/to   # 指定项目根
 *   bun run eval:dashboard -- --project-name "code-graph"
 *   bun run eval:dashboard -- --output evals/DASHBOARD.md
 *   bun run eval:dashboard -- --include-legacy          # 一并展示旧 grader 版本数据（默认隐藏）
 *
 * 设计:
 *   - 共享脚本,可被 sid-code / code-graph 两项目同时调用
 *   - 只读消费 evals/ 数据(p*-* / _scores / 内联 baseline_scores),不修改任何 case yaml
 *   - 输出单文件 markdown,含 mermaid xychart 折线图与 emoji 状态映射
 *   - 默认按 LATEST_GRADER_VERSION（5d-v2）过滤 baseline 显示——跨 grader 版本总分不可直接比较；
 *     legacy 数据走 --include-legacy 开关（脚注列出被过滤的 legacy 条目数）
 */

import { existsSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { buildProjectSnapshot } from "./lib/yaml-loader";
import { renderDashboard } from "./lib/render";

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "project-root": { type: "string" },
      "project-name": { type: "string" },
      output: { type: "string" },
      "include-legacy": { type: "boolean", default: false },
    },
  });

  const projectRoot = resolveProjectRoot(values["project-root"] as string | undefined);
  const evalsDir = join(projectRoot, "evals");
  if (!existsSync(evalsDir)) {
    console.error(`[eval:dashboard] 未找到 evals/ 目录: ${evalsDir}`);
    process.exit(1);
  }

  const projectName = (values["project-name"] as string | undefined) ?? basename(projectRoot);
  const outputPath = resolveOutput(values.output as string | undefined, evalsDir);
  const includeLegacy = Boolean(values["include-legacy"]);

  const t0 = Date.now();
  const snapshot = buildProjectSnapshot(evalsDir, projectName);
  const md = renderDashboard(snapshot, { includeLegacy });
  writeFileSync(outputPath, md, "utf-8");
  const dt = Date.now() - t0;

  console.log(`[eval:dashboard] 写入 ${outputPath}`);
  console.log(
    `  case=${snapshot.cases.length}  tools=${snapshot.tools.length}  weeks=${snapshot.allWeeks.length}  耗时=${dt}ms${includeLegacy ? "  (include-legacy)" : ""}`,
  );
  if (snapshot.tools.length > 0) {
    console.log(`  tools: ${snapshot.tools.join(", ")}`);
  }
  if (snapshot.allWeeks.length > 0) {
    console.log(`  weeks: w${snapshot.allWeeks[0]} ~ w${snapshot.allWeeks[snapshot.allWeeks.length - 1]}`);
  }
}

function resolveProjectRoot(arg: string | undefined): string {
  if (!arg) return process.cwd();
  return isAbsolute(arg) ? arg : join(process.cwd(), arg);
}

function resolveOutput(arg: string | undefined, evalsDir: string): string {
  if (!arg) return join(evalsDir, "DASHBOARD.md");
  return isAbsolute(arg) ? arg : join(process.cwd(), arg);
}

main();
