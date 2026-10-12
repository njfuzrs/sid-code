#!/usr/bin/env bun
/**
 * parse-diff.ts — code-review Skill 确定性脚本
 *
 * 输入：unified diff 内容（stdin 或 --file <path>）
 * 输出：结构化 JSON to stdout
 *   {
 *     files: [
 *       { path, language, hunks: [{ oldStart, oldLines, newStart, newLines }],
 *         addedLines: number, removedLines: number, isBinary, isDocOnly }
 *     ],
 *     summary: { totalFiles, totalAdded, totalRemoved, allDocsOnly, allBinary }
 *   }
 *
 * 用途：让 Skill 在调用 LLM 前，先用确定性方式获取变更范围。
 *
 * 由 RFC-001 §2.4 / SKILL.md §6.1 定义。
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface DiffFile {
  path: string;
  language: string;
  hunks: DiffHunk[];
  addedLines: number;
  removedLines: number;
  isBinary: boolean;
  isDocOnly: boolean;
}

export interface DiffSummary {
  totalFiles: number;
  totalAdded: number;
  totalRemoved: number;
  allDocsOnly: boolean;
  allBinary: boolean;
}

export interface ParsedDiff {
  files: DiffFile[];
  summary: DiffSummary;
}

const DOC_EXTENSIONS = new Set([".md", ".rst", ".txt", ".adoc"]);
const DOC_DIR_PREFIXES = ["docs/", "doc/", "documentation/"];

function detectLanguage(path: string): string {
  const ext = path.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".cpp": "cpp",
    ".c": "c",
    ".rb": "ruby",
    ".md": "markdown",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".json": "json",
    ".sh": "shell",
  };
  return map[ext] ?? "unknown";
}

function isDocFile(path: string): boolean {
  const ext = path.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? "";
  if (DOC_EXTENSIONS.has(ext)) return true;
  return DOC_DIR_PREFIXES.some((p) => path.startsWith(p));
}

export function parseDiff(diffText: string): ParsedDiff {
  const lines = diffText.split("\n");
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      const match = line.match(/^diff --git a\/(.*?) b\/(.*?)$/);
      const path = match ? match[2] : line.replace(/^diff --git /, "");
      current = {
        path,
        language: detectLanguage(path),
        hunks: [],
        addedLines: 0,
        removedLines: 0,
        isBinary: false,
        isDocOnly: isDocFile(path),
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("Binary files")) {
      current.isBinary = true;
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      current.hunks.push({
        oldStart: parseInt(hunkMatch[1], 10),
        oldLines: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newLines: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
      });
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) current.addedLines += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) current.removedLines += 1;
  }

  if (current) files.push(current);

  const totalFiles = files.length;
  const totalAdded = files.reduce((s, f) => s + f.addedLines, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removedLines, 0);
  const allDocsOnly = totalFiles > 0 && files.every((f) => f.isDocOnly && !f.isBinary);
  const allBinary = totalFiles > 0 && files.every((f) => f.isBinary);

  return { files, summary: { totalFiles, totalAdded, totalRemoved, allDocsOnly, allBinary } };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { file: { type: "string", short: "f" } },
    allowPositionals: false,
  });

  let diffText: string;
  if (values.file) {
    diffText = readFileSync(values.file, "utf-8");
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    diffText = Buffer.concat(chunks).toString("utf-8");
  }

  const result = parseDiff(diffText);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
