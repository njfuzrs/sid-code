/**
 * eval:new-case — 用 _template.yaml 创建新 case。
 *
 * 用法:
 *   bun run eval:new-case -- --priority P0 --category 代码理解
 *   bun run eval:new-case -- --priority P1 --id case_026
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = process.cwd();
const TEMPLATE = join(ROOT, "evals/_template.yaml");
const PRIO_DIR: Record<string, string> = {
  P0: "evals/general/p0-core",
  P1: "evals/general/p1-common",
  P2: "evals/general/p2-edge",
};

function nextId(): string {
  let max = 0;
  for (const dir of Object.values(PRIO_DIR).concat(["evals/holdout"])) {
    const abs = join(ROOT, dir);
    let entries: string[] = [];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const f of entries) {
      const m = f.match(/^case_(\d{3})\.yaml$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return `case_${String(max + 1).padStart(3, "0")}`;
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      priority: { type: "string" },
      category: { type: "string" },
      id: { type: "string" },
    },
  });

  const priority = (values.priority as string) ?? "P0";
  const category = (values.category as string) ?? "";
  const id = (values.id as string) ?? nextId();

  if (!PRIO_DIR[priority]) {
    console.error(`[ERROR] priority 必须是 P0/P1/P2，收到: ${priority}`);
    process.exit(1);
  }
  const targetDir = PRIO_DIR[priority];
  const targetFile = join(ROOT, targetDir, `${id}.yaml`);
  if (existsSync(targetFile)) {
    console.error(`[ERROR] ${targetFile} 已存在`);
    process.exit(1);
  }

  copyFileSync(TEMPLATE, targetFile);
  let text = readFileSync(targetFile, "utf-8");
  text = text.replace(/^id: case_NNN.*$/m, `id: ${id}`);
  text = text.replace(/^priority: P0.*$/m, `priority: ${priority}`);
  if (category) text = text.replace(/^category: ""/m, `category: "${category}"`);
  text = text.replace(/^created_date: 2026-MM-DD/m, `created_date: ${new Date().toISOString().slice(0, 10)}`);
  // P1=3.5, P2=3.0
  if (priority === "P1") text = text.replace(/^target_score: 4\.0/m, "target_score: 3.5");
  if (priority === "P2") text = text.replace(/^target_score: 4\.0/m, "target_score: 3.0");

  writeFileSync(targetFile, text, "utf-8");
  console.log(`[OK] 创建 ${targetFile}`);
  console.log(`[NEXT] 编辑 ${targetFile} 填 input.user_query / expected.must_include_any_of`);
}

main();
