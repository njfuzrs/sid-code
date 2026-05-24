#!/usr/bin/env bun
/**
 * baseline cost 公式版本回填工具。
 *
 * 背景：2026-05-24 起 token 公式从 input+output → input+output+cache_creation+cache_read（4 项）
 * 同步把 cost 阈值从 200k/500k/1M 提到 500k/1.5M/3M。旧 baseline_scores 是按 v1 公式打的，
 * 直接重跑会让分数跳变（看起来像模型退化）。本脚本不重跑、不改分，只做：
 *
 *   - 扫描所有 case yaml 的 baseline_scores
 *   - 为没有 _formula_version 字段的条目，写入 _formula_version: { cost: legacy_v1 }
 *   - 给 notes 末尾追加一行 "[cost-formula] v1 (旧公式: 不含 cache; 重跑会跳变)"
 *
 * 这样后续：
 *   - 人看 baseline 能一眼区分新旧公式
 *   - 横向对比工具可以选择跳过 _legacy_v1 行
 *   - 用户用 --sync 重跑后会自然刷成 v2
 *
 * 用法：
 *   bun run evals/scripts/migrate-cost-formula.ts        # 干跑（默认）
 *   bun run evals/scripts/migrate-cost-formula.ts --apply # 实际写入
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as yamlLib from "yaml";

const EVALS_ROOT = resolve(import.meta.dir, "..");
const CASE_DIRS = ["p0-core", "p1-common", "p2-edge", "holdout"];

const apply = process.argv.includes("--apply");

interface MigrationResult {
  caseId: string;
  yamlPath: string;
  providersTouched: string[];
}

async function main() {
  const results: MigrationResult[] = [];

  for (const subdir of CASE_DIRS) {
    const dir = join(EVALS_ROOT, subdir);
    if (!existsSync(dir)) continue;
    const files = await Array.fromAsync(new Bun.Glob("*.yaml").scan(dir));

    for (const f of files) {
      const yamlPath = join(dir, f);
      const content = readFileSync(yamlPath, "utf-8");
      const doc = yamlLib.parseDocument(content);
      const root = doc.contents as yamlLib.YAMLMap;
      if (!root) continue;

      const baselineNode = root.get("baseline_scores") as yamlLib.YAMLMap | undefined;
      if (!baselineNode || !yamlLib.isMap(baselineNode)) continue;

      const touched: string[] = [];

      for (const item of baselineNode.items) {
        const provName = String(item.key);
        const entry = item.value;
        if (!yamlLib.isMap(entry)) continue;

        const formulaVer = entry.get("_formula_version") as yamlLib.YAMLMap | undefined;
        if (formulaVer && yamlLib.isMap(formulaVer) && formulaVer.get("cost")) continue; // 已标记，跳过

        // 只对真正打过分的旧 baseline 标记（score === null 的占位条目跳过）
        const score = entry.get("score");
        if (score === null || score === undefined) continue;

        // 写入 _formula_version: { cost: legacy_v1 }
        const newFormulaVer = doc.createNode({ cost: "legacy_v1" }) as yamlLib.YAMLMap;
        entry.set("_formula_version", newFormulaVer);

        // notes 末尾追加（保持原 notes 不变）
        const oldNotes = entry.get("notes");
        const annotation = "[cost-formula] v1 (旧公式: 不含 cache; 重跑会跳变)";
        const newNotes =
          typeof oldNotes === "string" && oldNotes.length > 0
            ? oldNotes.includes("[cost-formula]") ? oldNotes : `${oldNotes}; ${annotation}`
            : annotation;
        entry.set("notes", newNotes);

        touched.push(provName);
      }

      if (touched.length === 0) continue;

      const caseId = String(root.get("id") || f.replace(/\.yaml$/, ""));
      results.push({ caseId, yamlPath, providersTouched: touched });

      if (apply) {
        writeFileSync(yamlPath, doc.toString(), "utf-8");
      }
    }
  }

  console.log(`扫描完成: ${results.length} 个 case 含旧公式 baseline`);
  for (const r of results) {
    console.log(`  ${r.caseId}: ${r.providersTouched.join(", ")}`);
  }
  console.log("");
  console.log(apply
    ? `✅ 已写入 ${results.length} 个 case yaml 的 _formula_version 标记`
    : `干跑模式：未写入。加 --apply 实际执行；下一步建议用 --sync 重跑后真实刷新分数`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[migrate-cost-formula] fatal:", err);
    process.exit(1);
  });
}
