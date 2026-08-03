/**
 * 工具 schema 字段命名规范审计 —— 防"参数名风格混用把模型带进死循环"复发
 *
 * 背景（2026-08-03，轨迹 20260803-142835-b8c52ec4）：`lsp` 工具的 schema 字段是
 * `filePath`（驼峰），而 `write`/`read`/`edit` 是 `file_path`（下划线）。两种风格同时
 * 出现在工具列表里，模型写计划文件时连续 13 次把 `file_path` 写成 `filePath`，任务被迫
 * 中断。事后全仓库普查发现命名不一致不止 lsp 一处，而是 11 个文件、16 处字段。
 *
 * 本测试把"tool_use 协议层字段一律 snake_case"这条约定 codify 成可执行断言，让今后任何
 * 新工具引入 camelCase 字段在 `bun test` 阶段就报红——而不是等模型在生产会话里踩中才被动
 * 发现。设计哲学与 `tests/agent/loop-detection-exemption-audit.test.ts` 一致：用可执行
 * 测试代替手写清单/文档，防止事实源漂移。
 *
 * 两个刻意的设计选择：
 *   1. 【动态发现工具文件】不手写文件清单。本次普查踩过一次"新工具漏进审计"的坑
 *      （cron_create/team_create/workflow 都是普查时才发现），手写清单必然漂移。
 *   2. 【零例外白名单】全部工具统一 snake_case，不给"对标 Claude Code 原生 schema"留后门。
 *      没有 EXEMPT 名单就没有"悄悄放宽白名单"的退化路径。
 *
 * 扫描器要点（都是踩过的坑）：
 *   - 掩码：字符串字面量与注释内部的结构字符 `(){}[]:` 一律挖空，这样 ① 括号平衡不会被
 *     文案里的括号带偏 ② description 文案里写 `foo: z.string()` 这种示例不会被误当字段。
 *     只挖结构字符、不挖内容，所以带引号的键名 `"foo": z.string()` 仍能正确抽取。
 *   - `z\s*\.\s*object`：`z` 与 `.object` 之间允许换行（workflow.ts 就是 `z\n  .object({}`
 *     这种链式写法）。早先用"z 后紧跟点号"的正则漏扫过整个文件。
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

/** tool_use 协议层字段名规范：全小写 snake_case */
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** 递归收集 src 下所有非测试 .ts 文件 */
function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, acc);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * 动态发现全部工具实现文件。
 *
 * 判据是 `implements Tool` / `implements LegacyTool`——刻意不扫 `settings/types.ts`、
 * `sdk/schemas.ts` 这类内部 zod schema：那些不是 tool_use 协议边界，字段名是 TS 内部
 * 约定，强行套 snake_case 属于误伤。
 */
export function discoverToolFiles(): string[] {
  return walkTsFiles(SRC_ROOT)
    .filter((p) => /implements\s+(?:Tool|LegacyTool)\b/.test(readFileSync(p, "utf8")))
    .sort();
}

/**
 * 把字符串字面量与注释**内部**的结构字符 `(){}[]:` 替换成空格，其余字符与长度、换行全部
 * 保持不变（偏移量与原文一一对应，便于换算行号）。
 */
