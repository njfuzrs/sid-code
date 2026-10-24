/**
 * scripts/memory-quality-report.ts 口径测试
 *
 * 防的是「报告恒为 0」：目录枚举口径漂移、遥测字段名改了而脚本没跟，
 * 都会让报告静默输出全零而不报错——那看起来像「记忆质量很好」。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stockReport, flowReport } from "../../scripts/memory-quality-report.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-mqr-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mem(name: string, type: string, body: string, sub = ""): void {
  const d = join(dir, "memory", sub);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, `${type}_${name}.md`),
    `---\nname: ${name}\ndescription: d\ntype: ${type}\n---\n\n${body}\n`,
  );
}

describe("stockReport", () => {
  test("按真实失败形态计数，archive/ 不计入", () => {
    mem("a", "reference", "方案在 docs-research/x.md");
    mem("b", "reference", "看板 https://grafana.example.com/d/1");
    mem("c", "feedback", "分支策略为什么这样说不清");
    mem("d", "project", "规则\nWhy: 原因\nHow to apply: 场景");
    mem("e", "project", "截至 2026-10-14：PR-2 已合入\nWhy: x\nHow to apply: y");
    mem("old", "reference", "无 URL", "archive");

    const r = stockReport([join(dir, "memory")]);
    expect(r.files).toBe(5);
    expect(r.byType).toEqual({ reference: 2, feedback: 1, project: 2 });
    expect(r.referenceNoUrl).toBe(1);
    expect(r.needsWhy).toBe(3);
    expect(r.missingWhy).toBe(1);
    expect(r.looksSnapshot).toBe(1);
  });
});

describe("flowReport", () => {
  test("读取 memory_write 与 memory_guard 字段", () => {
    const f = join(dir, "events.jsonl");
    const ev = (eventName: string, metadata: Record<string, unknown>) =>
      JSON.stringify({ eventName, metadata });
    writeFileSync(
      f,
      [
        ev("memory_write", {
          memory_type: "project",
          write_via: "forked",
          missing_why: true,
          hint_count: 1,
        }),
        ev("memory_write", {
          memory_type: "reference",
          write_via: "main",
          reference_no_url: true,
          hint_count: 0,
        }),
        ev("memory_guard", { guard_kind: "scope_type_confusion" }),
        ev("memory_guard", { guard_kind: "shadowed" }),
        ev("tool_success", { tool_name: "ls" }),
      ].join("\n"),
    );
    const r = flowReport([f]);
    expect(r.writes).toBe(2);
    expect(r.byVia).toEqual({ forked: 1, main: 1 });
    expect(r.missingWhy).toBe(1);
    expect(r.referenceNoUrl).toBe(1);
    expect(r.hinted).toBe(1);
    expect(r.guard).toEqual({ scope_type_confusion: 1 });
  });
});
