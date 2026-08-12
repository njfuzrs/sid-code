/**
 * G12: output-styles.ts 测试
 * frontmatter 解析 / 目录加载 / 项目覆盖全局 / 激活内容包裹
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// 被测模块用 process.cwd() 定位项目级目录，用 homedir() 定位全局级。
// 这里通过切换 cwd 到临时目录来隔离项目级加载。
import {
  resolveOutputStyle,
  getActiveOutputStyleContent,
  loadAllOutputStyles,
} from "@sid-code/core/config/output-styles.ts";

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-outstyle-"));
  const styleDir = join(tmpRoot, ".sid-code", "output-styles");
  mkdirSync(styleDir, { recursive: true });

  writeFileSync(
    join(styleDir, "concise.md"),
    `---
name: concise
description: 简洁风格
---
你是一个极简助手。每次回复不超过 3 句话。`,
  );

  writeFileSync(join(styleDir, "no-frontmatter.md"), `直接正文，无 frontmatter。`);

  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadAllOutputStyles", () => {
  test("加载项目级风格文件", () => {
    const styles = loadAllOutputStyles();
    const names = styles.map((s) => s.name).sort();
    expect(names).toContain("concise");
    expect(names).toContain("no-frontmatter");
  });

  test("frontmatter 正确解析 name/description", () => {
    const styles = loadAllOutputStyles();
    const concise = styles.find((s) => s.name === "concise");
    expect(concise?.description).toBe("简洁风格");
    expect(concise?.content).toContain("极简助手");
    expect(concise?.content).not.toContain("---"); // frontmatter 已剥离
  });

  test("无 frontmatter 时用文件名作为 name，正文为全文", () => {
    const styles = loadAllOutputStyles();
    const nf = styles.find((s) => s.name === "no-frontmatter");
    expect(nf?.content).toContain("直接正文");
    expect(nf?.description).toBe("");
  });
});

describe("resolveOutputStyle", () => {
  test("按名称命中", () => {
    expect(resolveOutputStyle("concise")?.name).toBe("concise");
  });
  test("未命中返回 null", () => {
    expect(resolveOutputStyle("nonexistent")).toBeNull();
  });
  test("undefined 返回 null", () => {
    expect(resolveOutputStyle(undefined)).toBeNull();
  });
});

describe("getActiveOutputStyleContent", () => {
  test("激活风格返回 <output-style> 包裹内容", () => {
    const content = getActiveOutputStyleContent("concise");
    expect(content).not.toBeNull();
    expect(content).toContain('<output-style name="concise">');
    expect(content).toContain("极简助手");
    expect(content).toContain("</output-style>");
  });

  test("未配置返回 null", () => {
    expect(getActiveOutputStyleContent(undefined)).toBeNull();
  });

  test("未找到风格返回 null", () => {
    expect(getActiveOutputStyleContent("missing")).toBeNull();
  });
});
