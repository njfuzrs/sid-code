#!/usr/bin/env bun
/**
 * check-real-tasks-pollution.ts —— B6-10 数据污染防护扫描器
 *
 * 用途：
 *   扫描 evals/real-tasks/**\/*.yaml 中是否含 §9.1.1 黑名单字段
 *   （tool_result_content / response_content / patch_content / observation_content / completion_text）
 *   命中 → 退出码 1，列出违规位置，阻止合入。
 *
 * 复用 scripts/eval/lib/security-scan.ts 的 scanContamination
 * （不重复实现关键词，避免漂移）。
 *
 * 使用：
 *   bun run scripts/eval/check-real-tasks-pollution.ts                  # 扫全部
 *   bun run scripts/eval/check-real-tasks-pollution.ts file1.yaml ...   # 扫指定文件（pre-commit 用法）
 *
 * 退出码：
 *   0 = clean
 *   1 = 命中污染
 *   2 = 用法错误 / fs error
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { scanContamination } from "./lib/security-scan.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const REAL_TASKS_DIR = join(REPO_ROOT, "evals", "real-tasks");

function walkYaml(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walkYaml(p, out);
    } else if (st.isFile() && /\.ya?ml$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function scanFile(file: string): string[] {
  const text = readFileSync(file, "utf-8");
  return scanContamination(text);
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  let files: string[];

  if (args.length > 0) {
    // 显式文件列表（pre-commit 用法：只扫 staged 的 yaml）
    files = args.filter((a) => /\.ya?ml$/.test(a)).map((a) => resolve(a));
    files = files.filter((f) => {
      // 仅限 evals/real-tasks/ 路径下；其它 yaml 不在本 hook 管辖
      const norm = f.replace(/\\/g, "/");
      return norm.includes("/evals/real-tasks/");
    });
  } else {
    files = walkYaml(REAL_TASKS_DIR);
  }

  if (files.length === 0) {
    console.log("[pollution-scan] no real-tasks yaml to scan, ok");
    return 0;
  }

  let totalViolations = 0;
  const offenders: { file: string; violations: string[] }[] = [];

  for (const f of files) {
    if (!existsSync(f)) continue;
    const v = scanFile(f);
    if (v.length > 0) {
      offenders.push({ file: f, violations: v });
      totalViolations += v.length;
    }
  }

  if (totalViolations === 0) {
    console.log(`[pollution-scan] ✅ scanned ${files.length} file(s), 0 violations`);
    return 0;
  }

  console.error(`[pollution-scan] ❌ ${totalViolations} contamination hit(s) in ${offenders.length} file(s):`);
  console.error("");
  console.error("§9.1.1 铁律：trajectory-platform 上游 task.yaml 中 tool_result_content /");
  console.error("response_content / patch_content / observation_content / completion_text");
  console.error("是「上一轮 agent 输出」，进入 case yaml 等于让被测 agent 看到答案。");
  console.error("");
  for (const o of offenders) {
    console.error(`  📄 ${o.file.replace(REPO_ROOT + "/", "")}`);
    for (const v of o.violations) {
      console.error(`     - ${v}`);
    }
    console.error("");
  }
  console.error("修复：删除上述字段后重新 commit。如需保留，请改字段名（如改为 reference_answer 并人工审核）。");
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv));
}

export { main, scanFile, walkYaml };
