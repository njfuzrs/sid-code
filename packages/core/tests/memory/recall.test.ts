/**
 * 记忆动态召回测试（Task 2）
 * sideQuery 用 stub，不依赖真实 LLM
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  findRelevantMemories,
  parseSelection,
  isMemoryRecallEnabled,
  type SideQueryFn,
} from "@sid-code/core/memory/recall.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-recall-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeMemory(
  filename: string,
  name: string,
  desc: string,
  type: string,
  body: string,
  ageMs = 0,
) {
  const path = join(dir, filename);
  writeFileSync(path, `---\nname: ${name}\ndescription: ${desc}\ntype: ${type}\n---\n\n${body}`);
  if (ageMs > 0) {
    // 设置 mtime 为过去
    const past = Date.now() - ageMs;
    const fs = require("fs");
    fs.utimesSync(path, past / 1000, past / 1000);
  }
}

describe("parseSelection", () => {
  const valid = new Set(["a.md", "b.md", "c.md"]);

  test("解析 selected 数组并过滤非法文件名", () => {
    expect(parseSelection('{"selected": ["a.md", "x.md", "b.md"]}', valid)).toEqual([
      "a.md",
      "b.md",
    ]);
  });

  test("兼容 selected_memories 字段", () => {
    expect(parseSelection('{"selected_memories": ["c.md"]}', valid)).toEqual(["c.md"]);
  });

  test("非 JSON 返回空", () => {
    expect(parseSelection("没有 json", valid)).toEqual([]);
  });

  test("限制最多 5 个", () => {
    const many = new Set(["1.md", "2.md", "3.md", "4.md", "5.md", "6.md"]);
    const out = parseSelection('{"selected": ["1.md","2.md","3.md","4.md","5.md","6.md"]}', many);
    expect(out.length).toBe(5);
  });
});

describe("findRelevantMemories", () => {
  test("召回选中的记忆并读取正文", async () => {
    writeMemory("user_role.md", "user-role", "后端工程师", "user", "用户是后端工程师，Go 专家");
    writeMemory("project_x.md", "project-x", "项目背景", "project", "项目用 Postgres");

    const sideQuery: SideQueryFn = async () => '{"selected": ["user_role.md"]}';
    const results = await findRelevantMemories("用户是谁", dir, sideQuery);
    expect(results.length).toBe(1);
    expect(results[0].filename).toBe("user_role.md");
    expect(results[0].content).toContain("后端工程师");
  });

  test("空目录返回空", async () => {
    const sideQuery: SideQueryFn = async () => '{"selected": []}';
    const results = await findRelevantMemories("q", join(dir, "nope"), sideQuery);
    expect(results).toEqual([]);
  });

  test("alreadySurfaced 排除已注入记忆", async () => {
    writeMemory("user_role.md", "user-role", "后端工程师", "user", "body");
    // 选择器即使选了，也应在候选构建阶段被排除（不会出现在 manifest）
    const sideQuery: SideQueryFn = async () => '{"selected": ["user_role.md"]}';
    const results = await findRelevantMemories("q", dir, sideQuery, {
      alreadySurfaced: new Set(["user_role.md"]),
    });
    expect(results.length).toBe(0);
  });

  test("超过 1 天的记忆附加新鲜度警告", async () => {
    writeMemory("old.md", "old", "旧记忆", "project", "旧内容", 3 * 24 * 60 * 60 * 1000);
    const sideQuery: SideQueryFn = async () => '{"selected": ["old.md"]}';
    const results = await findRelevantMemories("q", dir, sideQuery);
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("system-reminder");
    expect(results[0].content).toContain("days old");
  });

  test("sideQuery 抛错时优雅返回空", async () => {
    writeMemory("user_role.md", "user-role", "后端工程师", "user", "body");
    const sideQuery: SideQueryFn = async () => {
      throw new Error("LLM down");
    };
    const results = await findRelevantMemories("q", dir, sideQuery);
    expect(results).toEqual([]);
  });

  test("选择器返回空数组时不召回", async () => {
    writeMemory("user_role.md", "user-role", "后端工程师", "user", "body");
    const sideQuery: SideQueryFn = async () => '{"selected": []}';
    const results = await findRelevantMemories("q", dir, sideQuery);
    expect(results).toEqual([]);
  });
});

describe("isMemoryRecallEnabled — flag 门控（对齐 claude-code tengu_moth_copse）", () => {
  const KEY = "SID_CODE_MEMORY_RECALL";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  test("默认（未设 env）关闭——走全量索引注入", () => {
    delete process.env[KEY];
    expect(isMemoryRecallEnabled()).toBe(false);
  });

  test("SID_CODE_MEMORY_RECALL=1 时启用", () => {
    process.env[KEY] = "1";
    expect(isMemoryRecallEnabled()).toBe(true);
  });

  test("其它值（如 'true' / '0'）不启用——只认严格 '1'", () => {
    process.env[KEY] = "true";
    expect(isMemoryRecallEnabled()).toBe(false);
    process.env[KEY] = "0";
    expect(isMemoryRecallEnabled()).toBe(false);
  });
});
