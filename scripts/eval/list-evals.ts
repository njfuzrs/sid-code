/**
 * eval:list — 列出 evals/ 下所有 case，确认能被识别。
 *
 * 来源: docs/eval/_archive/00-总方案.md §3.5 + _archive/07-执行顺序速查.md §2.4
 *
 * 用法:
 *   bun run eval:list                       # 列出仍在磁盘上的 case（architecture / real-tasks）
 *   bun run eval:list -- --skip-holdout     # 同上（holdout 题面 yaml 已于 2026-09-18 删除）
 *   bun run eval:list -- --priority P0      # 仅 P0
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import yaml from "yaml";

const ROOT = process.cwd();
const CASE_ROOTS = ["evals/architecture", "evals/real-tasks"];

function walkYaml(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "scripts") continue;
      walkYaml(p, out);
    } else if (st.isFile() && name.endsWith(".yaml")) {
      out.push(p);
    }
  }
  return out;
}

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
  for (const root of CASE_ROOTS) {
    for (const p of walkYaml(join(ROOT, root))) {
      const data = yaml.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
      out.push({
        id: String(data.id ?? p.replace(/.*\//, "").replace(/\.yaml$/, "")),
        category: String(data.category ?? "?"),
        priority: String(data.priority ?? "?"),
        holdout: Boolean(data.holdout),
        target_score: Number(data.target_score ?? 0),
        dir: root,
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
  console.log(["ID", "Pri", "Hold", "Tgt", "Category", "Subsystem", "Source"].join("\t"));
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
  console.log(
    "汇总: " +
      Object.entries(summary)
        .map(([k, v]) => `${k}=${v}`)
        .join("  "),
  );
}

main();
