/**
 * P2-3：sidechain transcript 重建（resume 真恢复）单测
 *
 * 覆盖：
 * - 完整往返：写 transcript → reconstruct 拿回消息历史
 * - 清洗孤儿 thinking-only assistant 消息
 * - 剔除末尾未解析（悬空）的 tool_use
 * - transcript 缺失时返回 null（降级路径）
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { SidechainWriter, reconstructSidechainMessages } from "@sid-code/core/session/sidechain.ts";
import type { ContentBlock } from "@sid-code/core/llm/types.ts";

describe("P2-3 sidechain transcript 重建", () => {
  let testDir: string;
  let origHome: string | undefined;
  let origConfigDir: string | undefined;
  const SID = "sess-resume-test";

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-resume-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = testDir;
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("完整往返：写 transcript → 重建消息历史", () => {
    const w = new SidechainWriter(SID, "agent-1");
    w.start("explore", "查代码", "test-model");
    w.appendMessage("user", [{ type: "text", text: "找 foo 函数" } as ContentBlock], 1);
    w.appendMessage("assistant", [{ type: "text", text: "找到了 foo 在 a.ts" } as ContentBlock], 1);
    // 未 end → 视为中断，可恢复

    const r = reconstructSidechainMessages(SID, "agent-1");
    expect(r).not.toBeNull();
    expect(r!.agentType).toBe("explore");
    expect(r!.ended).toBe(false);
    expect(r!.messages.length).toBe(2);
    expect(r!.messages[0]!.role).toBe("user");
    expect(r!.messages[1]!.role).toBe("assistant");
  });

  it("清洗孤儿 thinking-only assistant 消息", () => {
    const w = new SidechainWriter(SID, "agent-2");
    w.start("task", "干活", "test-model");
    w.appendMessage("user", [{ type: "text", text: "开始" } as ContentBlock], 1);
    // 只含 thinking 的 assistant 消息应被过滤
    w.appendMessage("assistant", [{ type: "thinking", thinking: "让我想想" } as unknown as ContentBlock], 1);
    w.appendMessage("assistant", [{ type: "text", text: "完成" } as ContentBlock], 2);

    const r = reconstructSidechainMessages(SID, "agent-2");
    expect(r).not.toBeNull();
    // thinking-only 那条被剔除，剩 user + 实质 assistant
    expect(r!.messages.length).toBe(2);
    const hasThinkingOnly = r!.messages.some(
      (m) => m.role === "assistant" && m.content.every((b: any) => b.type === "thinking"),
    );
    expect(hasThinkingOnly).toBe(false);
  });

  it("剔除末尾悬空 tool_use（无对应 tool_result）", () => {
    const w = new SidechainWriter(SID, "agent-3");
    w.start("task", "干活", "test-model");
    w.appendMessage("user", [{ type: "text", text: "读文件" } as ContentBlock], 1);
    // assistant 发起两个 tool_use，只有一个有对应 tool_result
    w.appendMessage("assistant", [
      { type: "text", text: "我来读" } as ContentBlock,
      { type: "tool_use", id: "resolved-1", name: "read", input: {} } as unknown as ContentBlock,
      { type: "tool_use", id: "orphan-1", name: "read", input: {} } as unknown as ContentBlock,
    ], 1);
    w.appendMessage("tool", [
      { type: "tool_result", tool_use_id: "resolved-1", content: "文件内容" } as unknown as ContentBlock,
    ], 1);

    const r = reconstructSidechainMessages(SID, "agent-3");
    expect(r).not.toBeNull();
    // 悬空 orphan-1 被剔除，resolved-1 保留
    const allBlocks = r!.messages.flatMap((m) => m.content as any[]);
    const toolUseIds = allBlocks.filter((b) => b.type === "tool_use").map((b) => b.id);
    expect(toolUseIds).toContain("resolved-1");
    expect(toolUseIds).not.toContain("orphan-1");
  });

  it("transcript 缺失时返回 null（降级路径）", () => {
    const r = reconstructSidechainMessages(SID, "no-such-agent");
    expect(r).toBeNull();
  });

  it("首条非 user 时前置占位 user，保证 provider 契约", () => {
    const w = new SidechainWriter(SID, "agent-4");
    w.start("task", "干活", "test-model");
    // 直接以 assistant 开头（异常但需容错）
    w.appendMessage("assistant", [{ type: "text", text: "我先说" } as ContentBlock], 1);

    const r = reconstructSidechainMessages(SID, "agent-4");
    expect(r).not.toBeNull();
    expect(r!.messages[0]!.role).toBe("user");
  });
});
