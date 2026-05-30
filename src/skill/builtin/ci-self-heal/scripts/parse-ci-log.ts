#!/usr/bin/env bun
/**
 * parse-ci-log.ts — ci-self-heal Skill 确定性脚本
 *
 * 输入: CI log 文本(stdin 或 --file <path>)
 * 输出: 结构化 JSON to stdout
 *   {
 *     runner: "jest" | "vitest" | "pytest" | "go-test" | "tsc" | "eslint" | "cargo" | "unknown",
 *     stackTraces: [{ frames: [{file, line, fn?}], errorMessage }],
 *     failedAssertions: [{ file?, line?, expected?, actual?, message }],
 *     fileRefs: [{ file, line }],   // 去重
 *     errorMessages: string[],      // 顶级错误
 *     hasRetryMarkers: boolean      // flaky 信号
 *   }
 *
 * 用途: 让 Skill 在调用 LLM 前, 用确定性方式抽取 CI log 结构化信息.
 *
 * 由 RFC-002 §2.4 / SKILL.md §3.1 定义.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export interface StackFrame {
  file: string;
  line: number;
  fn?: string;
}

export interface StackTrace {
  frames: StackFrame[];
  errorMessage: string;
}

export interface FailedAssertion {
  file?: string;
  line?: number;
  expected?: string;
  actual?: string;
  message: string;
}

export interface FileRef {
  file: string;
  line: number;
}

export type CIRunner =
  | "jest"
  | "vitest"
  | "pytest"
  | "go-test"
  | "tsc"
  | "eslint"
  | "cargo"
  | "bun-test"
  | "mocha"
  | "unknown";

export interface ParsedCILog {
  runner: CIRunner;
  stackTraces: StackTrace[];
  failedAssertions: FailedAssertion[];
  fileRefs: FileRef[];
  errorMessages: string[];
  hasRetryMarkers: boolean;
}

/**
 * 通过 log 内容启发式识别 runner.
 * 多 runner 命中时按"信号最强"取——pytest 和 jest 信号都强时优先 pytest.
 */
function detectRunner(log: string): CIRunner {
  // 顺序敏感: 先匹配特征强的(独有标记)
  if (/PASS|FAIL\s+.*\.(test|spec)\.(ts|tsx|js|jsx)/i.test(log) && /at Object\.<anonymous>|jest\.fn/.test(log)) return "jest";
  if (/✓|✗|×|expect\(.*\)\.to|describe\s*\(/i.test(log) && /vitest|vite\.config/.test(log)) return "vitest";
  if (/=+ FAILURES =+|=+ short test summary info =+|^_____ /m.test(log)) return "pytest";
  if (/^FAIL|^ok\s+\d|^---\s*FAIL:|^=== RUN/m.test(log) && /\.go:\d+/.test(log)) return "go-test";
  if (/error TS\d{4}:/.test(log)) return "tsc";
  if (/\d+:\d+\s+(error|warning)\s+/.test(log) && /eslint/i.test(log)) return "eslint";
  if (/error\[E\d+\]:|warning:.*-->.*\.rs:\d+/.test(log)) return "cargo";
  if (/(?:bun test|bun:test)/.test(log) || /\(pass\)|\(fail\)/.test(log)) return "bun-test";
  if (/passing\s*\(\d|failing\s*\(\d|mocha/.test(log)) return "mocha";
  return "unknown";
}

/**
 * 抽取所有 file:line 引用, 去重.
 * 支持多种格式:
 *   /abs/path/file.ts:42
 *   relative/path.py:100
 *   at fn (file.ts:42:5)
 *   File "file.py", line 42
 *   file.go:42:5
 *   --> src/main.rs:10:5
 */
function extractFileRefs(log: string): FileRef[] {
  const refs = new Map<string, FileRef>();

  // 通用 file:line 格式(支持 file:line:col)
  const generic = /(?:^|[\s(])([\w./_-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cpp|c|rb|sh|md|yaml|yml|json))(?::|, line\s+)(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = generic.exec(log)) !== null) {
    const file = m[1];
    const line = parseInt(m[2], 10);
    const key = `${file}:${line}`;
    if (!refs.has(key)) refs.set(key, { file, line });
  }

  // Python File "path", line N 格式
  const py = /File\s+"([^"]+)",\s+line\s+(\d+)/g;
  while ((m = py.exec(log)) !== null) {
    const file = m[1];
    const line = parseInt(m[2], 10);
    const key = `${file}:${line}`;
    if (!refs.has(key)) refs.set(key, { file, line });
  }

  // Rust --> path:line:col 格式
  const rust = /-->\s+([\w./_-]+\.rs):(\d+)/g;
  while ((m = rust.exec(log)) !== null) {
    const file = m[1];
    const line = parseInt(m[2], 10);
    const key = `${file}:${line}`;
    if (!refs.has(key)) refs.set(key, { file, line });
  }

  return Array.from(refs.values());
}

/**
 * 抽取 stack trace.
 * 简化策略: 把含 "Error:" / "Exception" 行作为错误消息, 其后连续的 "at " / 缩进行作为 frames.
 * 单个 trace 不超过 30 frames(防 log 异常爆炸).
 */
function extractStackTraces(log: string): StackTrace[] {
  const traces: StackTrace[] = [];
  const lines = log.split("\n");
  const MAX_FRAMES = 30;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const errorMatch = line.match(/^([^:]*(?:Error|Exception|FAIL|panic):.+)$/);
    if (!errorMatch) continue;

    const errorMessage = errorMatch[1].trim();
    const frames: StackFrame[] = [];

    for (let j = i + 1; j < Math.min(lines.length, i + MAX_FRAMES + 1); j++) {
      const f = lines[j];
      // JS/TS: at fn (file:line:col)
      const jsFrame = f.match(/^\s+at\s+(?:(\S+)\s+\()?([\w./_-]+\.(?:ts|tsx|js|jsx)):(\d+)(?::\d+)?\)?/);
      if (jsFrame) {
        frames.push({
          file: jsFrame[2],
          line: parseInt(jsFrame[3], 10),
          fn: jsFrame[1] || undefined,
        });
        continue;
      }
      // Python: File "x.py", line N, in fn
      const pyFrame = f.match(/^\s+File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(\S+))?/);
      if (pyFrame) {
        frames.push({
          file: pyFrame[1],
          line: parseInt(pyFrame[2], 10),
          fn: pyFrame[3] || undefined,
        });
        continue;
      }
      // Go: file.go:line +offset
      const goFrame = f.match(/^\s+([\w./_-]+\.go):(\d+)/);
      if (goFrame) {
        frames.push({ file: goFrame[1], line: parseInt(goFrame[2], 10) });
        continue;
      }
      // 空行 / 不再缩进 → 一帧结束
      if (frames.length > 0 && !/^\s/.test(f) && f.trim() !== "") break;
    }

    if (frames.length > 0) {
      traces.push({ frames, errorMessage });
      i += frames.length;
    }
  }

  return traces;
}

