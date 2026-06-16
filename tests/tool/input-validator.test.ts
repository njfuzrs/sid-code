/**
 * 工具输入 zod 校验层回归测试
 *
 * 守护"工具接口现代化"P1-2 的核心能力：在工具边界用 zodSchema 拦截畸形参数，
 * 给模型友好的结构化错误（提升自我纠错成功率），而不是带病执行后抛晦涩异常。
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod/v4";
import { validateToolInput } from "../../src/tool/input-validator.ts";
import type { LegacyTool } from "../../src/tool/types.ts";

/** 构造一个最小 LegacyTool 桩，可选注入 zodSchema */
function mkTool(name: string, zodSchema?: LegacyTool["zodSchema"]): LegacyTool {
  return {
    name: () => name,
    description: () => `desc ${name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "" }),
    zodSchema,
  };
}

describe("validateToolInput", () => {
  test("无 zodSchema 的工具：原样放行（回退工具内部手工检查）", () => {
    const tool = mkTool("legacy");
    const r = validateToolInput(tool, { anything: 123 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ anything: 123 });
  });

  test("合法输入：safeParse 通过，返回校验后的 data", () => {
    const tool = mkTool(
      "read",
      z.object({ file_path: z.string(), offset: z.number().optional() }),
    );
    const r = validateToolInput(tool, { file_path: "/a/b" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ file_path: "/a/b" });
  });

  test("类型不符：在工具边界拦截，返回结构化中文错误", () => {
    const tool = mkTool(
      "read",
      z.object({ file_path: z.string(), offset: z.number().optional() }),
    );
    const r = validateToolInput(tool, { file_path: 123 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // 错误消息应点名工具、字段、期望/实际类型，便于模型精准纠错
      expect(r.message).toContain("参数校验失败");
      expect(r.message).toContain("read");
      expect(r.message).toContain("file_path");
      expect(r.message).toContain("string");
    }
  });

  test("缺少必填字段：拦截并指出字段路径", () => {
    const tool = mkTool("read", z.object({ file_path: z.string() }));
    const r = validateToolInput(tool, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("file_path");
  });

  test("多字段同时出错：逐条列出", () => {
    const tool = mkTool(
      "read",
      z.object({ file_path: z.string(), offset: z.number() }),
    );
    const r = validateToolInput(tool, { file_path: 1, offset: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("file_path");
      expect(r.message).toContain("offset");
    }
  });

  test("额外字段（如注入的 _agentId）：默认剥离而非报错", () => {
    // 这是子代理/plan 工具注入 _agentId 防套娃的关键保障：
    // 严格 schema 的 additionalProperties:false 不会因 _agentId 拒绝输入，
    // zod 默认剥离未声明字段。
    const tool = mkTool("enter_plan_mode", z.object({}));
    const r = validateToolInput(tool, { _agentId: "sub-agent" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({});
  });

  test("enum 字段非法值：拦截", () => {
    const tool = mkTool(
      "memory",
      z.object({ scope: z.enum(["global", "project"]).optional() }),
    );
    const ok = validateToolInput(tool, { scope: "project" });
    expect(ok.ok).toBe(true);
    const bad = validateToolInput(tool, { scope: "invalid" });
    expect(bad.ok).toBe(false);
  });

  test("嵌套数组对象：逐层校验", () => {
    const tool = mkTool(
      "todo_write",
      z.object({
        todos: z.array(
          z.object({ content: z.string(), status: z.enum(["pending", "done"]) }),
        ),
      }),
    );
    const ok = validateToolInput(tool, {
      todos: [{ content: "x", status: "pending" }],
    });
    expect(ok.ok).toBe(true);
    const bad = validateToolInput(tool, {
      todos: [{ content: "x", status: "BAD" }],
    });
    expect(bad.ok).toBe(false);
  });
});
