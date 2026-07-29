/**
 * 记忆路径 + 扫描 + 新鲜度测试（Task 1 / Task 2 基础）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  sanitizeProjectKey,
  findLegacyProjectKey,
  validateMemoryPath,
  isAutoMemPath,
  memoryFilename,
} from "../../src/memory/paths.ts";
import { scanMemoryFiles, formatMemoryManifest, parseFrontmatter, stripFrontmatter } from "../../src/memory/scan.ts";
import { memoryAgeDays, memoryAge, buildFreshnessWarning } from "../../src/memory/freshness.ts";

describe("paths — 安全验证", () => {
  test("sanitizeProjectKey 去掉分隔符与特殊字符", () => {
    // 纯 ASCII 安全字符路径：键逐字节不变（存量数据兼容的硬约束，见 paths.ts 说明）
    expect(sanitizeProjectKey("/Users/foo/bar")).toBe("Users-foo-bar");
    expect(sanitizeProjectKey("")).toBe("default");
  });

  // 审计第 3 条：键派生必须单射，否则 ASCII 骨架相同的项目串目录、私有记忆互相可读
  test("sanitizeProjectKey 非 ASCII 路径不再撞键（审计第 3 条）", () => {
    const a = sanitizeProjectKey("/tmp/sid-audit/工作/app");
    const b = sanitizeProjectKey("/tmp/sid-audit/文档/app");
    const c = sanitizeProjectKey("/tmp/sid-audit/项目/app");
    expect(new Set([a, b, c]).size).toBe(3);
    // 仍保留可读的 ASCII 骨架前缀，便于人工辨认目录归属
    expect(a.startsWith("tmp-sid-audit-app-")).toBe(true);
  });

  test("sanitizeProjectKey 同一路径稳定可复现（键不能每次启动都变）", () => {
    const p = "/Users/foo/工作/app";
    expect(sanitizeProjectKey(p)).toBe(sanitizeProjectKey(p));
  });

  test("含空格路径也算有损，需加后缀区分", () => {
    expect(sanitizeProjectKey("/Users/foo/my project")).not.toBe(
      sanitizeProjectKey("/Users/foo/my-project"),
    );
  });

  test("findLegacyProjectKey：无损路径无旧键，有损路径给出旧键供兼容读取", () => {
    expect(findLegacyProjectKey("/Users/foo/bar")).toBeUndefined();
    expect(findLegacyProjectKey("/tmp/sid-audit/工作/app")).toBe("tmp-sid-audit-app");
  });

  test("validateMemoryPath 拒绝相对路径", () => {
    expect(validateMemoryPath("relative/path")).toBeUndefined();
  });

  test("validateMemoryPath 拒绝 null 字节", () => {
    expect(validateMemoryPath("/abs/\0evil")).toBeUndefined();
  });

  test("validateMemoryPath 拒绝 UNC 路径", () => {
    expect(validateMemoryPath("\\\\server\\share")).toBeUndefined();
  });

  test("validateMemoryPath 拒绝根路径", () => {
    expect(validateMemoryPath("/")).toBeUndefined();
  });

  test("validateMemoryPath 接受合法绝对路径", () => {
    expect(validateMemoryPath("/Users/foo/.sid-code/memory")).toBe("/Users/foo/.sid-code/memory");
  });

  test("isAutoMemPath 防 ../ 逃逸", () => {
    const dir = "/Users/foo/memory";
    expect(isAutoMemPath("/Users/foo/memory/user_role.md", dir)).toBe(true);
    expect(isAutoMemPath("/Users/foo/memory/../../.ssh/id_rsa", dir)).toBe(false);
    expect(isAutoMemPath("/Users/foo/other/file.md", dir)).toBe(false);
  });

  test("memoryFilename 生成 <type>_<slug>.md", () => {
    expect(memoryFilename("user", "Backend Engineer Role")).toBe("user_backend-engineer-role.md");
    expect(memoryFilename("feedback", "测试")).toMatch(/^feedback_.*\.md$/);
  });
});

describe("scan — frontmatter 解析", () => {
  test("parseFrontmatter 提取字段", () => {
    const text = `---
name: user-role
description: 后端工程师
type: user
---

正文内容`;
    const fm = parseFrontmatter(text);
    expect(fm.name).toBe("user-role");
    expect(fm.description).toBe("后端工程师");
    expect(fm.type).toBe("user");
  });

  test("parseFrontmatter 非法 type 被忽略", () => {
    const text = `---
type: invalid_type
---`;
    const fm = parseFrontmatter(text);
    expect(fm.type).toBeUndefined();
  });

  test("stripFrontmatter 去掉 frontmatter 块", () => {
    const text = `---
name: x
---

body here`;
    expect(stripFrontmatter(text)).toBe("body here");
  });
});

describe("scan — 目录扫描", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-scan-"));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("扫描 .md 文件并跳过 MEMORY.md", async () => {
    writeFileSync(join(dir, "user_a.md"), "---\nname: a\ndescription: desc-a\ntype: user\n---\nbody");
    writeFileSync(join(dir, "project_b.md"), "---\nname: b\ndescription: desc-b\ntype: project\n---\nbody");
    writeFileSync(join(dir, "MEMORY.md"), "# index");
    const headers = await scanMemoryFiles(dir);
    expect(headers.length).toBe(2);
    const names = headers.map((h) => h.filename).sort();
    expect(names).toEqual(["project_b.md", "user_a.md"]);
  });

  test("跳过 logs/ 子目录", async () => {
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "logs", "x.md"), "---\nname: x\n---\nbody");
    writeFileSync(join(dir, "user_a.md"), "---\nname: a\ntype: user\n---\nbody");
    const headers = await scanMemoryFiles(dir);
    expect(headers.length).toBe(1);
    expect(headers[0].filename).toBe("user_a.md");
  });

  test("不存在的目录返回空数组", async () => {
    const headers = await scanMemoryFiles(join(dir, "nope"));
    expect(headers).toEqual([]);
  });

  test("formatMemoryManifest 输出可读清单", async () => {
    writeFileSync(join(dir, "user_a.md"), "---\nname: a\ndescription: 后端工程师\ntype: user\n---\nbody");
    const headers = await scanMemoryFiles(dir);
    const manifest = formatMemoryManifest(headers);
    expect(manifest).toContain("filename: user_a.md");
    expect(manifest).toContain("type: user");
    expect(manifest).toContain("desc: 后端工程师");
  });

  test("空清单返回占位文本", () => {
    expect(formatMemoryManifest([])).toBe("(no memories yet)");
  });
});

describe("freshness — 新鲜度", () => {
  const now = 1_000_000_000_000;
  const day = 24 * 60 * 60 * 1000;

  test("memoryAgeDays 计算天数", () => {
    expect(memoryAgeDays(now, now)).toBe(0);
    expect(memoryAgeDays(now - 3 * day, now)).toBe(3);
  });

  test("memoryAge 人类可读", () => {
    expect(memoryAge(now, now)).toBe("today");
    expect(memoryAge(now - day, now)).toBe("yesterday");
    expect(memoryAge(now - 5 * day, now)).toBe("5 days ago");
  });

  test("buildFreshnessWarning 1 天内返回 null", () => {
    expect(buildFreshnessWarning(now, now)).toBeNull();
    expect(buildFreshnessWarning(now - 12 * 60 * 60 * 1000, now)).toBeNull();
  });

  test("buildFreshnessWarning 超过 1 天返回警告", () => {
    const w = buildFreshnessWarning(now - 3 * day, now);
    expect(w).not.toBeNull();
    expect(w).toContain("3 days old");
    expect(w).toContain("Verify against current code");
  });
});
