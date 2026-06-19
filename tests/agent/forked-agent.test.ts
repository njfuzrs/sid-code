/**
 * Forked Agent + 提取权限测试（Task 3）
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runForkedAgent, type ForkedAgentContext } from "../../src/agent/forked-agent.ts";
import { Registry as ToolRegistry } from "../../src/tool/registry.ts";
import {
  createExtractPermissions,
  createSessionMemoryPermissions,
} from "../../src/memory/extract/permissions.ts";
import { hasMemoryWritesSince, extractWrittenPaths } from "../../src/memory/extract/extractor.ts";
import type { Message } from "../../src/llm/types.ts";
import type { PermissionResult } from "../../src/tool/types.ts";

/** 同步断言权限结果的 behavior（permissions 函数实际是同步的） */
function behaviorOf(r: PermissionResult | Promise<PermissionResult>): string {
  return (r as PermissionResult).behavior;
}

/** 构造一个返回脚本化事件序列的 mock provider */
function mockProvider(scripts: any[][]) {
  let call = 0;
  return {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream() {
      const events = scripts[call] ?? [{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 1 } }];
      call++;
      for (const e of events) yield e;
    },
  };
}

/** 简单的回显工具 */
class EchoTool {
  name() { return "read"; }
  description() { return "读取文件"; }
  inputSchema() { return { type: "object", properties: { file_path: { type: "string" } } }; }
  async execute(input: any) { return { output: `read: ${JSON.stringify(input)}` }; }
  readOnly() { return true; }
}

function makeContext(provider: any): ForkedAgentContext {
  const registry = new ToolRegistry();
  registry.register(new EchoTool() as any);
  return {
    systemPrompt: "system",
    messages: [{ role: "user", content: [{ type: "text", text: "原始对话" }] }],
    provider,
    toolRegistry: registry,
    model: "mock-model",
  };
}

describe("runForkedAgent", () => {
  test("无工具调用时单轮结束", async () => {
    const provider = mockProvider([
      [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "完成" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 5 } },
      ],
    ]);
    const ctx = makeContext(provider);
    const result = await runForkedAgent(ctx, {
      promptMessages: [{ role: "user", content: [{ type: "text", text: "提取" }] }],
      canUseTool: () => ({ behavior: "allow" }),
      maxTurns: 5,
      querySource: "test",
    });
    expect(result.turns).toBe(1);
    expect(result.messages.length).toBeGreaterThanOrEqual(2); // prompt + assistant
  });

  test("工具调用被 canUseTool 拒绝时记录 denied", async () => {
    const provider = mockProvider([
      [
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "read" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"/etc/passwd"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { outputTokens: 5 } },
      ],
      // 第二轮：模型收到拒绝结果后结束
      [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好的" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 5 } },
      ],
    ]);
    const ctx = makeContext(provider);
    const result = await runForkedAgent(ctx, {
      promptMessages: [{ role: "user", content: [{ type: "text", text: "提取" }] }],
      canUseTool: (name) => name === "read" ? { behavior: "deny", message: "禁止" } : { behavior: "allow" },
      maxTurns: 5,
      querySource: "test",
    });
    expect(result.deniedToolCalls).toBe(1);
  });

  test("maxTurns 硬性上限生效", async () => {
    // 每轮都返回工具调用，永不自然结束
    const toolTurn = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "read" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"a"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { outputTokens: 1 } },
    ];
    const provider = mockProvider([toolTurn, toolTurn, toolTurn, toolTurn, toolTurn, toolTurn]);
    const ctx = makeContext(provider);
    const result = await runForkedAgent(ctx, {
      promptMessages: [{ role: "user", content: [{ type: "text", text: "提取" }] }],
      canUseTool: () => ({ behavior: "allow" }),
      maxTurns: 3,
      querySource: "test",
    });
    expect(result.turns).toBe(3);
  });

  test("缺口 A：注入的 statefulTools 优先于主注册表（FileReadTracker 隔离）", async () => {
    // 一轮工具调用 read，随后自然结束
    const provider = mockProvider([
      [
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "read" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"a"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { outputTokens: 1 } },
      ],
      [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 1 } },
      ],
    ]);

    // 主注册表里的 read 工具：被调用即标记（不该被命中）
    let mainCalled = false;
    class MainRead {
      name() { return "read"; }
      description() { return "main"; }
      inputSchema() { return { type: "object", properties: { file_path: { type: "string" } } }; }
      async execute() { mainCalled = true; return { output: "main-read" }; }
      readOnly() { return true; }
    }
    // 注入的独立 read 工具：被调用即标记（应被命中）
    let injectedCalled = false;
    class InjectedRead {
      name() { return "read"; }
      description() { return "injected"; }
      inputSchema() { return { type: "object", properties: { file_path: { type: "string" } } }; }
      async execute() { injectedCalled = true; return { output: "injected-read" }; }
      readOnly() { return true; }
    }

    const registry = new ToolRegistry();
    registry.register(new MainRead() as any);
    const ctx: ForkedAgentContext = {
      systemPrompt: "system",
      messages: [{ role: "user", content: [{ type: "text", text: "原始对话" }] }],
      provider,
      toolRegistry: registry,
      model: "mock-model",
      statefulTools: [new InjectedRead() as any],
    };

    await runForkedAgent(ctx, {
      promptMessages: [{ role: "user", content: [{ type: "text", text: "读文件" }] }],
      canUseTool: () => ({ behavior: "allow" }),
      maxTurns: 5,
      querySource: "test",
    });

    expect(injectedCalled).toBe(true);   // 命中注入的独立工具
    expect(mainCalled).toBe(false);      // 主注册表实例未被污染调用
  });

  test("缺口 A：未注入 statefulTools 时回退主注册表（向后兼容）", async () => {
    const provider = mockProvider([
      [
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "read" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"a"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { outputTokens: 1 } },
      ],
      [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 1 } },
      ],
    ]);

    let mainCalled = false;
    class MainRead {
      name() { return "read"; }
      description() { return "main"; }
      inputSchema() { return { type: "object", properties: { file_path: { type: "string" } } }; }
      async execute() { mainCalled = true; return { output: "main-read" }; }
      readOnly() { return true; }
    }
    const registry = new ToolRegistry();
    registry.register(new MainRead() as any);
    const ctx: ForkedAgentContext = {
      systemPrompt: "system",
      messages: [{ role: "user", content: [{ type: "text", text: "原始对话" }] }],
      provider,
      toolRegistry: registry,
      model: "mock-model",
      // 不传 statefulTools
    };

    await runForkedAgent(ctx, {
      promptMessages: [{ role: "user", content: [{ type: "text", text: "读文件" }] }],
      canUseTool: () => ({ behavior: "allow" }),
      maxTurns: 5,
      querySource: "test",
    });

    expect(mainCalled).toBe(true);  // 回退到主注册表
  });
});

