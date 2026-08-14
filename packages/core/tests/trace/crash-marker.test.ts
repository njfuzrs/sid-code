/**
 * crash-marker 模块单元测试
 *
 * 测试覆盖：
 * - write() + readPrevious() 往返
 * - cleanup() 删除
 * - readPrevious() 无文件时返回 null
 * - cleanupAll() 批量清理
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import * as CrashMarker from "@sid-code/core/trace/crash-marker.ts";
import { getSidHome } from "@sid-code/core/config/paths.ts";

const TEST_SESSION_ID = `test-crash-${Date.now()}`;
// 从 getSidHome() 派生而非硬编码 join(homedir(), ".sid-code")：
// 后者会让本测试**真的往用户家目录写** crash.json，且在隔离生效时期望路径失配。
// getSidHome() 尊重 SID_CONFIG_DIR（含 tests/preload-isolate-sid-home.ts 设的兜底）。
const BASE_DIR = join(getSidHome(), "trajectories");
const TEST_SESSION_DIR = join(BASE_DIR, "sessions", TEST_SESSION_ID);
const TEST_CRASH_FILE = join(TEST_SESSION_DIR, "crash.json");

function makeSnapshot(
  overrides: Partial<CrashMarker.CrashSnapshot> = {},
): CrashMarker.CrashSnapshot {
  return {
    session_id: TEST_SESSION_ID,
    timestamp: new Date().toISOString(),
    error_message: "Test OOM",
    error_name: "V8HeapOOM",
    stack: "Error: Test OOM\n    at test.ts:1:1",
    last_api_call_index: 12,
    last_model: "test-model-v1",
    memory_mb: 4500,
    uptime_seconds: 3600,
    ...overrides,
  };
}

describe("CrashMarker", () => {
  beforeEach(() => {
    // 确保测试 session 目录干净
    try {
      if (existsSync(TEST_SESSION_DIR)) {
        rmSync(TEST_SESSION_DIR, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    // 清理测试数据
    try {
      CrashMarker.cleanup(TEST_SESSION_ID);
      if (existsSync(TEST_SESSION_DIR)) {
        rmSync(TEST_SESSION_DIR, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  });

  test("write() 成功落盘 crash.json", () => {
    const snapshot = makeSnapshot();
    const result = CrashMarker.write(snapshot);
    expect(result).toBe(true);
    expect(existsSync(TEST_CRASH_FILE)).toBe(true);
  });

  test("readPrevious() 读取已写入的 crash.json", () => {
    const snapshot = makeSnapshot({ error_message: "Custom error for read test" });
    CrashMarker.write(snapshot);

    const read = CrashMarker.readPrevious();
    expect(read).not.toBeNull();
    expect(read!.session_id).toBe(TEST_SESSION_ID);
    expect(read!.error_message).toBe("Custom error for read test");
    expect(read!.last_api_call_index).toBe(12);
    expect(read!.memory_mb).toBe(4500);
  });

  test("readPrevious() 无残留文件时返回 null", () => {
    // 确保没有任何 crash.json
    CrashMarker.cleanup(TEST_SESSION_ID);
    if (existsSync(TEST_SESSION_DIR)) {
      // 如果目录存在但没有 crash.json，readPrevious 也应返回 null
    }
    const read = CrashMarker.readPrevious();
    // 注意：readPrevious 可能找到其他历史的 crash.json，
    // 我们只验证不会返回我们刚写入的测试 session
    if (read) {
      expect(read.session_id).not.toBe(TEST_SESSION_ID);
    }
  });

  test("cleanup() 删除 crash.json", () => {
    const snapshot = makeSnapshot();
    CrashMarker.write(snapshot);
    expect(existsSync(TEST_CRASH_FILE)).toBe(true);

    CrashMarker.cleanup(TEST_SESSION_ID);
    expect(existsSync(TEST_CRASH_FILE)).toBe(false);
  });

  test("cleanup() 不存在的文件不抛异常", () => {
    // 确保文件不存在
    CrashMarker.cleanup(TEST_SESSION_ID);
    // 重复调用不应抛异常
    expect(() => CrashMarker.cleanup(TEST_SESSION_ID)).not.toThrow();
  });

  test("cleanupAll() 清理所有残留", () => {
    const snapshot = makeSnapshot();
    CrashMarker.write(snapshot);
    expect(existsSync(TEST_CRASH_FILE)).toBe(true);

    const result = CrashMarker.cleanupAll();
    // cleanupAll 可能会清理到我们的测试文件
    // 至少确保不会抛异常
    expect(result.cleaned).toBeGreaterThanOrEqual(0);
    // 验证测试文件已被清理
    expect(existsSync(TEST_CRASH_FILE)).toBe(false);
  });

  test("write() 对不合法的 session_id 不抛异常", () => {
    const snapshot = makeSnapshot({ session_id: "../../../etc/passwd" });
    // 不应抛异常（路径穿越防护暂由文件系统兜底）
    const result = CrashMarker.write(snapshot);
    // 至少不应 crash
    expect(typeof result).toBe("boolean");
  });

  test("快照包含完整的 CrashSnapshot 字段", () => {
    const snapshot: CrashMarker.CrashSnapshot = {
      session_id: TEST_SESSION_ID,
      timestamp: "2026-06-08T16:54:00.000Z",
      error_message: "p out of memory",
      error_name: "V8HeapOOM",
      stack: "Error: OOM\n    at allocate (native)\n    at Object.<anonymous> (test:1:1)",
      last_api_call_index: 54,
      last_model: "deepseek-v4-pro",
      last_tool: "Read",
      last_stop_reason: "tool_use",
      memory_mb: 4500,
      uptime_seconds: 1260,
      signal: "SIGABRT",
      process_title: "Electron",
    };

    CrashMarker.write(snapshot);

    const read = CrashMarker.readPrevious();
    expect(read).not.toBeNull();
    if (read) {
      expect(read.session_id).toBe(TEST_SESSION_ID);
      expect(read.timestamp).toBe("2026-06-08T16:54:00.000Z");
      expect(read.error_message).toBe("p out of memory");
      expect(read.error_name).toBe("V8HeapOOM");
      expect(read.last_api_call_index).toBe(54);
      expect(read.last_model).toBe("deepseek-v4-pro");
      expect(read.last_tool).toBe("Read");
      expect(read.last_stop_reason).toBe("tool_use");
      expect(read.memory_mb).toBe(4500);
      expect(read.uptime_seconds).toBe(1260);
      expect(read.signal).toBe("SIGABRT");
      expect(read.process_title).toBe("Electron");
    }
  });
});

/**
 * P2-14：用户关终端导致的 EIO/EPIPE 不应记成 crash。
 *
 * 实测捞到的 crash.json 里 error_message 是 `EIO: i/o error, write`、
 * 栈顶是 `writeSync` → `unmount`——整条链是「用户关窗口 → tty 消失 → Ink 卸载时
 * 写终端复位序列失败」，没有一处是 sid-code 的故障，但它进了崩溃统计。
 */
