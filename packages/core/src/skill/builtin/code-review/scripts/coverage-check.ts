#!/usr/bin/env bun
/**
 * coverage-check.ts — code-review Skill 确定性脚本
 *
 * 输入：变更函数列表 + 仓库路径
 * 输出：结构化测试覆盖状态 JSON
 *
 * 实现策略（Step 4 骨架）：
 *   1. 对每个变更函数（functionName / className.method），grep 测试目录
 *   2. 找到匹配 → covered=true
 *   3. 找不到 → suggested_path（按测试目录约定）
 *
 * 注意：本脚本基于 grep 函数名匹配，**粗糙**——M3+ ont_008 tested-by LinkType 落地后强化。
 * 由 RFC-001 §2.5 / SKILL.md §6.1 定义。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename, dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";

interface CoverageResult {
  change: string;
  covered: boolean;
  testFile?: string;
  testLine?: number;
  suggestedPath?: string;
}

const TEST_DIR_CANDIDATES = ["tests", "test", "__tests__", "spec"];
const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /_test\.go$/,
  /^test_.*\.py$/,
  /\.test\.py$/,
];

function listTestFiles(repoDir: string): string[] {
  const out: string[] = [];

  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      try {
        const stat = statSync(p);
        if (stat.isDirectory()) {
          if (entry === "node_modules" || entry === ".git" || entry.startsWith(".")) continue;
          walk(p);
        } else if (TEST_FILE_PATTERNS.some((r) => r.test(entry))) {
          out.push(relative(repoDir, p));
        }
      } catch {
        // ignore unreadable
      }
    }
  }

  for (const root of TEST_DIR_CANDIDATES) {
    walk(join(repoDir, root));
  }
  walk(join(repoDir, "src"));
  return out;
}

function findCoverage(
  funcName: string,
  testFiles: string[],
  repoDir: string,
): { file?: string; line?: number } {
  for (const tf of testFiles) {
    try {
      const out = execSync(
        `grep -nE "${funcName}\\(|describe\\(.*${funcName}|test\\(.*${funcName}|it\\(.*${funcName}" "${join(repoDir, tf)}" 2>/dev/null | head -1`,
        {
          encoding: "utf-8",
        },
      ).trim();
      if (out) {
        const m = out.match(/^(\d+):/);
        return { file: tf, line: m ? parseInt(m[1], 10) : 1 };
      }
    } catch {
      // grep no match exits 1, ignore
    }
  }
  return {};
}

function suggestTestPath(filePath: string, repoDir: string): string {
  const fileBase = basename(filePath).replace(/\.[^.]+$/, "");
  const fileExt = filePath.match(/\.[^.]+$/)?.[0] ?? ".ts";

  if (existsSync(join(repoDir, "tests"))) {
    const subPath = filePath.replace(/^src\//, "");
    const subDir = dirname(subPath);
    return `tests/${subDir}/${fileBase}.test${fileExt}`;
  }
  return `${dirname(filePath)}/${fileBase}.test${fileExt}`;
}

export function checkCoverage(
  changes: Array<{ funcName: string; filePath: string }>,
  repoDir: string,
): CoverageResult[] {
  const testFiles = listTestFiles(repoDir);
  const results: CoverageResult[] = [];

  for (const change of changes) {
    const found = findCoverage(change.funcName, testFiles, repoDir);
    results.push({
      change: `${change.filePath}:${change.funcName}`,
      covered: !!found.file,
      testFile: found.file,
      testLine: found.line,
      suggestedPath: found.file ? undefined : suggestTestPath(change.filePath, repoDir),
    });
  }

  return results;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: "string", short: "r" },
      func: { type: "string", short: "f", multiple: true },
      file: { type: "string", multiple: true },
    },
    allowPositionals: false,
  });

  const repoDir = resolve(values.repo ?? process.cwd());
  const funcs = values.func ?? [];
  const files = values.file ?? [];

  const changes: Array<{ funcName: string; filePath: string }> = [];
  for (let i = 0; i < funcs.length; i++) {
    changes.push({ funcName: funcs[i], filePath: files[i] ?? "unknown" });
  }

  const results = checkCoverage(changes, repoDir);
  console.log(JSON.stringify(results, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
