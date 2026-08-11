#!/usr/bin/env bun
/**
 * lint-diff.ts — code-review Skill 确定性脚本
 *
 * 输入：unified diff（或 PR 文件列表）
 * 输出：结构化 lint findings JSON
 *
 * 执行策略：
 *   1. 解析 diff 找到变更文件
 *   2. 检测项目本身的 lint 配置（eslint.config / .eslintrc / tsconfig.json）
 *   3. 调用对应 lint 工具 only on changed files
 *   4. 解析输出为 finding 列表
 *
 * 当前是 Step 4 骨架实现：仅做"识别 lint 配置 + 列出可用 linter"，
 * 实际跑 lint 留给 Skill agent 通过 bash 工具调用。
 *
 * 由 RFC-001 §2.4 / SKILL.md §6.1 定义。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

interface LintConfig {
  type: "eslint" | "tsc" | "ruff" | "golangci-lint" | "rustfmt" | "unknown";
  configFile?: string;
  command?: string;
  available: boolean;
}

export function detectLintConfigs(repoDir: string): LintConfig[] {
  const configs: LintConfig[] = [];

  const eslintCandidates = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.ts",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.json",
    ".eslintrc.yaml",
  ];
  for (const c of eslintCandidates) {
    if (existsSync(resolve(repoDir, c))) {
      configs.push({
        type: "eslint",
        configFile: c,
        command: `npx eslint --no-error-on-unmatched-pattern --format json`,
        available: true,
      });
      break;
    }
  }

  if (existsSync(resolve(repoDir, "tsconfig.json"))) {
    configs.push({
      type: "tsc",
      configFile: "tsconfig.json",
      command: `npx tsc --noEmit`,
      available: true,
    });
  }

  if (
    existsSync(resolve(repoDir, "pyproject.toml")) ||
    existsSync(resolve(repoDir, "ruff.toml"))
  ) {
    configs.push({
      type: "ruff",
      configFile: existsSync(resolve(repoDir, "ruff.toml")) ? "ruff.toml" : "pyproject.toml",
      command: `ruff check --output-format json`,
      available: true,
    });
  }

  if (existsSync(resolve(repoDir, ".golangci.yml")) || existsSync(resolve(repoDir, ".golangci.yaml"))) {
    configs.push({
      type: "golangci-lint",
      configFile: existsSync(resolve(repoDir, ".golangci.yml")) ? ".golangci.yml" : ".golangci.yaml",
      command: `golangci-lint run --out-format json`,
      available: true,
    });
  }

  if (existsSync(resolve(repoDir, "rustfmt.toml")) || existsSync(resolve(repoDir, "Cargo.toml"))) {
    configs.push({
      type: "rustfmt",
      configFile: existsSync(resolve(repoDir, "rustfmt.toml")) ? "rustfmt.toml" : "Cargo.toml",
      command: `cargo fmt --check`,
      available: true,
    });
  }

  return configs;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { repo: { type: "string", short: "r" } },
    allowPositionals: false,
  });

  const repoDir = values.repo ?? process.cwd();
  const configs = detectLintConfigs(repoDir);

  console.log(
    JSON.stringify(
      {
        repoDir,
        detectedLinters: configs,
        instruction:
          "Skill agent should call bash tool to run each linter on changed files only. Never run lint on full repo (cost concern).",
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
