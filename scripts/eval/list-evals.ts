/**
 * eval:list — 列出 evals/ 下所有 case，确认能被识别。
 *
 * 来源: docs/eval/00-总方案.md §3.5 + 07-执行顺序速查.md §2.4
 *
 * 用法:
 *   bun run eval:list                       # 全部（含 holdout）
 *   bun run eval:list -- --skip-holdout     # 仅日常池（20 条）
 *   bun run eval:list -- --priority P0      # 仅 P0
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import yaml from "yaml";

const ROOT = process.cwd();
const CASE_DIRS = ["evals/p0-core", "evals/p1-common", "evals/p2-edge", "evals/holdout"];

interface CaseSummary {
  id: string;
  category: string;
  priority: string;
  holdout: boolean;
  target_score: number;
  dir: string;
  source: string;
  related_subsystem: string[];
}

function loadCases(): CaseSummary[] {
  const out: CaseSummary[] = [];
  for (const dir of CASE_DIRS) {
    const abs = join(ROOT, dir);
    let entries: string[] = [];
    try {
      entries = readdirSync(abs).filter((f) => f.startsWith("case_") && f.endsWith(".yaml"));
    } catch {
      continue;
    }
    for (const f of entries) {
      const p = join(abs, f);
      if (!statSync(p).isFile()) continue;
      const data = yaml.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
      out.push({
        id: String(data.id ?? f.replace(/\.yaml$/, "")),
        category: String(data.category ?? "?"),
        priority: String(data.priority ?? "?"),
        holdout: Boolean(data.holdout),
        target_score: Number(data.target_score ?? 0),
        dir,
        source: String(data.source ?? "?"),
        related_subsystem: Array.isArray(data.related_subsystem)
          ? (data.related_subsystem as string[])
          : [],
      });
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "skip-holdout": { type: "boolean" },
      priority: { type: "string" },
      json: { type: "boolean" },
    },
  });

  const skipHoldout = Boolean(values["skip-holdout"]);
  const priority = values.priority as string | undefined;

  let cases = loadCases();
  if (skipHoldout) cases = cases.filter((c) => !c.holdout);
  if (priority) cases = cases.filter((c) => c.priority === priority);

  if (values.json) {
    console.log(JSON.stringify(cases, null, 2));
    return;
  }

  console.log(`# evals/ 中识别到 ${cases.length} 条 case`);
  if (skipHoldout) console.log("# (已排除 holdout)");
  if (priority) console.log(`# (filter: priority=${priority})`);
  console.log();
  console.log(
    ["ID", "Pri", "Hold", "Tgt", "Category", "Subsystem", "Source"].join("\t"),
  );
  console.log("─".repeat(100));
  for (const c of cases) {
    console.log(
      [
        c.id,
        c.priority,
        c.holdout ? "Y" : "-",
        c.target_score.toFixed(1),
        c.category,
        c.related_subsystem.slice(0, 3).join(","),
        c.source,
      ].join("\t"),
    );
  }
  console.log();
  // 汇总
  const summary = cases.reduce<Record<string, number>>((acc, c) => {
    const k = c.holdout ? "holdout" : c.priority;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  console.log("汇总: " + Object.entries(summary).map(([k, v]) => `${k}=${v}`).join("  "));
}

main();
