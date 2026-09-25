/**
 * `--json-schema` 双形态解析（G6）。
 *
 * CC 的 `--json-schema` 收的是**内联 JSON 字符串**，文档示例直接写
 * `{"type":"object",...}`。sid-code 此前只把它当文件路径 `readFileSync`，
 * 传内联 JSON 会以 ENOENT 退出。
 *
 * 这里两种都收，用「trim 后是否以 `{` / `[` 开头」区分，而不是先 parse 再回退：
 * 一段以 `{` 开头的非法 JSON 如果被当成路径去读，报错会变成「找不到文件」，
 * 把真正的语法错误藏起来。不以 `{`/`[` 开头的值优先当路径。
 */

import { readFileSync } from "node:fs";

export interface JsonSchemaParseOk {
  ok: true;
  schema: Record<string, unknown>;
  /** 值是从哪来的，报错和日志要能区分。 */
  source: "inline" | "file";
}

export interface JsonSchemaParseErr {
  ok: false;
  /** 给人看的中文原因，调用方直接打印。 */
  message: string;
}

export type JsonSchemaParseResult = JsonSchemaParseOk | JsonSchemaParseErr;

/**
 * 解析 `--json-schema` 的原始参数值。
 *
 * `readFile` 可注入：生产走 `readFileSync`，单测不碰磁盘。
 */
export function parseJsonSchemaArg(
  raw: string,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf-8"),
): JsonSchemaParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, message: "错误: --json-schema 的值为空" };
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseInline(trimmed);
  }
  return parseFile(raw, readFile);
}

function parseInline(text: string): JsonSchemaParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      message:
        `错误: --json-schema 看起来是内联 JSON，但解析失败: ${errMsg(err)}。` +
        `若要传文件，路径不要以 { 或 [ 开头。`,
    };
  }
  if (!isSchemaObject(parsed)) {
    return {
      ok: false,
      message: '错误: --json-schema 的内联 JSON 必须是对象（如 {"type":"object",...}）',
    };
  }
  return { ok: true, schema: parsed, source: "inline" };
}

function parseFile(path: string, readFile: (path: string) => string): JsonSchemaParseResult {
  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    return {
      ok: false,
      message:
        `错误: 无法读取 --json-schema 文件 "${path}": ${errMsg(err)}。` +
        `内联 JSON 请直接传以 { 开头的字符串。`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      message: `错误: --json-schema 文件 "${path}" 不是合法 JSON: ${errMsg(err)}`,
    };
  }
  if (!isSchemaObject(parsed)) {
    return {
      ok: false,
      message: `错误: --json-schema 文件 "${path}" 的内容必须是 JSON 对象`,
    };
  }
  return { ok: true, schema: parsed, source: "file" };
}

function isSchemaObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
