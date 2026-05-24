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
 *   - 在 notes 顶部插入显眼警告："⚠️ legacy_v1：score 字段也是旧公式产物..."
 *
 * 本脚本"诚实"原则：
 *   - 不计算新公式的 score（那是 --sync 重跑的事，不是 migrate 的事）
 *   - 不删除旧 score（保留历史，便于追溯）
 *   - 但要让旧 score 不可被误读为 v2：通过明显的版本标记 + notes 警告
 *
 * 配套：
 *   - eval-runner.ts 的 syncBaselineScores 会在 --sync 重跑时把 _formula_version 刷为 v2
 *   - 横向对比工具（dashboard 等）应过滤 legacy_v1 entry 或单独标注
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

// 显眼版本警告：贴在 notes 最前面，确保即便快速浏览也能看到
const LEGACY_WARNING = "⚠️ legacy_v1: score/cost 字段为 v1 公式（不含 cache, 阈值 200k/500k/1M）产物, 与 v2 (含 cache, 500k/1.5M/3M) 不可直接比较; --sync 重跑后会刷成 v2 真实值";
const COST_FORMULA_V2 = "v2";

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

        // 只对真正打过分的旧 baseline 标记（score === null 的占位条目跳过）
        const score = entry.get("score");
        if (score === null || score === undefined) continue;

        const formulaVer = entry.get("_formula_version") as yamlLib.YAMLMap | undefined;
        const existingCostVer =
          formulaVer && yamlLib.isMap(formulaVer)
            ? String(formulaVer.get("cost") ?? "")
            : "";

        // v2 entry 跳过（新公式产物，无需打警告）
        if (existingCostVer === "v2" || existingCostVer === COST_FORMULA_V2) continue;

        const oldNotes = entry.get("notes");
        const oldStr = typeof oldNotes === "string" ? oldNotes : "";
        const alreadyHasNewWarning = oldStr.startsWith(LEGACY_WARNING);
        const alreadyMarkedLegacy = existingCostVer === "legacy_v1";

        // 已经完整迁移过（标记 + 新警告齐全）：跳过
        if (alreadyMarkedLegacy && alreadyHasNewWarning) continue;

        // 写入/覆盖 _formula_version
        if (!alreadyMarkedLegacy) {
          const newFormulaVer = doc.createNode({ cost: "legacy_v1" }) as yamlLib.YAMLMap;
          entry.set("_formula_version", newFormulaVer);
        }

        // notes：清理旧风格的 [cost-formula] 标记残留，把新警告放最前面
        if (!alreadyHasNewWarning) {
          const cleaned = oldStr.replace(/;?\s*\[cost-formula\][^;]*/g, "").trim();
          const newNotes = cleaned ? `${LEGACY_WARNING}; ${cleaned}` : LEGACY_WARNING;
          entry.set("notes", newNotes);
        }

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
    ? `✅ 已写入 ${results.length} 个 case yaml 的 _formula_version 标记 + notes 头部警告`
    : `干跑模式：未写入。加 --apply 实际执行；下一步建议用 --sync 重跑后真实刷新分数`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[migrate-cost-formula] fatal:", err);
    process.exit(1);
  });
}
