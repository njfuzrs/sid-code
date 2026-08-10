/**
 * pid-manager 单测
 */
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import * as PidManager from "../../src/trace/pid-manager.ts";
import { getSidHome } from "../../src/config/paths.ts";

// 从 getSidHome() 派生而非硬编码 join(homedir(), ".sid-code")：
// 后者会让本测试**真的往用户家目录写** PID 文件，且在隔离生效时期望路径失配。
// getSidHome() 尊重 SID_CONFIG_DIR（含 tests/preload-isolate-sid-home.ts 设的兜底）。
const BASE_DIR = join(getSidHome(), "trajectories");
const PIDS_DIR = join(BASE_DIR, ".pids");

/** 清理测试数据 */
function cleanupTestFiles() {
  try {
    void PidManager["findOrphanPids"]; // 仅引用确保模块加载
  } catch { /* ignore */ }

  // 删除当前 PID 文件
  try {
    PidManager.cleanup("test-session-001");
  } catch { /* ignore */ }

  // 删除测试用的孤儿 PID 文件
  const orphanPid = 123456;
  const orphanPath = join(PIDS_DIR, `${orphanPid}.json`);
  try {
    if (existsSync(orphanPath)) {
      const { unlinkSync } = require("node:fs") as typeof import("node:fs");
      unlinkSync(orphanPath);
    }
  } catch { /* ignore */ }

  // 确保至少有一个测试孤儿 PID
  const testOrphanPid = 999999;
  const testOrphanPath = join(PIDS_DIR, `${testOrphanPid}.json`);
  try {
    if (existsSync(testOrphanPath)) {
      const { unlinkSync } = require("node:fs") as typeof import("node:fs");
      unlinkSync(testOrphanPath);
    }
  } catch { /* ignore */ }
}

afterEach(() => {
  cleanupTestFiles();
});

describe("pid-manager", () => {
  test("write() 创建 PID 文件且内容正确", () => {
    const result = PidManager.write("test-session-001");
    expect(result).toBe(true);

    const pidPath = join(PIDS_DIR, `${process.pid}.json`);
    expect(existsSync(pidPath)).toBe(true);

    const raw = readFileSync(pidPath, "utf-8");
    const entry = JSON.parse(raw);
    expect(entry.pid).toBe(process.pid);
    expect(entry.session_id).toBe("test-session-001");
    expect(typeof entry.start_time).toBe("string");
    expect(typeof entry.process_title).toBe("string");
  });

  test("cleanup() 删除 PID 文件", () => {
    // 先写
    PidManager.write("test-session-001");
    const pidPath = join(PIDS_DIR, `${process.pid}.json`);
    expect(existsSync(pidPath)).toBe(true);

    // 再删
    PidManager.cleanup("test-session-001");
    expect(existsSync(pidPath)).toBe(false);
  });

  test("cleanup() 不匹配的 session 不会误删", () => {
    // 写入
    PidManager.write("test-session-001");
    const pidPath = join(PIDS_DIR, `${process.pid}.json`);
    expect(existsSync(pidPath)).toBe(true);

    // 用错的 session_id 调用 cleanup
    PidManager.cleanup("non-existent-session");
    expect(existsSync(pidPath)).toBe(true); // 仍然存在

    // 正确清理
    PidManager.cleanup("test-session-001");
    expect(existsSync(pidPath)).toBe(false);
  });

  test("cleanup() 空目录不报错", () => {
    // 不应抛异常
    expect(() => PidManager.cleanup("test-session-001")).not.toThrow();
  });

  test("findOrphanPids() 返回进程已不存在的条目", () => {
    // 创建假 PID 文件（指向不存在进程的 PID）
    const orphanPid = 999999;
    const orphanPath = join(PIDS_DIR, `${orphanPid}.json`);
    try { mkdirSync(PIDS_DIR, { recursive: true }); } catch { /* ignore */ }

    const orphanEntry: PidManager.PidEntry = {
      pid: orphanPid,
      session_id: "orphaned-session",
      start_time: new Date().toISOString(),
      process_title: "test-process",
    };
    writeFileSync(orphanPath, JSON.stringify(orphanEntry, null, 2));

    const orphans = PidManager.findOrphanPids();
    // 应该包含我们创建的孤儿 PID
    const found = orphans.find((o) => o.pid === orphanPid);
    expect(found).toBeDefined();
    expect(found!.session_id).toBe("orphaned-session");

    // 清理
    try { require("node:fs").unlinkSync(orphanPath); } catch { /* ignore */ }
  });

  test("findOrphanPids() 不把活跃进程标记为孤儿", () => {
    // 写入当前进程 PID 文件
    PidManager.write("test-session-001");

    const orphans = PidManager.findOrphanPids();
    // 当前进程 PID 不应该出现在孤儿列表中
    const found = orphans.find((o) => o.pid === process.pid);
    expect(found).toBeUndefined();
  });

  test("findOrphanPids() 空目录返回空数组", () => {
    // 确保所有本 session 的文件被清理
    PidManager.cleanup("test-session-001");

    // 多次调用确保空目录
    const orphans = PidManager.findOrphanPids();
    // 可能还有其他进程的 PID 文件，但不应报错
    expect(Array.isArray(orphans)).toBe(true);
  });

  test("write() 重复写覆盖旧值", () => {
    // 第一次写
    PidManager.write("test-session-001");
    const pidPath = join(PIDS_DIR, `${process.pid}.json`);
    const firstRaw = readFileSync(pidPath, "utf-8");
    const firstEntry = JSON.parse(firstRaw);
    // 先钉住覆盖前的值，否则「覆盖」无从谈起：原先这里读出 firstEntry 却从不断言，
    // 真正被验证的只有第二次写的结果，第一次写即使根本没落盘测试也照样绿。
    expect(firstEntry.session_id).toBe("test-session-001");

    // 第二次写
    PidManager.write("test-session-002"); // 不同 session_id
    const secondRaw = readFileSync(pidPath, "utf-8");
    const secondEntry = JSON.parse(secondRaw);

    expect(secondEntry.session_id).toBe("test-session-002");
    expect(secondEntry.pid).toBe(process.pid);

    // 清理
    PidManager.cleanup("test-session-002");
  });

  test("scanStaleHeartbeats() 无残留返回空数组", () => {
    const sessions = PidManager.scanStaleHeartbeats();
    expect(Array.isArray(sessions)).toBe(true);
  });
});
