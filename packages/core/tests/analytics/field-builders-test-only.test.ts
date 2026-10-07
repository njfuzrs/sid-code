/**
 * 缺陷 34：`toolNameFields` / `filePathFields` 是 test-only 导出。
 *
 * 生产代码绕过 `logXxx` 门面自己拼字段，就绕过了 instrumentation-sentinel 的强制脱敏门禁；
 * 工具名脱敏也不许再出现第二份手写规则（content-tracing 的 fallback 曾是实例）。
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SRC_ROOTS = ["packages/core/src", "packages/cli/src"].map((p) => join(ROOT, p));

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

const files = SRC_ROOTS.flatMap((d) => walk(d));

describe("缺陷 34：脱敏字段构造只在门面内用", () => {
  test("生产源码除 analytics/events.ts 外不引用 toolNameFields / filePathFields", () => {
    expect(files.length).toBeGreaterThan(100); // 反向自证：扫描确实扫到了源码
    const hits = files
      .filter((f) => !f.endsWith("analytics/events.ts"))
      .filter((f) => /\b(toolNameFields|filePathFields)\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });

  test("工具名 MCP 脱敏规则只在 analytics/sanitize.ts 手写一处", () => {
    // 回归形态：`name.startsWith("mcp__") ? "mcp_tool" : name` 这类就地重写
    const hits = files
      .filter((f) => !f.endsWith("analytics/sanitize.ts"))
      .filter((f) => /\?\s*["']mcp_tool["']/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});
