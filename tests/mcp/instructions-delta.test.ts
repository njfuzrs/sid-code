/**
 * mcp/instructions-delta.ts 测试
 *
 * 此前 getMcpInstructionsDelta / buildMcpInstructionsSection 是零调用死代码（server
 * instructions 从未进入模型上下文）。接线后经 reminderParts 增量注入（cache-safe），
 * 本测试锁定其去重语义：同一 server 只播报一次，新 server 增量播报。
 */

import { describe, test, expect } from "bun:test";
import {
  getMcpInstructionsDelta,
  buildMcpInstructionsSection,
} from "../../src/mcp/instructions-delta.ts";
import { MCPConnectionStatus } from "../../src/mcp/types.ts";
import type { MCPServerStatusInfo } from "../../src/mcp/manager.ts";

function status(over: Partial<MCPServerStatusInfo> = {}): MCPServerStatusInfo {
  return {
    name: "srv",
    status: MCPConnectionStatus.CONNECTED,
    toolCount: 1,
    resourceCount: 0,
    promptCount: 0,
    transport: "stdio",
    instructions: "use tool X carefully",
    ...over,
  };
}

describe("getMcpInstructionsDelta", () => {
  test("首个已连接且带 instructions 的 server → 返回块并登记", () => {
    const announced = new Set<string>();
    const delta = getMcpInstructionsDelta([status({ name: "a" })], announced);
    expect(delta).not.toBeNull();
    expect(delta!.added).toEqual(["a"]);
    expect(delta!.blocks[0]).toContain("## a");
    expect(delta!.blocks[0]).toContain("use tool X carefully");
  });

  test("已播报过的 server 不再重复（去重）", () => {
    const announced = new Set<string>(["a"]);
    const delta = getMcpInstructionsDelta([status({ name: "a" })], announced);
    expect(delta).toBeNull();
  });

  test("仅返回新连接的 server（增量）", () => {
    const announced = new Set<string>(["a"]);
    const delta = getMcpInstructionsDelta(
      [status({ name: "a" }), status({ name: "b", instructions: "b-guide" })],
      announced,
    );
    expect(delta!.added).toEqual(["b"]);
    expect(delta!.blocks.join("")).toContain("b-guide");
  });

  test("未连接 / 无 instructions 的 server 被跳过", () => {
    const announced = new Set<string>();
    const delta = getMcpInstructionsDelta(
      [
        status({ name: "connecting", status: MCPConnectionStatus.CONNECTING }),
        status({ name: "no-instr", instructions: undefined }),
      ],
      announced,
    );
    expect(delta).toBeNull();
  });
});

describe("buildMcpInstructionsSection", () => {
  test("拼接所有已连接 server 的 instructions", () => {
    const section = buildMcpInstructionsSection([
      status({ name: "a", instructions: "a-guide" }),
      status({ name: "b", instructions: "b-guide" }),
    ]);
    expect(section).toContain("# MCP Server Instructions");
    expect(section).toContain("## a");
    expect(section).toContain("a-guide");
    expect(section).toContain("## b");
    expect(section).toContain("b-guide");
  });

  test("无可用 server → 空串", () => {
    expect(buildMcpInstructionsSection([])).toBe("");
  });
});
