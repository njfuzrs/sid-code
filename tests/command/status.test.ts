/**
 * /status 命令测试（P1-1）
 *
 * 覆盖：完整字段展示（模型/effort/provider/fallback/会话ID/目录/消息数/token/skills/MCP）/
 * 缺字段优雅降级不崩溃 / 上下文百分比计算。
 */
import { describe, test, expect } from "bun:test";
import statusCmd from "@sid-code/cli/command/commands/status/index.ts";
import type { CommandContext, LocalCommand } from "@sid-code/cli/command/types.ts";

const loadStatus = () => (statusCmd as LocalCommand).load();

/** 构造一个"字段齐全"的 ctx。 */
function makeFullCtx() {
  return {
    config: { model: "claude-opus-4-8", provider: "anthropic", fallbackModel: "claude-sonnet-5" },
    sessionId: "sess-123",
    cwd: "/tmp/proj",
    getEffortState: () => ({
      runtime: "max",
      applied: "max",
      isAuto: false,
      capability: { supportsEffort: true },
    }),
    ctxMgr: {
      messageCount: () => 42,
      estimateTokens: () => 50_000,
      getMaxTokens: () => 200_000,
      getInvokedSkills: () => [{ name: "deep-research" }],
    },
    mcpManager: {
      getStatus: () => [
        { status: "connected", toolCount: 3 },
        { status: "disconnected", toolCount: 0 },
      ],
    },
  } as unknown as CommandContext;
}

describe("/status 命令", () => {
  test("完整 ctx：展示模型/effort/provider/fallback/会话/token/skills/MCP", async () => {
    const mod = await loadStatus();
    const r = await mod.call("", makeFullCtx());
    const value = (r as { value: string }).value;
    expect(value).toContain("会话状态:");
    expect(value).toContain("claude-opus-4-8");
    expect(value).toContain("max"); // effort
    expect(value).toContain("anthropic"); // provider
    expect(value).toContain("claude-sonnet-5"); // fallback
    expect(value).toContain("sess-123");
    expect(value).toContain("/tmp/proj");
    expect(value).toContain("42"); // 消息数
    expect(value).toContain("25%"); // 50k/200k
    expect(value).toContain("deep-research");
    expect(value).toContain("1/2 已连接"); // MCP
  });

  test("空 ctx：缺字段优雅降级，不崩溃", async () => {
    const mod = await loadStatus();
    const ctx = {
      ctxMgr: {
        messageCount: () => 0,
        estimateTokens: () => 0,
      },
    } as unknown as CommandContext;
    const r = await mod.call("", ctx);
    expect(r.type).toBe("text");
    const value = (r as { value: string }).value;
    expect(value).toContain("会话状态:");
    expect(value).toContain("未知"); // 模型缺失回退
  });

  test("ctxMgr 抛错也不影响其余状态展示", async () => {
    const mod = await loadStatus();
    const ctx = {
      config: { model: "m" },
      ctxMgr: {
        messageCount: () => { throw new Error("boom"); },
        estimateTokens: () => { throw new Error("boom"); },
      },
    } as unknown as CommandContext;
    const r = await mod.call("", ctx);
    expect(r.type).toBe("text");
    expect((r as { value: string }).value).toContain("模型: m");
  });
});
