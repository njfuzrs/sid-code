/**
 * 会话存储测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore } from "../../src/session/store.ts";
import type { SessionData } from "../../src/session/store.ts";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

describe("SessionStore", () => {
  let testDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    // 使用临时目录避免污染用户目录
    testDir = join(tmpdir(), `sid-code-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = testDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  test("保存和加载会话", async () => {
    const store = new SessionStore();
    const session: SessionData = {
      id: "test-001",
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
      messages: [
        { role: "user", content: [{ type: "text", text: "你好" }] },
        { role: "assistant", content: [{ type: "text", text: "你好！" }] },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await store.save(session);
    const loaded = await store.load("test-001");

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("test-001");
    expect(loaded!.messages.length).toBe(2);
  });

  test("加载不存在的会话返回 null", async () => {
    const store = new SessionStore();
    const loaded = await store.load("nonexistent");
    expect(loaded).toBeNull();
  });

  test("生成会话 ID", () => {
    const id = SessionStore.generateId();
    expect(id.length).toBe(8);
  });

  test("列出会话", async () => {
    const store = new SessionStore();

    await store.save({
      id: "s1",
      model: "test",
      provider: "test",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await store.save({
      id: "s2",
      model: "test",
      provider: "test",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const list = await store.list();
    expect(list.length).toBe(2);
    // 两个会话都应该在列表中
    const ids = list.map((s) => s.id).sort();
    expect(ids).toEqual(["s1", "s2"]);
  });
});
