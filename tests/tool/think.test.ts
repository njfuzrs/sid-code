/**
 * G19 落地回归测试：think 工具（首个新泛型 buildTool + bridge 注册）
 *
 * 守护三件事：
 * 1. thinkTool 是用新泛型 buildTool() 定义的 Tool（有 name/call/zodSchema）
 * 2. 经 toLegacyTool bridge 后能正确执行，data→output 转换正确
 * 3. 能力字段（isReadOnly / isConcurrencySafe / toAutoClassifierInput）经 bridge 透传
 * 4. 注册到 Registry 后 LLM 定义来自 zodSchema（与运行时校验同源）
 */

import { describe, test, expect } from "bun:test";
import { thinkTool, createThinkTool } from "../../src/tool/think.ts";
import { Registry } from "../../src/tool/registry.ts";

describe("G19 — think 新泛型工具", () => {
  test("thinkTool 是新泛型 Tool：name 为字符串属性、call 为方法", () => {
    expect(thinkTool.name).toBe("think");
    expect(typeof thinkTool.call).toBe("function");
    expect(thinkTool.zodSchema).toBeDefined();
    expect(thinkTool.isReadOnly()).toBe(true);
    expect(thinkTool.isConcurrencySafe()).toBe(true);
  });

  test("call 记录思考，返回 data", async () => {
    const ctx = { abortSignal: new AbortController().signal } as any;
    const ok = await thinkTool.call({ thought: "先读配置再动手" }, ctx);
    expect(ok.isError).toBeUndefined();
    expect(ok.data).toContain("已记录思考");

    const empty = await thinkTool.call({ thought: "  " }, ctx);
    expect(empty.isError).toBe(true);
  });

  test("经 bridge 适配为 LegacyTool：execute 正确，能力字段透传", async () => {
    const legacy = createThinkTool();
    expect(legacy.name()).toBe("think");
    expect(legacy.readOnly?.()).toBe(true);
    expect(legacy.isConcurrencySafe?.({})).toBe(true);
    // toAutoClassifierInput 透传（自报与安全无关 → 返回空串）
    expect(legacy.toAutoClassifierInput?.({ thought: "x" })).toBe("");

    const res = await legacy.execute({ thought: "验证 bridge 执行链路" });
    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("已记录思考");
  });

  test("注册到 Registry 后 input_schema 来自 zodSchema", () => {
    const r = new Registry();
    r.register(createThinkTool());
    const def = r.definitions().find((d) => d.name === "think")!;
    expect(def).toBeDefined();
    const schema = def.input_schema as any;
    expect(schema.properties.thought.type).toBe("string");
    expect(schema.required).toEqual(["thought"]);
  });
});
