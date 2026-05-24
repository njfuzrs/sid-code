#!/usr/bin/env bun
/**
 * baseline cost 公式版本回填工具。
 *
 * 版本演进：
 *   v1（~2026-05-24）: input+output 累加，阈值 200k/500k/1M
 *   v2（2026-05-24~25）: 4 项全累加，阈值 500k/1.5M/3M（input 仍是 N² 过计数）
 *   v3（2026-05-25 起）: input 取 last，其它累加，阈值 200k/500k/1.5M（实测校准）
 *
 * 本脚本：扫描所有 case yaml 的 baseline_scores，给所有非 v3 的 entry：
 *   - 写入 _formula_version: { cost: legacy }（保留原有 v1/v2 标记）
 *   - 在 notes 顶部插入显眼警告
 *
 * 诚实原则：
 *   - 不计算新公式的 score（那是 --sync 重跑的事）
 *   - 不删除旧 score（保留历史，便于追溯）
 *   - 但要让旧 score 不可被误读为 v3：通过明显的版本标记 + notes 警告
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

const LEGACY_WARNING = "⚠️ legacy cost 公式: score/cost 字段为旧公式（v1: input+output 累加 / v2: 4 项累加 input 含 N² 过计数, 阈值 500k 系列）产物, 与 v3 (input 取 last + 其它累加, 阈值 200k/500k/1.5M, 已校准) 不可直接比较; --sync 重跑后会刷成 v3 真实值";
const CURRENT_FORMULA_VERSION = "v3";

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

        // 当前公式版本的 entry 跳过
        if (existingCostVer === CURRENT_FORMULA_VERSION) continue;

        const oldNotes = entry.get("notes");
        const oldStr = typeof oldNotes === "string" ? oldNotes : "";
        const alreadyHasNewWarning = oldStr.startsWith(LEGACY_WARNING);
        const alreadyMarkedLegacy = existingCostVer === "legacy_v1" || existingCostVer === "legacy_v2";

        // 已经完整迁移过（标记 + 新警告齐全）：跳过
        if (alreadyMarkedLegacy && alreadyHasNewWarning) continue;

        // 写入/覆盖 _formula_version（保留具体旧版本号便于追溯）
        if (!alreadyMarkedLegacy) {
          const legacyTag = existingCostVer === "v2" ? "legacy_v2" : "legacy_v1";
          const newFormulaVer = doc.createNode({ cost: legacyTag }) as yamlLib.YAMLMap;
          entry.set("_formula_version", newFormulaVer);
        }

        // notes：清理旧风格的 [cost-formula] 标记残留，把新警告放最前面
        if (!alreadyHasNewWarning) {
          const cleaned = oldStr
            .replace(/;?\s*\[cost-formula\][^;]*/g, "")
            .replace(/⚠️ legacy_v1:[^;]*;?\s*/g, "")
            .trim();
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
    : `干跑模式：未写入。加 --apply 实际执行；下一步用 --sync 重跑后真实刷新分数`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[migrate-cost-formula] fatal:", err);
    process.exit(1);
  });
}
