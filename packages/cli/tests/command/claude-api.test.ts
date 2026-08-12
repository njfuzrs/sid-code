/**
 * /claude-api 命令测试（§4.6）
 *
 * 覆盖：无参列索引 / messages|api|all 注入 submit_prompt / 非法参数拒绝 /
 * 文档确实被内联（text import 非空）。
 */
import { describe, test, expect } from "bun:test";
import apiCmd from "@sid-code/cli/command/commands/claude-api/index.ts";
import type { CommandContext, LocalCommand } from "@sid-code/cli/command/types.ts";

const loadApi = () => (apiCmd as LocalCommand).load();
const ctx = {} as unknown as CommandContext;

describe("/claude-api 命令", () => {
  test("无参：列出可加载子文档", async () => {
    const mod = await loadApi();
    const r = await mod.call("", ctx);
    expect(r.type).toBe("text");
    const value = (r as { value: string }).value;
    expect(value).toContain("/claude-api api");
    expect(value).toContain("/claude-api messages");
  });

  test("messages：注入非空文档为 submit_prompt", async () => {
    const mod = await loadApi();
    const r = await mod.call("messages", ctx);
    expect(r.type).toBe("submit_prompt");
    const prompt = (r as { prompt: string }).prompt;
    // 文档已内联，prompt 应远长于提示语本身
    expect(prompt.length).toBeGreaterThan(500);
    expect(prompt).toContain("Messages API");
  });

  test("all：拼接全部参考", async () => {
    const mod = await loadApi();
    const r = await mod.call("all", ctx);
    expect(r.type).toBe("submit_prompt");
    expect((r as { prompt: string }).prompt.length).toBeGreaterThan(1000);
  });

  test("非法参数被拒绝", async () => {
    const mod = await loadApi();
    const r = await mod.call("nonsense", ctx);
    expect(r.type).toBe("text");
    expect((r as { value: string }).value).toContain("未知参数");
  });
});
