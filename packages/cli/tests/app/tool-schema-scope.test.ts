/**
 * 常驻工具 schema 的估算口径：必须是「实际会发出去的那一份」。
 *
 * 事故形态（2026-11-09，承接 PR #689 的状态栏初始占用显示）：`refreshToolSchemaTokens`
 * 用 `definitions()`（全量工具池）估 schema tokens，而 tool-search 下真正进请求的是
 * `activeDefinitions()`（`loop.ts:1838-1843`）。实测本机：内置全量 41 个工具估 14,616 tokens，
 * 实际首轮只发 24 个（10,773）；再加上全部延迟的 MCP 工具（context7/playwright/
 * chrome-devtools/lark-mcp/master-mcp 合计 24,941 tokens，一个都不发）——打开 TUI 时
 * 状态栏那个 `~X%` 就虚高约 1.4–2 倍，且 MCP 连上后还会再跳一档。
 *
 * 断言对着「口径选择」本身写（纯函数，不依赖 App 实例）：
 *  1. tool-search 非 false 时，延迟工具不得进估算；
 *  2. `toolSearch === false` 时首轮真发全量，必须全计入；
 *  3. tool_search 激活后的工具要重新进估算（否则估算反过来偏低）。
 */

import { describe, test, expect } from "bun:test";
import { Registry } from "@sid-code/core/tool/registry.ts";
import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
} from "@sid-code/core/tool/types.ts";
import { selectResidentToolDefinitions } from "@sid-code/cli/app.ts";

/** 可声明 shouldDefer 的 mock 工具（内置长尾工具的真实形态）。 */
class MockTool implements Tool {
  constructor(
    private _name: string,
    readonly shouldDefer = false,
  ) {}
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

/** 造一个「既有一等工具、又有延迟内置工具、又有 MCP 工具」的工具池。 */
function makeRegistry(): Registry {
  const reg = new Registry();
  reg.register(new MockTool("read"));
  reg.register(new MockTool("bash"));
  reg.register(new MockTool("notebook_edit", true)); // 内置长尾：shouldDefer
  reg.register(new MockTool("mcp__srv__tool_a")); // MCP：前缀默认延迟
  reg.register(new MockTool("mcp__srv__tool_b"));
  return reg;
}

const names = (defs: Array<{ name: string }>) => defs.map((d) => d.name).sort();

describe("selectResidentToolDefinitions：常驻 schema 只算实际会发的那份", () => {
  test("tool-search 开启（true）→ 延迟工具一律不计入常驻估算", () => {
    const selected = names(selectResidentToolDefinitions(makeRegistry(), true));

    expect(selected).toEqual(["bash", "read"]);
    // 三种延迟形态都不能漏判：shouldDefer、mcp__ 前缀
    expect(selected).not.toContain("notebook_edit");
    expect(selected).not.toContain("mcp__srv__tool_a");
    expect(selected).not.toContain("mcp__srv__tool_b");
  });

  test('tool-search "auto" / 百分比档同样按非延迟子集算（默认走延迟）', () => {
    // "auto" 与数字档在配置层无法确定最终是否启用，按「会延迟」保守处理 ——
    // 与 config/deferred-tool-view.ts 的 isStaticallyDeferred 同一取舍。
    for (const mode of ["auto", 30] as const) {
      const selected = names(selectResidentToolDefinitions(makeRegistry(), mode));
      expect(selected, String(mode)).toEqual(["bash", "read"]);
    }
  });

  test("toolSearch === false → 首轮真发全量，必须全计入（这一档不能用 activeDefinitions）", () => {
    const selected = names(selectResidentToolDefinitions(makeRegistry(), false));

    expect(selected).toEqual([
      "bash",
      "mcp__srv__tool_a",
      "mcp__srv__tool_b",
      "notebook_edit",
      "read",
    ]);
  });

  test("未传 toolSearch（undefined）→ 按「会延迟」处理（默认配置就是 true）", () => {
    const selected = names(selectResidentToolDefinitions(makeRegistry(), undefined));
    expect(selected).toEqual(["bash", "read"]);
  });

  test("tool_search 激活延迟工具后重新计入常驻估算（激活即进请求，漏了会反过来偏低）", () => {
    const reg = makeRegistry();
    expect(names(selectResidentToolDefinitions(reg, true))).not.toContain("mcp__srv__tool_a");

    expect(reg.activateTool("mcp__srv__tool_a")).toBe(true);

    const selected = names(selectResidentToolDefinitions(reg, true));
    expect(selected).toContain("mcp__srv__tool_a");
    // 未激活的同批工具仍然不计入
    expect(selected).not.toContain("mcp__srv__tool_b");
  });
});