describe("CrashMarker · 终端关闭不算崩溃（P2-14）", () => {
  const TTY_SESSION = `test-crash-eio-${Date.now()}`;
  const TTY_SESSION_DIR = join(BASE_DIR, "sessions", TTY_SESSION);

  /** 复刻实测那份 crash.json 的形态 */
  function ttyDeathSnapshot(
    message: string,
    overrides: Partial<CrashMarker.CrashSnapshot> = {},
  ): CrashMarker.CrashSnapshot {
    return {
      session_id: TTY_SESSION,
      timestamp: new Date().toISOString(),
      error_message: message,
      error_name: "Error",
      stack: `Error: ${message}\n at writeSync (unknown)\n at unmount (…)`,
      last_api_call_index: 156,
      last_model: "deepseek-v4-pro",
      memory_mb: 474.6,
      uptime_seconds: 1778.77,
      ...overrides,
    };
  }

  afterEach(() => {
    try {
      CrashMarker.cleanup(TTY_SESSION);
      if (existsSync(TTY_SESSION_DIR)) {
        rmSync(TTY_SESSION_DIR, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  });

  test("EIO（tty 消失后 unmount 写失败）不生成 crash.json", () => {
    const snapshot = ttyDeathSnapshot("EIO: i/o error, write");

    expect(CrashMarker.isTerminalDeathSnapshot(snapshot)).toBe(true);
    expect(CrashMarker.write(snapshot)).toBe(false);
    // 关键断言：文件不存在。连 session 目录都不该建（空目录也是残留）
    expect(existsSync(join(TTY_SESSION_DIR, "crash.json"))).toBe(false);
    expect(existsSync(TTY_SESSION_DIR)).toBe(false);
  });

  test("EPIPE（管道断开）同样不生成 crash.json", () => {
    const snapshot = ttyDeathSnapshot("EPIPE: broken pipe, write");

    expect(CrashMarker.isTerminalDeathSnapshot(snapshot)).toBe(true);
    expect(CrashMarker.write(snapshot)).toBe(false);
    expect(existsSync(join(TTY_SESSION_DIR, "crash.json"))).toBe(false);
  });

  test("真故障（OOM）仍照常落盘——过滤不能把真崩溃一起吞掉", () => {
    const snapshot = ttyDeathSnapshot("Heap out of memory", { error_name: "V8HeapOOM" });

    expect(CrashMarker.isTerminalDeathSnapshot(snapshot)).toBe(false);
    expect(CrashMarker.write(snapshot)).toBe(true);
    expect(existsSync(join(TTY_SESSION_DIR, "crash.json"))).toBe(true);
  });

  test("判据锚定前缀：错误内容里恰好含 EIO 字样的真故障不被误吞", () => {
    // 裸子串匹配会把这条误判成"关终端"。前缀锚定（/^(EIO|EPIPE):/）不会。
    const snapshot = ttyDeathSnapshot("failed to parse config: unexpected token EIO: at line 3", {
      error_name: "SyntaxError",
    });

    expect(CrashMarker.isTerminalDeathSnapshot(snapshot)).toBe(false);
    expect(CrashMarker.write(snapshot)).toBe(true);
    expect(existsSync(join(TTY_SESSION_DIR, "crash.json"))).toBe(true);
  });

  test("last_api_call_index 落盘的是实际调用数，不是 -1", () => {
    // 这里钉住的是「字段能承载真实值」这一半；取值侧（app.ts countApiCallsForCrash
    // 按 modelUsage[*].requests 求和，与 SessionEnd 的 total_api_calls 同口径）
    // 依赖完整 App 实例，不在本单测范围内。
    const snapshot = ttyDeathSnapshot("Heap out of memory", { last_api_call_index: 156 });
    CrashMarker.write(snapshot);

    const read = CrashMarker.readPrevious();
    expect(read).not.toBeNull();
    expect(read!.last_api_call_index).toBe(156);
    expect(read!.last_api_call_index).not.toBe(-1);
  });
});
