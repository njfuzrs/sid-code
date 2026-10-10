/**
 * 多代理 F2：一次 queryLoop 内晚到的 MCP 工具不进本轮 schema，工具区字节不在任务中途变化。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { snapshotMcpToolNames, withholdLateMcpTools } from "@sid-code/core/tool/late-mcp-freeze.ts";

const def = (name: string) => ({ name, description: name, inputSchema: {} }) as any;

describe("withholdLateMcpTools", () => {
  test("快照之后才出现的 MCP 工具被暂缓，内置与已有 MCP 工具保留", () => {
    const start = [def("bash"), def("mcp__a__x"), def("read")];
    const baseline = snapshotMcpToolNames(start);
    expect([...baseline]).toEqual(["mcp__a__x"]);

    const later = [def("bash"), def("mcp__a__x"), def("mcp__b__y"), def("mcp__b__z"), def("read")];
    const r = withholdLateMcpTools(later, baseline);
    expect(r.defs.map((d) => d.name)).toEqual(["bash", "mcp__a__x", "read"]);
    expect(r.withheld).toEqual(["mcp__b__y", "mcp__b__z"]);
    // 发出去的工具数组与首轮逐项一致——工具区前缀不变
    expect(JSON.stringify(r.defs)).toBe(JSON.stringify(start));
  });

  test("不冻结内置工具的增减（模式切换导致的 isEnabled 变化是有意的）", () => {
    const baseline = snapshotMcpToolNames([def("bash")]);
    const r = withholdLateMcpTools([def("bash"), def("write")], baseline);
    expect(r.withheld).toEqual([]);
    expect(r.defs.length).toBe(2);
  });

  test("主循环接线：延迟加载关闭时才建快照，且发请求前过滤", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/query/loop.ts"), "utf-8");
    expect(src).toMatch(
      /const mcpToolsAtLoopStart = toolSearchEnabled\s*\?\s*undefined\s*:\s*snapshotMcpToolNames\(/,
    );
    expect(src).toMatch(/withholdLateMcpTools\(toolDefs, mcpToolsAtLoopStart\)/);
  });
});
