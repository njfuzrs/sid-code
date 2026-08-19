/**
 * 并发冲突检测接线测试
 *
 * 验证 Edit/Write 工具正确接入冲突检测：
 * 1. 检测到冲突时根据 severity 决定行为
 * 2. warn 模式下有 conflictHandler 时弹框，无则降级
 * 3. block 模式下直接阻止
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { declareFileIntent } from "../../src/session/file-intent.ts";
import { FileReadTracker } from "../../src/tool/file-read-tracker.ts";
import { EditTool } from "../../src/tool/edit.ts";

describe("并发冲突检测接线", () => {
  let testDir: string;
  let tracker: FileReadTracker;
  let editTool: EditTool;
  const originalEnv = process.env.SID_CONFIG_DIR;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-conflict-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.SID_CONFIG_DIR = testDir;

    tracker = new FileReadTracker();
    tracker.applySessionContext({
      sessionId: "test-session-1",
      pid: process.pid,
      cwd: testDir,
    });
    tracker.conflictDetection = true;
    tracker.conflictSeverity = "warn";

    editTool = new EditTool(tracker);
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.SID_CONFIG_DIR = originalEnv;
    } else {
      delete process.env.SID_CONFIG_DIR;
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("无冲突时应正常执行", async () => {
    const testFile = join(testDir, "test.txt");
    writeFileSync(testFile, "original content\n");

    // 标记为已读
    tracker.markAsRead(testFile, Date.now(), { content: "original content\n" });

    const result = await editTool.execute({
      file_path: testFile,
      old_string: "original",
      new_string: "modified",
    });

    expect(result.isError).toBeUndefined();
  });

  it("检测到冲突 + warn 模式 + 无 conflictHandler 时应降级继续", async () => {
    const testFile = join(testDir, "test.txt");
    writeFileSync(testFile, "original content\n");

    // 标记为已读
    tracker.markAsRead(testFile, Date.now(), { content: "original content\n" });

    // 模拟其他会话也在编辑此文件
    declareFileIntent("other-session", process.pid, testDir, testFile, "edit");

    tracker.conflictSeverity = "warn";
    // 不设置 conflictHandler，模拟无头模式

    const result = await editTool.execute({
      file_path: testFile,
      old_string: "original",
      new_string: "modified",
    });

    // 无头模式降级：不阻断，继续执行
    expect(result.isError).toBeUndefined();
  });

  it("检测到冲突 + block 模式时应直接阻止", async () => {
    const testFile = join(testDir, "test.txt");
    writeFileSync(testFile, "original content\n");

    // 标记为已读
    tracker.markAsRead(testFile, Date.now(), { content: "original content\n" });

    // 模拟其他会话也在编辑此文件
    declareFileIntent("other-session", process.pid, testDir, testFile, "edit");

    tracker.conflictSeverity = "block";

    const result = await editTool.execute({
      file_path: testFile,
      old_string: "original",
      new_string: "modified",
    });

    // block 模式：直接阻止
    expect(result.isError).toBe(true);
    expect(result.output).toContain("并发冲突");
    expect(result.output).toContain("已阻止");
  });

  it("检测到冲突 + warn 模式 + conflictHandler 返回 stop 时应停止", async () => {
    const testFile = join(testDir, "test.txt");
    writeFileSync(testFile, "original content\n");

    // 标记为已读
    tracker.markAsRead(testFile, Date.now(), { content: "original content\n" });

    // 模拟其他会话也在编辑此文件
    declareFileIntent("other-session", process.pid, testDir, testFile, "edit");

    tracker.conflictSeverity = "warn";
    tracker.conflictHandler = mock(async () => "stop" as const);

    const result = await editTool.execute({
      file_path: testFile,
      old_string: "original",
      new_string: "modified",
    });

    // 用户选择停止
    expect(result.isError).toBe(true);
    expect(result.output).toContain("用户选择停止");
  });

  it("检测到冲突 + warn 模式 + conflictHandler 返回 continue 时应继续", async () => {
    const testFile = join(testDir, "test.txt");
    writeFileSync(testFile, "original content\n");

    // 标记为已读
    tracker.markAsRead(testFile, Date.now(), { content: "original content\n" });

    // 模拟其他会话也在编辑此文件
    declareFileIntent("other-session", process.pid, testDir, testFile, "edit");

    tracker.conflictSeverity = "warn";
    tracker.conflictHandler = mock(async () => "continue" as const);

    const result = await editTool.execute({
      file_path: testFile,
      old_string: "original",
      new_string: "modified",
    });

    // 用户选择继续
    expect(result.isError).toBeUndefined();
  });
});
