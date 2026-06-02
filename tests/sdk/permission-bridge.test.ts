/**
 * Phase 3 单测：SDK 权限桥接（Hook ↔ SDK 宿主竞速）
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { StructuredIO } from "../../src/sdk/structured-io.ts";
import { createSDKCanUseTool } from "../../src/sdk/permission-bridge.ts";
import { ndjsonStringify } from "../../src/sdk/ndjson.ts";

/**
 * 构造一个 StructuredIO，并自动用给定 behavior 回复 can_use_tool 控制请求。
 * 返回 io 与一个停止函数。
 */
function makeIOWithHost(behavior: "allow" | "deny" | "always_allow" | null) {
  const input = new PassThrough();
  const output = new PassThrough();
  const io = new StructuredIO(input, output);

  // 后台 drain read（消费 control_response）
  (async () => {
    for await (const _ of io.read()) {
      /* drain */
    }
  })();

  if (behavior !== null) {
    output.on("data", (c) => {
      const line = c.toString("utf-8").trim();
      if (!line) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === "control_request" && msg.request?.subtype === "can_use_tool") {
        input.write(
          ndjsonStringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: msg.request_id,
              response: { behavior, tool_use_id: msg.request.tool_use_id },
            },
          }) + "\n",
        );
      }
    });
  }

  return { io, input, output };
}

describe("createSDKCanUseTool — 无 Hook", () => {
  test("SDK 宿主 allow", async () => {
    const { io } = makeIOWithHost("allow");
    const canUseTool = createSDKCanUseTool({ structuredIO: io });
    const result = await canUseTool("Bash", { command: "ls" }, "t1");
    expect(result).toBe("allow");
    expect(io.isResolvedToolUseId("t1")).toBe(true);
  });

  test("SDK 宿主 deny", async () => {
    const { io } = makeIOWithHost("deny");
    const canUseTool = createSDKCanUseTool({ structuredIO: io });
    const result = await canUseTool("Bash", { command: "rm -rf /" }, "t2");
    expect(result).toBe("deny");
  });

  test("SDK 宿主 always_allow", async () => {
    const { io } = makeIOWithHost("always_allow");
    const canUseTool = createSDKCanUseTool({ structuredIO: io });
    const result = await canUseTool("Read", { path: "/x" }, "t3");
    expect(result).toBe("always_allow");
  });
});

describe("createSDKCanUseTool — Hook 竞速", () => {
  test("Hook 先 deny → 胜出，不等 SDK 宿主", async () => {
    // SDK 宿主永不回复（behavior=null）
    const { io } = makeIOWithHost(null);
    const fakeHook: any = {
      firePreToolUseEvent: async () => ({
        finalOutput: {
          isBlockingDecision: () => true,
          decision: "deny",
        },
      }),
    };
    const canUseTool = createSDKCanUseTool({ structuredIO: io, hookSystem: fakeHook });
    const result = await canUseTool("Bash", { command: "x" }, "t4");
    expect(result).toBe("deny");
  });

  test("Hook 先 allow → 胜出", async () => {
    const { io } = makeIOWithHost(null);
    const fakeHook: any = {
      firePreToolUseEvent: async () => ({
        finalOutput: {
          isBlockingDecision: () => false,
          decision: "allow",
        },
      }),
    };
    const canUseTool = createSDKCanUseTool({ structuredIO: io, hookSystem: fakeHook });
    const result = await canUseTool("Read", {}, "t5");
    expect(result).toBe("allow");
  });

  test("Hook 不决定（null）→ 落到 SDK 宿主", async () => {
    const { io } = makeIOWithHost("allow");
    const fakeHook: any = {
      firePreToolUseEvent: async () => ({
        finalOutput: {
          isBlockingDecision: () => false,
          decision: undefined,
        },
      }),
    };
    const canUseTool = createSDKCanUseTool({ structuredIO: io, hookSystem: fakeHook });
    const result = await canUseTool("Bash", {}, "t6");
    expect(result).toBe("allow");
  });

  test("Hook 抛错 → 视为不决定，落到 SDK 宿主", async () => {
    const { io } = makeIOWithHost("deny");
    const fakeHook: any = {
      firePreToolUseEvent: async () => {
        throw new Error("hook crashed");
      },
    };
    const canUseTool = createSDKCanUseTool({ structuredIO: io, hookSystem: fakeHook });
    const result = await canUseTool("Bash", {}, "t7");
    expect(result).toBe("deny");
  });
});
