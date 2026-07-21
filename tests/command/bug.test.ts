/**
 * /bug（别名 /feedback）命令测试（§4.5）
 *
 * 覆盖：模板含环境信息段 / 参数填入问题描述 / 含提交地址。
 * setClipboard 走真实 OSC 序列（返回字符串，不实际写系统剪贴板），测试只验报告内容。
 */
import { describe, test, expect } from "bun:test";
import bugCmd from "../../src/command/commands/bug/index.ts";
import type { CommandContext, LocalCommand } from "../../src/command/types.ts";

const loadBug = () => (bugCmd as LocalCommand).load();

function makeCtx() {
  return {
    config: { model: "claude-opus-4-8" },
    sessionId: "sess-xyz",
    cwd: "/tmp/proj",
  } as unknown as CommandContext;
}

describe("/bug 命令", () => {
  test("空参 → 含环境信息 + 占位描述 + 提交地址", async () => {
    const mod = await loadBug();
    const r = await mod.call("", makeCtx());
    const value = (r as { value: string }).value;
    expect(value).toContain("环境信息");
    expect(value).toContain("claude-opus-4-8"); // 模型
    expect(value).toContain("sess-xyz"); // 会话 ID
    expect(value).toContain(process.platform); // 平台
    expect(value).toContain("问题描述");
    expect(value).toContain("issues"); // 提交地址（issue URL）
  });

  test("带参 → 问题描述填入参数", async () => {
    const mod = await loadBug();
    const r = await mod.call("补全菜单闪退", makeCtx());
    expect((r as { value: string }).value).toContain("补全菜单闪退");
  });
});