describe("createExtractPermissions", () => {
  let memDir: string;
  const perms = () => createExtractPermissions(memDir);

  memDir = mkdtempSync(join(tmpdir(), "sid-extract-"));

  test("只读工具放行", () => {
    expect(behaviorOf(perms()("read", {}))).toBe("allow");
    expect(behaviorOf(perms()("grep", {}))).toBe("allow");
  });

  test("save_memory 放行", () => {
    expect(behaviorOf(perms()("save_memory", { key: "k", value: "v" }))).toBe("allow");
  });

  test("write 到 memoryDir 内放行", () => {
    const target = join(memDir, "user_x.md");
    expect(behaviorOf(perms()("write", { file_path: target }))).toBe("allow");
  });

  test("write 到 memoryDir 外拒绝", () => {
    expect(behaviorOf(perms()("write", { file_path: "/etc/passwd" }))).toBe("deny");
  });

  test("只读 bash 放行，写入 bash 拒绝", () => {
    expect(behaviorOf(perms()("bash", { command: "ls -la" }))).toBe("allow");
    expect(behaviorOf(perms()("bash", { command: "rm -rf /" }))).toBe("deny");
    expect(behaviorOf(perms()("bash", { command: "echo hi > file" }))).toBe("deny");
  });

  test("其他工具拒绝", () => {
    expect(behaviorOf(perms()("web_fetch", {}))).toBe("deny");
    expect(behaviorOf(perms()("mcp__foo__bar", {}))).toBe("deny");
  });

  rmSync(memDir, { recursive: true, force: true });
});

describe("createSessionMemoryPermissions", () => {
  const file = "/tmp/sid-test/.session_memory.md";
  const perms = createSessionMemoryPermissions(file);

  test("只能编辑指定文件", () => {
    expect(behaviorOf(perms("edit", { file_path: file }))).toBe("allow");
    expect(behaviorOf(perms("edit", { file_path: "/tmp/other.md" }))).toBe("deny");
  });

  test("拒绝其他工具", () => {
    expect(behaviorOf(perms("save_memory", {}))).toBe("deny");
  });
});

describe("hasMemoryWritesSince / extractWrittenPaths", () => {
  const memDir = "/tmp/sid-mem-dir";

  test("检测 save_memory 调用", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "记住这个" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "save_memory", input: { key: "k", value: "v" } }] },
    ];
    expect(hasMemoryWritesSince(messages, memDir)).toBe(true);
  });

  test("无记忆写入返回 false", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { file_path: "x" } }] },
    ];
    expect(hasMemoryWritesSince(messages, memDir)).toBe(false);
  });

  test("extractWrittenPaths 收集 save_memory key", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "save_memory", input: { key: "coding_style", value: "v" } }] },
    ];
    expect(extractWrittenPaths(messages, memDir)).toEqual(["coding_style"]);
  });
});
