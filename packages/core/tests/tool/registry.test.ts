/**
 * 工具注册表测试
 */

import { describe, test, expect } from "bun:test";
import { Registry } from "@sid-code/core/tool/registry.ts";
// Registry 消费的是 LegacyTool（`name()` 方法形态 + `{ output }` 结果），
// 不是新版泛型 Tool（`readonly name` 字段 + `{ data }` 结果）。mock 必须按 registry
// 实际接受的接口写，否则 register() 传参处会类型不兼容。
import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
} from "@sid-code/core/tool/types.ts";

/** 测试用的 mock 工具 */
class MockTool implements Tool {
  constructor(private _name: string) {}
  name() {
    return this._name;
  }
  description() {
    return `Mock tool: ${this._name}`;
  }
  inputSchema() {
    return { type: "object", properties: {} };
  }
  async execute(): Promise<ToolResult> {
    return { output: "ok" };
  }
}

describe("ToolRegistry", () => {
  test("注册和查找工具", () => {
    const reg = new Registry();
    const tool = new MockTool("read");
    reg.register(tool);

    expect(reg.get("read")).toBe(tool);
    expect(reg.get("nonexistent")).toBeUndefined();
  });

  test("列举所有工具", () => {
    const reg = new Registry();
    reg.register(new MockTool("read"));
    reg.register(new MockTool("write"));
    reg.register(new MockTool("bash"));

    expect(reg.all().length).toBe(3);
    expect(reg.size()).toBe(3);
  });

  test("生成工具定义", () => {
    const reg = new Registry();
    reg.register(new MockTool("read"));

    const defs = reg.definitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe("read");
    expect(defs[0].description).toBe("Mock tool: read");
  });

  test("内置工具保持注册顺序，MCP 工具按名称排序（prompt cache 稳定性）", () => {
    const reg = new Registry();
    // 内置工具：人工编排顺序，不排序
    reg.register(new MockTool("read"));
    reg.register(new MockTool("bash"));
    // MCP 工具：以非字典序注册，验证组装时被排序
    reg.register(new MockTool("mcp__zeta"));
    reg.register(new MockTool("mcp__alpha"));
    reg.register(new MockTool("mcp__mid"));

    const pool = reg.assembleToolPool();
    const names = pool.map((t) => t.name());

    // 内置在前，保持注册顺序
    expect(names.slice(0, 2)).toEqual(["read", "bash"]);
    // MCP 在后，按名称升序
    expect(names.slice(2)).toEqual(["mcp__alpha", "mcp__mid", "mcp__zeta"]);
  });

  test("MCP 排序是确定性的（多次组装结果一致）", () => {
    const reg = new Registry();
    reg.register(new MockTool("mcp__c"));
    reg.register(new MockTool("mcp__a"));
    reg.register(new MockTool("mcp__b"));

    const first = reg.assembleToolPool().map((t) => t.name());
    const second = reg.assembleToolPool().map((t) => t.name());
    expect(first).toEqual(second);
    expect(first).toEqual(["mcp__a", "mcp__b", "mcp__c"]);
  });
});

/**
 * `removeByNames`（disallowedTools 的工具集裁剪端）
 *
 * ## 为什么断言的是「schema 不进上下文」而不是「调用被拒」
 *
 * `disallowedTools` 原先唯一落点是权限层（`checker.ts` Step 3），而 `check()` 对
 * `skipPermissions` 早退发生在 Step 3 **之前** —— 两个配置一起用时它是**静默空操作**
 * （实测 `{ allowed: true }`，零日志）。裁剪端存在的意义就是让被禁工具压根不进
 * `definitions()`：模型看不见 → 不会调 → 不会一轮一轮地换回拒绝。
 *
 * 所以这里的判据一律落在 `definitions()` / `get()` 上。若哪天有人把裁剪改回
 * "注册照旧、只在权限层拒"，下面第 1、3 条会红。
 */
describe("Registry.removeByNames（disallowedTools 裁剪）", () => {
  test("已注册的工具被移除，且不再出现在 definitions() 里", () => {
    const reg = new Registry();
    reg.register(new MockTool("web_search"));
    reg.register(new MockTool("read"));

    const removed = reg.removeByNames(["web_search"]);

    expect(removed).toEqual(["web_search"]);
    expect(reg.get("web_search")).toBeUndefined();
    // 关键判据：schema 不进上下文（不是"调用会被拒"）
    expect(reg.definitions().map((d) => d.name)).toEqual(["read"]);
  });

  test("名单里尚未注册的工具，之后注册也进不来（MCP 异步回填路径）", () => {
    const reg = new Registry();
    // 裁剪发生在启动阶段，此刻 MCP 还没连上、工具还没注册
    reg.removeByNames(["mcp__x__fetch"]);
    reg.register(new MockTool("read"));
    // MCP 连接完成后回填（生产里是 mcpManager.onToolsRefresh）
    reg.register(new MockTool("mcp__x__fetch"));

    // 只做一次性 delete 的实现会在这里放它进来，且不打任何日志
    expect(reg.get("mcp__x__fetch")).toBeUndefined();
    expect(reg.definitions().map((d) => d.name)).toEqual(["read"]);
  });

  test("按别名禁用时删的是真实工具名", () => {
    // 别名表当前为空（registry.ts aliases），故此处只锁"经 get() 解析"这条路径的形态：
    // 传原名要能删掉，且返回的是原名而非用户输入的大小写变体。
    const reg = new Registry();
    reg.register(new MockTool("web_fetch"));
    const removed = reg.removeByNames(["web_fetch"]);
    expect(removed).toEqual(["web_fetch"]);
  });

  test("空名单 / 空白项 / 不存在的名字都不报错，也不误删", () => {
    const reg = new Registry();
    reg.register(new MockTool("read"));

    expect(reg.removeByNames([])).toEqual([]);
    expect(reg.removeByNames(["  ", ""])).toEqual([]);
    expect(reg.removeByNames(["nonexistent"])).toEqual([]);
    expect(reg.definitions().map((d) => d.name)).toEqual(["read"]);
  });
});
