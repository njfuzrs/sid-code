/**
 * processToolResult 落盘阈值
 *
 * 主循环与子代理共用这一处。阈值按工具名（read/edit/write = Infinity，bash 默认 30000），
 * 工具实例的 maxResultSizeChars 优先于常量表。
 *
 * 本文件会写 sidPaths.trajectories()，必须显式 SID_CONFIG_DIR 隔离。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processToolResult, TOOL_MAX_RESULT_SIZE } from "@sid-code/core/tool/result-storage.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import { assertIsolated } from "../helpers/assert-isolated.ts";

const SESSION = "test-process-tool-result";
let TMP_HOME: string;
const savedConfigDir = process.env.SID_CONFIG_DIR;

beforeAll(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), "sid-result-storage-"));
  process.env.SID_CONFIG_DIR = TMP_HOME;
  assertIsolated();
});

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedConfigDir;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("processToolResult", () => {
  test("短输出原样返回、不落盘", () => {
    const out = processToolResult("bash", "tu-short", "hello", SESSION);
    expect(out).toBe("hello");
    const dir = join(sidPaths.trajectories(), "sessions", SESSION, "tool-outputs");
    expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0);
  });

  test("bash 超 30000 字符落盘，摘要含路径且文件是原文", () => {
    const raw = "B".repeat(40_000);
    const out = processToolResult("bash", "tu-bash01", raw, SESSION);
    expect(out).not.toBe(raw);
    expect(out.length).toBeLessThan(raw.length);
    expect(out).toContain("完整输出已保存到");
    expect(out).toContain("使用 read 工具查看完整内容");
    const match = out.match(/完整输出已保存到 (.+?)，共/);
    expect(match).toBeTruthy();
    const filepath = match![1];
    expect(existsSync(filepath)).toBe(true);
    expect(readFileSync(filepath, "utf8")).toBe(raw);
  });

  test("read 阈值 Infinity：超长也不截、不落盘（防 Read→file→Read 循环）", () => {
    expect(TOOL_MAX_RESULT_SIZE.read).toBe(Infinity);
    const raw = "R".repeat(40_000);
    const out = processToolResult("read", "tu-read01", raw, SESSION);
    expect(out).toBe(raw);
  });

  test("maxChars 覆盖常量表：小阈值也落盘", () => {
    const raw = "X".repeat(50);
    const out = processToolResult("bash", "tu-ovr01", raw, SESSION, 10);
    expect(out).not.toBe(raw);
    expect(out).toContain("完整输出已保存到");
  });
});