/**
 * 抽取 failed assertion. 各 runner 格式不同, 用启发式归一.
 */
function extractFailedAssertions(log: string, runner: CIRunner): FailedAssertion[] {
  const assertions: FailedAssertion[] = [];
  const lines = log.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // jest / vitest: "Expected: X" + "Received: Y"
    if (/^\s*Expected:?\s+/.test(line)) {
      const expected = line.replace(/^\s*Expected:?\s+/, "").trim();
      const next = lines[i + 1] ?? "";
      const actualMatch = next.match(/^\s*Received:?\s+(.*)/) || next.match(/^\s*Actual:?\s+(.*)/);
      if (actualMatch) {
        assertions.push({
          expected,
          actual: actualMatch[1].trim(),
          message: `${line.trim()} / ${next.trim()}`,
        });
        i += 1;
      }
    }

    // pytest: "assert X == Y"
    const pytestAssert = line.match(/^\s*(?:E\s+)?assert\s+(.+?)\s*(==|!=|is|in)\s*(.+)$/);
    if (pytestAssert && runner === "pytest") {
      assertions.push({
        actual: pytestAssert[1].trim(),
        expected: pytestAssert[3].trim(),
        message: line.trim(),
      });
    }

    // go-test: "want X, got Y" / "expected X, actual Y"
    const goAssert = line.match(/want\s+(.+?),\s+got\s+(.+)$/);
    if (goAssert && runner === "go-test") {
      assertions.push({
        expected: goAssert[1].trim(),
        actual: goAssert[2].trim(),
        message: line.trim(),
      });
    }
  }

  return assertions;
}

/**
 * 抽取顶级错误消息(去重, 限 20 条).
 */
function extractErrorMessages(log: string): string[] {
  const messages = new Set<string>();
  const lines = log.split("\n");
  for (const line of lines) {
    if (messages.size >= 20) break;
    const m = line.match(/^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|AssertionError|Exception|FAIL|panic|fatal):\s*(.+)$/);
    if (m) messages.add(m[1].trim());
    const tsErr = line.match(/error\s+TS\d{4}:\s+(.+)$/);
    if (tsErr) messages.add(tsErr[1].trim());
  }
  return Array.from(messages);
}

/**
 * 检测 retry / flaky 信号.
 */
function detectRetryMarkers(log: string): boolean {
  const patterns = [
    /retry\s+\d+/i,
    /retrying\s+after/i,
    /attempt\s+\d+\s+of/i,
    /flaky/i,
    /test_\w+\s+\(retry\)/,
    /\(\d+\s+retries?\)/i,
  ];
  return patterns.some((p) => p.test(log));
}

export function parseCILog(logText: string): ParsedCILog {
  const runner = detectRunner(logText);
  return {
    runner,
    stackTraces: extractStackTraces(logText),
    failedAssertions: extractFailedAssertions(logText, runner),
    fileRefs: extractFileRefs(logText),
    errorMessages: extractErrorMessages(logText),
    hasRetryMarkers: detectRetryMarkers(logText),
  };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { file: { type: "string", short: "f" } },
    allowPositionals: false,
  });

  let logText: string;
  if (values.file) {
    logText = readFileSync(values.file, "utf-8");
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    logText = Buffer.concat(chunks).toString("utf-8");
  }

  const result = parseCILog(logText);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
