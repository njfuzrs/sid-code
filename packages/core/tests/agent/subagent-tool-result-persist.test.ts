/**
 * D9：子代理 executeTools 走 processToolResult，超阈值落盘而不是只截断
 *
 * 缺陷记录：docs-research/.../20260920-工具调用层-写入门文档时核出的缺陷.md
 *
 * 主循环已经把大输出写到 trajectories/sessions/{id}/tool-outputs/，模型侧留摘要 + 路径。
 * 子代理此前只 ContextManager.truncateToolOutput，完整结果丢掉。
 *
 * 本文件会写盘，必须显式 SID_CONFIG_DIR 隔离。
 *
 * fix_type: regression_guard
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ContentBlock } from "@sid-code/core/llm/types.ts";
import { executeTools } from "@sid-code/core/agent/tool-executor.ts";
import { assertIsolated } from "../helpers/assert-isolated.ts";

const SESSION = "test-subagent-d9";
let TMP_HOME: string;
const savedConfigDir = process.env.SID_CONFIG_DIR;

beforeAll(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), "sid-subagent-d9-"));
  process.env.SID_CONFIG_DIR = TMP_HOME;
  assertIsolated();
});

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedConfigDir;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function makeTool(name: string, output: string) {
  return {
    name: () => name,
    description: () => `mock ${name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => true,
    isConcurrencySafe: () => true,
    async execute() {
      return { output };
    },
  };
}

function makeRegistry(tools: ReturnType<typeof makeTool>[]) {
  const byName = new Map(tools.map((t) => [t.name(), t]));
  return { get: (name: string) => byName.get(name) ?? null } as any;
}

function toolUse(id: string, name: string): ContentBlock {
  return { type: "tool_use", id, name, input: {} } as ContentBlock;
}

const allowAll = { check: async () => ({ allowed: true }) } as any;

describe("D9 — 子代理 executeTools 走 processToolResult", () => {
  test("bash 超阈值：摘要含落盘路径，磁盘上是完整原文", async () => {
    const raw = "B".repeat(40_000);
    const tools = makeRegistry([makeTool("bash", raw)]);
    const results = await executeTools(
      [toolUse("tu-bash", "bash")],
      tools,
      undefined,
      undefined,
      allowAll,
      undefined,
      SESSION,
    );
    expect(results).toHaveLength(1);
    const content = results[0].type === "tool_result" ? results[0].content : "";
    expect(content).not.toBe(raw);
    expect(content).toContain("完整输出已保存到");
    expect(content).toContain("使用 read 工具查看完整内容");
    const match = content.match(/完整输出已保存到 (.+?)，共/);
    expect(match).toBeTruthy();
    const filepath = match![1];
    expect(existsSync(filepath)).toBe(true);
    expect(readFileSync(filepath, "utf8")).toBe(raw);
    expect(filepath).toContain(SESSION);
  });

  test("read 超长不截、不落盘（Infinity 阈值，防 Read→file→Read）", async () => {
    const raw = "R".repeat(40_000);
    const tools = makeRegistry([makeTool("read", raw)]);
    const results = await executeTools(
      [toolUse("tu-read", "read")],
      tools,
      undefined,
      undefined,
      allowAll,
      undefined,
      SESSION,
    );
    const content = results[0].type === "tool_result" ? results[0].content : "";
    expect(content).toBe(raw);
  });

  test("短 bash 原样返回", async () => {
    const tools = makeRegistry([makeTool("bash", "ok")]);
    const results = await executeTools(
      [toolUse("tu-short", "bash")],
      tools,
      undefined,
      undefined,
      allowAll,
      undefined,
      SESSION,
    );
    const content = results[0].type === "tool_result" ? results[0].content : "";
    expect(content).toBe("ok");
  });
});
