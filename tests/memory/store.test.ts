/**
 * Auto Memory 存储测试（Task 1）
 * 使用临时目录，不污染真实 ~/.sid-code
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemoryStore, clearMemorySummaryCache, inferMemoryType } from "../../src/memory/store.ts";

let tmpProject: string;
let projDir: string;
let globalDir: string;

/** 构造使用临时目录的 store，避免污染真实 ~/.sid-code */
function makeStore(): MemoryStore {
  return new MemoryStore(tmpProject, { projectMemoryDir: projDir, globalMemoryDir: globalDir });
}

beforeEach(() => {
  tmpProject = mkdtempSync(join(tmpdir(), "sid-mem-"));
  projDir = join(tmpProject, "mem-project");
  globalDir = join(tmpProject, "mem-global");
  clearMemorySummaryCache();
});

afterEach(() => {
  try { rmSync(tmpProject, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("MemoryStore — 文件系统后端", () => {
  test("set 写入 .md 文件并可 get 回来", async () => {
    const store = makeStore();
    await store.set("coding_style", "用 4 空格缩进", "project");

    const dir = store.getProjectMemoryDir()!;
    expect(existsSync(dir)).toBe(true);
    // 应至少有一个 .md 文件 + MEMORY.md
    const got = await store.get("coding_style");
    expect(got).not.toBeNull();
    expect(got!.value).toBe("用 4 空格缩进");
    expect(got!.scope).toBe("project");
    expect(got!.type).toBeDefined();
  });

  test("MEMORY.md 索引自动维护", async () => {
    const store = makeStore();
    await store.set("test_framework", "用 bun test", "project");
    const index = await store.getIndexContent();
    expect(index).not.toBeNull();
    expect(index).toContain("test_framework");
  });

  test("项目记忆覆盖全局记忆（同 key）", async () => {
    const store = makeStore();
    await store.set("lang", "全局值", "global");
    await store.set("lang", "项目值", "project");
    const got = await store.get("lang");
    expect(got!.value).toBe("项目值");
    expect(got!.scope).toBe("project");
  });

  test("delete 删除 .md 文件", async () => {
    const store = makeStore();
    await store.set("temp_key", "临时值", "project");
    expect(await store.get("temp_key")).not.toBeNull();
    const deleted = await store.delete("temp_key");
    expect(deleted).toBe(true);
    // 重新加载验证持久化删除
    const store2 = makeStore();
    expect(await store2.get("temp_key")).toBeNull();
  });

  test("search 按关键词匹配", async () => {
    const store = makeStore();
    await store.set("db_choice", "使用 PostgreSQL 数据库", "project");
    await store.set("cache", "Redis 缓存", "project");
    const results = await store.search("postgres");
    expect(results.length).toBe(1);
    expect(results[0].key).toBe("db_choice");
  });

  test("generateSummary 格式与旧实现一致", async () => {
    const store = makeStore();
    await store.set("k1", "v1", "project");
    const summary = await store.generateSummary();
    expect(summary).toContain("[项目] k1: v1");
  });

  test("空记忆 generateSummary 返回 null", async () => {
    const store = makeStore();
    const summary = await store.generateSummary();
    expect(summary).toBeNull();
  });

  test("持久化：新 store 实例能读到旧实例写的记忆", async () => {
    const store1 = makeStore();
    await store1.set("persist_test", "持久值", "project");
    const store2 = makeStore();
    const got = await store2.get("persist_test");
    expect(got!.value).toBe("持久值");
  });

  test("超长 value 被截断到 10000 字符", async () => {
    const store = makeStore();
    const long = "x".repeat(20000);
    await store.set("big", long, "project");
    const got = await store.get("big");
    expect(got!.value.length).toBe(10000);
  });

  test("显式 type 与 description 被保留", async () => {
    const store = makeStore();
    await store.set("u1", "后端工程师", "project", { type: "user", description: "角色画像" });
    const got = await store.get("u1");
    expect(got!.type).toBe("user");
    expect(got!.description).toBe("角色画像");
  });
});

describe("MemoryStore — 旧 JSON 迁移", () => {
  test("旧 memories.json 自动迁移为 .md + 备份", async () => {
    // 在新格式项目记忆目录写入旧 JSON
    mkdirSync(projDir, { recursive: true });
    const legacy = {
      version: "1.0",
      entries: {
        old_key: {
          key: "old_key",
          value: "迁移前的值",
          scope: "project",
          createdAt: 1000,
          updatedAt: 2000,
        },
      },
    };
    const legacyPath = join(projDir, "memories.json");
    writeFileSync(legacyPath, JSON.stringify(legacy));

    // 新 store 加载触发迁移
    const store2 = makeStore();
    const got = await store2.get("old_key");
    expect(got).not.toBeNull();
    expect(got!.value).toBe("迁移前的值");
    // 备份文件应存在，原文件应消失
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(legacyPath + ".bak")).toBe(true);
  });
});

describe("inferMemoryType — 启发式分类", () => {
  test("URL 类归为 reference", () => {
    expect(inferMemoryType("dashboard", "https://grafana.example.com")).toBe("reference");
  });
  test("偏好类归为 feedback", () => {
    expect(inferMemoryType("test_pref", "以后都用集成测试，不要 mock")).toBe("feedback");
  });
  test("角色类归为 user", () => {
    expect(inferMemoryType("profile", "我是后端工程师")).toBe("user");
  });
  test("默认归为 project", () => {
    expect(inferMemoryType("misc", "随便什么内容")).toBe("project");
  });
});
