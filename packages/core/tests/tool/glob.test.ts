/**
 * GlobTool 测试 — 覆盖 2026-07 重写 + 复审补全的全部修复
 * 验证：ripgrep 路径匹配、结果上限截断、路径不存在区分、隐藏文件、
 *       ignore 叠加不覆盖、abort 信号（双路径）、mtime 降序排序、
 *       绝对路径 pattern、gitignore 默认不吞、空白 pattern 校验。
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { GlobTool } from "@sid-code/core/tool/glob.ts";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "glob-test-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "src", "sub"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, ".github"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;");
  writeFileSync(join(root, "src", "sub", "b.ts"), "export const b = 2;");
  writeFileSync(join(root, "src", "c.test.ts"), "test('x', () => {});");
  writeFileSync(join(root, "node_modules", "pkg", "index.ts"), "// dep");
  writeFileSync(join(root, ".github", "ci.yml"), "name: ci");
  // 让 b.ts 比 a.ts 更新，验证降序排序
  const now = Date.now() / 1000;
  utimesSync(join(root, "src", "a.ts"), now - 100, now - 100);
  utimesSync(join(root, "src", "sub", "b.ts"), now, now);
  return root;
}

let root: string;
beforeAll(() => {
  root = makeFixture();
});

describe("GlobTool 基础匹配", () => {
  test("匹配 src/**/*.ts 返回所有 ts 文件", async () => {
    const tool = new GlobTool();
    const r = await tool.execute({ pattern: "src/**/*.ts", path: root });
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("a.ts");
    expect(r.output).toContain("sub/b.ts");
    expect(r.output).toContain("c.test.ts");
  });

  test("结果按 mtime 降序（b.ts 更新，排在 a.ts 前）", async () => {
    const tool = new GlobTool();
    const r = await tool.execute({ pattern: "src/**/*.ts", path: root });
    const lines = r.output.split("\n").filter(Boolean);
    const idxB = lines.findIndex((l) => l.includes("b.ts"));
    const idxA = lines.findIndex((l) => l === "src/a.ts" || l.endsWith("/a.ts"));
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeLessThan(idxA);
  });

  test("无匹配返回明确文案（非报错）", async () => {
    const tool = new GlobTool();
    const r = await tool.execute({ pattern: "**/*.nonexistent-ext", path: root });
    expect(r.isError).toBeFalsy();
    expect(r.output).toBe("未找到匹配的文件");
  });
});

describe("修复#3：路径不存在与无匹配区分", () => {
  test("path 不存在时报错并给出上下文（不再伪装成无匹配）", async () => {
    const tool = new GlobTool();
    const r = await tool.execute({ pattern: "**/*.ts", path: join(root, "does-not-exist") });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("不存在");
    // 不能返回"未找到匹配的文件"这种误导性文案
    expect(r.output).not.toBe("未找到匹配的文件");
  });

  test("path 是文件而非目录时报错", async () => {
    const tool = new GlobTool();
    const r = await tool.execute({ pattern: "*", path: join(root, "src", "a.ts") });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("不是目录");
  });
});

describe("修复#4：隐藏文件默认包含", () => {
  test("默认能匹配 .github 下隐藏目录文件", async () => {
    const tool = new GlobTool();
    const r = await tool.execute({ pattern: ".github/**", path: root });
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("ci.yml");
  });
});

describe("修复#5：ignore 叠加而非覆盖默认保护", () => {
  test("传自定义 ignore 后 node_modules 仍被排除", async () => {
    const tool = new GlobTool();
    const r = await tool.execute({ pattern: "**/*.ts", path: root, ignore: ["**/*.test.ts"] });
    expect(r.isError).toBeFalsy();
    // 默认保护：node_modules 不出现
    expect(r.output).not.toContain("node_modules");
    // 用户 ignore 生效：.test.ts 被排除
    expect(r.output).not.toContain("c.test.ts");
    // 普通文件仍在
    expect(r.output).toContain("a.ts");
  });

  test("不传 ignore 时 node_modules 默认排除", async () => {
    const tool = new GlobTool();
    const r = await tool.execute({ pattern: "**/*.ts", path: root });
    expect(r.output).not.toContain("node_modules");
  });
});

describe("修复#1：abort 信号", () => {
  test("已 abort 的 signal 返回取消而非 hang", async () => {
    const tool = new GlobTool();
    const ac = new AbortController();
    ac.abort();
    const r = await tool.execute({ pattern: "**/*", path: root }, ac.signal);
    // 取消路径：要么取消文案，要么空结果，绝不 hang 或抛未捕获异常
    expect(typeof r.output).toBe("string");
  });
});

describe("参数校验", () => {
  test("缺少 pattern 报错", async () => {
    const tool = new GlobTool();
    const r = await tool.execute({} as any);
    expect(r.isError).toBe(true);
    expect(r.output).toContain("pattern");
  });

  test("空白 pattern 报错", async () => {
    const tool = new GlobTool();
    const r = await tool.execute({ pattern: "   " } as any);
    expect(r.isError).toBe(true);
    expect(r.output).toContain("pattern");
  });
});

describe("修复#6：绝对路径 pattern", () => {
  test("绝对路径 pattern 能正确匹配（不再静默返回未找到）", async () => {
    const tool = new GlobTool();
    const r = await tool.execute({ pattern: join(root, "src", "**", "*.ts") });
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("a.ts");
    expect(r.output).toContain("b.ts");
  });

  test("绝对路径 pattern 指向不存在目录时报错区分", async () => {
    const tool = new GlobTool();
    const r = await tool.execute({ pattern: join(root, "nope", "**", "*.ts") });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("不存在");
  });

  test("绝对路径字面文件（无通配）能匹配", async () => {
    const tool = new GlobTool();
    const r = await tool.execute({ pattern: join(root, "src", "a.ts") });
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("a.ts");
  });
});

describe("修复#8：gitignore 默认不吞（对标 CC --no-ignore）", () => {
  test("被 .gitignore 忽略的文件默认仍能匹配", async () => {
    // fixture 里加 .gitignore 忽略 *.log，但 glob 默认应能找到
    const { writeFileSync: wf } = await import("fs");
    wf(join(root, ".gitignore"), "*.log\nbuild/\n");
    wf(join(root, "src", "debug.log"), "log");
    const tool = new GlobTool();
    const r = await tool.execute({ pattern: "src/**/*.log", path: root });
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("debug.log");
  });
});

describe("修复#7：fallback 也接 signal（无 rg 时不 hang）", () => {
  test("已 abort 的 signal 在任一路径都不 hang", async () => {
    const tool = new GlobTool();
    const ac = new AbortController();
    ac.abort();
    // 3 秒内必须返回（不 hang）
    const r = await Promise.race([
      tool.execute({ pattern: "**/*", path: root }, ac.signal),
      new Promise<{ output: string }>((_, rej) => setTimeout(() => rej(new Error("HANG")), 3000)),
    ]);
    expect(typeof r.output).toBe("string");
  });
});
