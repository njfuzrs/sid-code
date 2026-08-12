/**
 * ToolSearchTool + Registry 运行时激活回归测试
 *
 * 守护"工具接口现代化"P0：延迟工具的 AI 可调用调出入口。
 * - ToolSearchTool select: 精确激活 / 关键词搜索两种模式
 * - Registry.activateTool 把延迟工具切到激活态，进 activeDefinitions
 */

import { describe, test, expect } from "bun:test";
import { Registry } from "@sid-code/core/tool/registry.ts";
import { ToolSearchTool } from "@sid-code/core/tool/tool-search.ts";
import type { LegacyTool } from "@sid-code/core/tool/types.ts";

function mkTool(name: string, extra: Partial<LegacyTool> = {}): LegacyTool {
  return {
    name: () => name,
    description: () => `desc of ${name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "" }),
    ...extra,
  };
}

describe("Registry — 运行时激活（activateTool）", () => {
  test("激活 shouldDefer 工具：进 activeDefinitions", () => {
    const r = new Registry();
    r.register(mkTool("notebook", { shouldDefer: true, searchHint: "jupyter" }));
    expect(r.activeDefinitions().map((d) => d.name)).not.toContain("notebook");

    expect(r.activateTool("notebook")).toBe(true);
    expect(r.isActivated("notebook")).toBe(true);
    expect(r.activeDefinitions().map((d) => d.name)).toContain("notebook");
  });

  test("激活本就可见的工具：返回 false（无需激活）", () => {
    const r = new Registry();
    r.register(mkTool("read"));
    expect(r.activateTool("read")).toBe(false);
  });

  test("激活未注册工具：返回 false", () => {
    const r = new Registry();
    expect(r.activateTool("ghost")).toBe(false);
  });

  test("markDeferred 撤回激活态", () => {
    const r = new Registry();
    r.register(mkTool("x", { shouldDefer: true }));
    r.activateTool("x");
    expect(r.isActivated("x")).toBe(true);
    r.markDeferred("x");
    expect(r.isActivated("x")).toBe(false);
    expect(r.activeDefinitions().map((d) => d.name)).not.toContain("x");
  });

  test("alwaysLoad 工具：首轮直入 activeDefinitions（不进延迟池）", () => {
    // 对标 ask_user_question 的加载策略：交互类刚需工具首轮就带完整 schema，
    // 无需一轮 tool_search 往返，避免模型凭记忆猜参数结构盲调翻车。
    const r = new Registry();
    r.register(mkTool("ask", { alwaysLoad: true, searchHint: "ask question" }));
    expect(r.isDeferred("ask")).toBe(false);
    expect(r.activeDefinitions().map((d) => d.name)).toContain("ask");
  });

  test("alwaysLoad 优先级高于 shouldDefer（同时声明时仍首轮可见）", () => {
    // isToolDeferred 里 alwaysLoad 的 return false 排在 shouldDefer 判定之前。
    const r = new Registry();
    r.register(mkTool("both", { alwaysLoad: true, shouldDefer: true }));
    expect(r.isDeferred("both")).toBe(false);
    expect(r.activeDefinitions().map((d) => d.name)).toContain("both");
  });
});

describe("Registry — 延迟加载定档标志（setToolSearchEnabled）", () => {
  test("默认 false，setter 往返读回一致", () => {
    const r = new Registry();
    expect(r.isToolSearchEnabled()).toBe(false);
    r.setToolSearchEnabled(true);
    expect(r.isToolSearchEnabled()).toBe(true);
    r.setToolSearchEnabled(false);
    expect(r.isToolSearchEnabled()).toBe(false);
  });
});

describe("ToolSearchTool — select: 精确激活", () => {
  test("select 单个延迟工具", async () => {
    const r = new Registry();
    r.register(mkTool("notebook", { shouldDefer: true }));
    r.register(new ToolSearchTool(r) as unknown as LegacyTool);

    const ts = new ToolSearchTool(r);
    const res = await ts.execute({ query: "select:notebook" });
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("已激活");
    expect(r.isActivated("notebook")).toBe(true);
  });

  test("select 多个工具（逗号分隔），含未找到与本就可见", async () => {
    const r = new Registry();
    r.register(mkTool("a", { shouldDefer: true }));
    r.register(mkTool("b", { shouldDefer: true }));
    r.register(mkTool("visible")); // 本就可见
    const ts = new ToolSearchTool(r);

    const res = await ts.execute({ query: "select:a,b,visible,ghost" });
    expect(r.isActivated("a")).toBe(true);
    expect(r.isActivated("b")).toBe(true);
    expect(res.output).toContain("本就可用"); // visible
    expect(res.output).toContain("未找到"); // ghost
  });
});

describe("ToolSearchTool — 关键词搜索", () => {
  test("命中即激活", async () => {
    const r = new Registry();
    r.register(mkTool("notebook", { shouldDefer: true, searchHint: "jupyter cell" }));
    r.register(mkTool("read"));
    const ts = new ToolSearchTool(r);

    const res = await ts.execute({ query: "jupyter" });
    expect(res.output).toContain("notebook");
    expect(r.isActivated("notebook")).toBe(true);
  });

  test("无命中：给出引导提示", async () => {
    const r = new Registry();
    r.register(mkTool("notebook", { shouldDefer: true, searchHint: "jupyter" }));
    const ts = new ToolSearchTool(r);

    const res = await ts.execute({ query: "数据库迁移" });
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("没有找到");
  });

  test("max_results 截断", async () => {
    const r = new Registry();
    for (let i = 0; i < 10; i++) {
      r.register(mkTool(`tool${i}`, { shouldDefer: true, searchHint: "common keyword" }));
    }
    const ts = new ToolSearchTool(r);
    const res = await ts.execute({ query: "common", max_results: 3 });
    // 输出里激活的工具行数 = 3
    const activatedCount = res.output
      .split("\n")
      .filter((l) => l.trim().startsWith("- tool")).length;
    expect(activatedCount).toBe(3);
  });

  test("空 query 报错", async () => {
    const r = new Registry();
    const ts = new ToolSearchTool(r);
    const res = await ts.execute({ query: "   " });
    expect(res.isError).toBe(true);
  });
});

describe("ToolSearchTool — 自身能力声明", () => {
  test("alwaysLoad=true（绝不被延迟，否则机制死锁）", () => {
    const r = new Registry();
    const ts = new ToolSearchTool(r);
    expect(ts.alwaysLoad).toBe(true);
    r.register(ts as unknown as LegacyTool);
    r.markDeferred("tool_search");
    // 即使被标记延迟，alwaysLoad 强制首轮可见
    expect(r.activeDefinitions().map((d) => d.name)).toContain("tool_search");
  });

  test("zodSchema 校验：query 必填", () => {
    const r = new Registry();
    const ts = new ToolSearchTool(r);
    const parsed = ts.zodSchema!.safeParse({});
    expect(parsed.success).toBe(false);
  });

  test("zodSchema 校验：max_results 默认 5", () => {
    const r = new Registry();
    const ts = new ToolSearchTool(r);
    const parsed = ts.zodSchema!.safeParse({ query: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect((parsed.data as any).max_results).toBe(5);
  });
});

describe("Registry — MCP 工具默认延迟", () => {
  test("mcp__ 前缀工具自动延迟，不进 activeDefinitions", () => {
    const r = new Registry();
    r.register(mkTool("read"));
    r.register(mkTool("mcp__github__create_issue"));
    const active = r.activeDefinitions().map((d) => d.name);
    expect(active).toContain("read");
    expect(active).not.toContain("mcp__github__create_issue");
    // 但全量 definitions 仍包含
    expect(r.definitions().map((d) => d.name)).toContain("mcp__github__create_issue");
  });

  test("MCP 工具 alwaysLoad 可豁免延迟", () => {
    const r = new Registry();
    r.register(mkTool("mcp__ide__getDiagnostics", { alwaysLoad: true }));
    expect(r.activeDefinitions().map((d) => d.name)).toContain("mcp__ide__getDiagnostics");
  });

  test("MCP 工具计入 deferredToolNames", () => {
    const r = new Registry();
    r.register(mkTool("mcp__a__x"));
    r.register(mkTool("mcp__b__y"));
    r.register(mkTool("read"));
    expect(r.deferredToolNames()).toEqual(["mcp__a__x", "mcp__b__y"]);
  });

  test("MCP 工具可经 tool_search 激活", () => {
    const r = new Registry();
    r.register(mkTool("mcp__github__create_issue"));
    expect(r.activateTool("mcp__github__create_issue")).toBe(true);
    expect(r.activeDefinitions().map((d) => d.name)).toContain("mcp__github__create_issue");
  });
});

describe("Registry — deferredToolNames", () => {
  test("返回排序去重的延迟工具名", () => {
    const r = new Registry();
    r.register(mkTool("notebook", { shouldDefer: true }));
    r.register(mkTool("cron", { shouldDefer: true }));
    r.register(mkTool("read"));
    expect(r.deferredToolNames()).toEqual(["cron", "notebook"]);
  });

  test("激活后从延迟名单移除", () => {
    const r = new Registry();
    r.register(mkTool("notebook", { shouldDefer: true }));
    r.activateTool("notebook");
    expect(r.deferredToolNames()).toEqual([]);
  });
});

describe("ToolSearchTool — 裸工具名快路径", () => {
  test("query 直接是工具名（无 select: 前缀）也能激活", async () => {
    const r = new Registry();
    r.register(mkTool("notebook", { shouldDefer: true }));
    const ts = new ToolSearchTool(r);
    const res = await ts.execute({ query: "notebook" });
    expect(res.output).toContain("已激活");
    expect(r.isActivated("notebook")).toBe(true);
  });

  test("裸名命中已加载工具：提示本就可用（无重试 churn）", async () => {
    const r = new Registry();
    r.register(mkTool("read"));
    const ts = new ToolSearchTool(r);
    const res = await ts.execute({ query: "read" });
    expect(res.output).toContain("本就可用");
  });
});
