/**
 * 并发冲突检测单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  declareFileIntent,
  clearFileIntent,
  queryFileIntents,
  queryAllFileIntents,
} from "../../src/session/file-intent.ts";
import { checkConflict, formatConflictWarning } from "../../src/session/conflict-detector.ts";

describe("并发冲突检测", () => {
  let testDir: string;
  const originalEnv = process.env.SID_CONFIG_DIR;

  beforeEach(() => {
    // 使用临时目录隔离测试
    testDir = join(tmpdir(), `sid-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.SID_CONFIG_DIR = testDir;
  });

  afterEach(() => {
    // 恢复环境
    if (originalEnv !== undefined) {
      process.env.SID_CONFIG_DIR = originalEnv;
    } else {
      delete process.env.SID_CONFIG_DIR;
    }
    // 清理临时目录
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("declareFileIntent", () => {
    it("应该声明文件编辑意图", () => {
      declareFileIntent("session-1", process.pid, "/test/cwd", "/test/file.ts", "read");

      const intents = queryAllFileIntents();
      expect(intents["session-1"]).toBeDefined();
      expect(intents["session-1"].files["/test/file.ts"]).toBeDefined();
      expect(intents["session-1"].files["/test/file.ts"].operation).toBe("read");
    });

    it("应该更新已有意图", async () => {
      declareFileIntent("session-1", process.pid, "/test/cwd", "/test/file.ts", "read");

      const firstTime = queryAllFileIntents()["session-1"].files["/test/file.ts"].lastAccessAt;

      // 等待 10ms 确保时间戳不同
      await new Promise((resolve) => setTimeout(resolve, 10));

      declareFileIntent("session-1", process.pid, "/test/cwd", "/test/file.ts", "edit");

      const intents = queryAllFileIntents();
      const intent = intents["session-1"].files["/test/file.ts"];
      expect(intent.operation).toBe("edit");
      expect(intent.lastAccessAt).toBeGreaterThan(firstTime);
    });

    it("应该处理多个文件", () => {
      declareFileIntent("session-1", process.pid, "/test/cwd", "/test/file1.ts", "read");
      declareFileIntent("session-1", process.pid, "/test/cwd", "/test/file2.ts", "edit");

      const intents = queryAllFileIntents();
      expect(Object.keys(intents["session-1"].files)).toHaveLength(2);
    });
  });

  describe("clearFileIntent", () => {
    it("应该清理会话的所有意图", () => {
      declareFileIntent("session-1", process.pid, "/test/cwd", "/test/file.ts", "read");

      clearFileIntent("session-1");

      const intents = queryAllFileIntents();
      expect(intents["session-1"]).toBeUndefined();
    });
  });

  describe("queryFileIntents", () => {
    it("应该查询特定文件的意图", () => {
      declareFileIntent("session-1", process.pid, "/test/cwd", "/test/file.ts", "read");
      declareFileIntent("session-2", process.pid, "/test/cwd", "/test/file.ts", "edit");

      const conflicts = queryFileIntents("/test/file.ts");
      expect(conflicts).toHaveLength(2);
    });

    it("应该排除指定会话", () => {
      declareFileIntent("session-1", process.pid, "/test/cwd", "/test/file.ts", "read");
      declareFileIntent("session-2", process.pid, "/test/cwd", "/test/file.ts", "edit");

      const conflicts = queryFileIntents("/test/file.ts", "session-1");
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].sessionId).toBe("session-2");
    });
  });

  describe("checkConflict", () => {
    it("应该检测 critical 级别的冲突", () => {
      declareFileIntent("session-1", process.pid, "/test/cwd", "/test/file.ts", "read");
      declareFileIntent("session-2", process.pid, "/test/cwd", "/test/file.ts", "write");

      const conflict = checkConflict("/test/file.ts", "current-session");
      expect(conflict).not.toBeNull();
      expect(conflict!.severity).toBe("critical");
      // 默认只有 write/edit 触发冲突，read 不触发
      expect(conflict!.conflictingSessions).toHaveLength(1);
      expect(conflict!.conflictingSessions[0].sessionId).toBe("session-2");
    });

    it("应该检测 warning 级别的冲突（当 read 也触发冲突时）", () => {
      declareFileIntent("session-1", process.pid, "/test/cwd", "/test/file.ts", "read");

      // 默认 read 不触发冲突，需要显式传入 blockingOperations
      const conflict = checkConflict("/test/file.ts", "current-session", {
        blockingOperations: ["read", "edit", "write"],
      });
      expect(conflict).not.toBeNull();
      expect(conflict!.severity).toBe("warning");
    });

    it("应该排除当前会话自己", () => {
      declareFileIntent("current-session", process.pid, "/test/cwd", "/test/file.ts", "read");

      const conflict = checkConflict("/test/file.ts", "current-session");
      expect(conflict).toBeNull();
    });

    it("应该返回 null 如果没有冲突", () => {
      const conflict = checkConflict("/test/file.ts", "current-session");
      expect(conflict).toBeNull();
    });
  });

  describe("formatConflictWarning", () => {
    it("应该格式化冲突警告", () => {
      declareFileIntent("session-1", process.pid, "/test/cwd", "/test/file.ts", "edit");

      const conflict = checkConflict("/test/file.ts", "current-session");
      expect(conflict).not.toBeNull();

      const warning = formatConflictWarning(conflict!);
      expect(warning).toContain("并发冲突警告");
      expect(warning).toContain("/test/file.ts");
      // sessionId 取尾部 8 个字符（"session-1" → "ession-1"）
      expect(warning).toContain("ession-1");
    });
  });
});