export function maskStructuralChars(src: string): string {
  const out = src.split("");
  const STRUCTURAL = new Set(["(", ")", "{", "}", "[", "]", ":"]);
  const blank = (i: number) => {
    if (STRUCTURAL.has(src[i]!)) out[i] = " ";
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    // 行注释
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") blank(i++);
      continue;
    }
    // 块注释
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) blank(i++);
      i += 2;
      continue;
    }
    // 字符串 / 模板字面量（模板里的 ${} 一并挖空——schema 字段名不会写在模板表达式里）
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        blank(i++);
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** 从 openIdx 处的左括号出发做括号平衡，返回匹配的右括号下标；不匹配返回 -1 */
function matchBracket(masked: string, openIdx: number): number {
  const CLOSING: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = openIdx; i < masked.length; i++) {
    const c = masked[i]!;
    if (c in CLOSING) {
      stack.push(CLOSING[c]!);
    } else if (c === ")" || c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

export interface SchemaField {
  file: string;
  name: string;
  line: number;
}

/**
 * 抽取一个工具文件里所有 `z.object(...)` / `z.strictObject(...)` 字面量内的字段名。
 *
 * 嵌套 object 会被正则独立匹配到，因此嵌套字段（如 `todos[].content`、
 * `questions[].options[].label`）同样在覆盖范围内。
 */
export function extractSchemaFields(file: string, src: string): SchemaField[] {
  const masked = maskStructuralChars(src);
  const fields: SchemaField[] = [];
  const seen = new Set<number>();

  const schemaRe = /\bz\s*\.\s*(?:object|strictObject)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = schemaRe.exec(masked)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const close = matchBracket(masked, openParen);
    if (close < 0) continue;

    const body = masked.slice(openParen, close + 1);
    // 字段声明形如 `name: z.xxx`（键名允许带引号）；前置锚点保证是对象成员而非链式调用
    const fieldRe =
      /(?:^|[{,])\s*(?:"([A-Za-z_$][\w$]*)"|'([A-Za-z_$][\w$]*)'|([A-Za-z_$][\w$]*))\s*:\s*z\b/gm;
    let f: RegExpExecArray | null;
    while ((f = fieldRe.exec(body)) !== null) {
      const name = f[1] ?? f[2] ?? f[3]!;
      // 绝对偏移量去重：嵌套 schema 会被外层与内层各扫一次
      const abs = openParen + f.index;
      if (seen.has(abs)) continue;
      seen.add(abs);
      fields.push({
        file,
        name,
        line: src.slice(0, abs).split("\n").length,
      });
    }
  }
  return fields;
}

/** 收集全仓库工具 schema 字段（供断言与诊断输出复用） */
function collectAllFields(): { files: string[]; fields: SchemaField[] } {
  const files = discoverToolFiles();
  const fields = files.flatMap((f) => extractSchemaFields(f, readFileSync(f, "utf8")));
  return { files, fields };
}

describe("工具 schema 字段命名规范审计", () => {
  test("【核心】所有工具 schema 字段都是 snake_case（零例外白名单）", () => {
    const { fields } = collectAllFields();
    const violations = fields.filter((f) => !SNAKE_CASE.test(f.name));

    const detail = violations
      .map((v) => `  ${v.file.slice(REPO_ROOT.length + 1)}:${v.line}  ${v.name}`)
      .join("\n");

    expect(
      violations.map((v) => `${v.file.slice(REPO_ROOT.length + 1)}:${v.name}`),
      `以下工具 schema 字段不是 snake_case。tool_use 协议层字段必须统一 snake_case——\n` +
        `与 write/read/edit 的 file_path 风格混用会让模型反复写错参数名（2026-08-03 事故）。\n${detail}`,
    ).toEqual([]);
  });

  test("【防假绿】扫描器确实扫到了工具与字段（下限哨兵）", () => {
    const { files, fields } = collectAllFields();
    // 数字是当前实际规模的保守下限：扫描器正则一旦漂移导致扫空，这里先失败，
    // 而不是让上面的核心断言"零违规"假绿通过。
    expect(files.length, "工具实现文件发现数量异常偏低").toBeGreaterThanOrEqual(40);
    expect(fields.length, "抽取到的 schema 字段数量异常偏低").toBeGreaterThanOrEqual(120);
  });

  test("【防假绿】已知字段被正确抽取（含链式换行 / 嵌套 / 带描述的写法）", () => {
    const { fields } = collectAllFields();
    const byFile = (suffix: string) =>
      fields.filter((f) => f.file.endsWith(suffix)).map((f) => f.name);

    // write.ts：z.strictObject 写法
    expect(byFile("src/tool/write.ts")).toContain("file_path");
    // lsp.ts：本次事故的直接触发点
    expect(byFile("src/tool/lsp.ts")).toContain("file_path");
    // workflow.ts：`z\n  .object({` 链式换行写法——早先的正则在这里整个文件漏扫
    expect(byFile("src/tool/workflow.ts")).toContain("script_path");
    // todo-write.ts：嵌套数组元素字段
    expect(byFile("src/tool/todo-write.ts")).toContain("active_form");
  });

  test("【扫描器自证】掩码只挖结构字符，不误吞带引号的键名，也不把文案当字段", () => {
    const sample = `
      // 注释里写 fakeField: z.string() 不应被当成字段
      const s = z.object({
        real_field: z.string().describe("文案里写 alsoFake: z.number() 也不算"),
        "quoted_key": z.number(),
        nested: z.object({ inner_field: z.boolean() }),
      });
    `;
    const names = extractSchemaFields("/virtual/sample.ts", sample).map((f) => f.name);
    expect(names.sort()).toEqual(["inner_field", "nested", "quoted_key", "real_field"]);
  });
});
