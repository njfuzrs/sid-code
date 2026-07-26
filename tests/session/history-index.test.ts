/**
 * P2-G8：全局 history.jsonl 输入索引
 *
 * 验证：追加/读取（最新在前、去重）、project 过滤、旧 input-history.json 一次性迁移。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("P2-G8 history-index", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.SID_CONFIG_DIR;
    home = mkdtempSync(join(tmpdir(), "hist-idx-"));
    process.env.SID_CONFIG_DIR = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevHome;
    if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  test("追加后读回（最新在前、去重）", async () => {
    const mod = await import("../../src/session/history-index.ts?t=" + Date.now());
    mod.appendHistoryEntry({ display: "a", pastedContents: [], timestamp: "", project: "/p1", sessionId: "s1" });
    mod.appendHistoryEntry({ display: "b", pastedContents: [], timestamp: "", project: "/p2", sessionId: "s2" });
    mod.appendHistoryEntry({ display: "a", pastedContents: [], timestamp: "", project: "/p1", sessionId: "s3" });
    expect(mod.readHistoryDisplays()).toEqual(["a", "b"]);
  });

  test("project 过滤", async () => {
    const mod = await import("../../src/session/history-index.ts?t=" + Date.now());
    mod.appendHistoryEntry({ display: "x", pastedContents: [], timestamp: "", project: "/p1", sessionId: "s1" });
    mod.appendHistoryEntry({ display: "y", pastedContents: [], timestamp: "", project: "/p2", sessionId: "s2" });
    expect(mod.readHistoryDisplays({ project: "/p1" })).toEqual(["x"]);
  });

  test("坏行跳过不影响其余", async () => {
    const mod = await import("../../src/session/history-index.ts?t=" + Date.now());
    mod.appendHistoryEntry({ display: "good", pastedContents: [], timestamp: "", project: "/p", sessionId: "s" });
    // 手动追加一行坏 JSON
    writeFileSync(join(home, "history.jsonl"), '{"display":"good"...\n{"display":"good2","pastedContents":[],"timestamp":"","project":"/p","sessionId":"s"}\n', { flag: "a" });
    const displays = mod.readHistoryDisplays();
    expect(displays).toContain("good2");
  });

  test("旧 input-history.json 一次性迁移（顺序保持最新在前）", async () => {
    // history.jsonl 不存在，仅有旧文件
    writeFileSync(join(home, "input-history.json"), JSON.stringify(["newest", "middle", "oldest"]));
    const mod = await import("../../src/session/history-index.ts?t=" + Date.now());
    expect(mod.readHistoryDisplays()).toEqual(["newest", "middle", "oldest"]);
    // 迁移后 history.jsonl 应存在
    expect(existsSync(join(home, "history.jsonl"))).toBe(true);
  });

  test("extractSessionIdFromBody 提取会话 id（用于 from-pr）", async () => {
    const mod = await import("../../src/session/from-pr.ts?t=" + Date.now());
    expect(mod.extractSessionIdFromBody("sid-session: 20260724-120000-abcd1234")).toBe("20260724-120000-abcd1234");
    expect(mod.extractSessionIdFromBody("Session: none")).toBeUndefined();
    expect(mod.extractSessionIdFromBody("no id here")).toBeUndefined();
    expect(mod.extractSessionIdFromBody("session-id=550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });
});
