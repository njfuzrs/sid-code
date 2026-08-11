/**
 * /tui + /fast 命令测试（P2-5 / §4.6）
 *
 * 两者都是 config 布尔开关。不带 -p 时只改 ctx.config，不落盘，故可纯内存验证。
 * 覆盖：无参展示 / on|off 切换 / 非法参数 / 运行时 config 同步。
 */
import { describe, test, expect } from "bun:test";
import tuiCmd from "@sid-code/cli/command/commands/tui/index.ts";
import fastCmd from "@sid-code/cli/command/commands/fast/index.ts";
import type { CommandContext, LocalCommand } from "@sid-code/cli/command/types.ts";

const loadTui = () => (tuiCmd as LocalCommand).load();
const loadFast = () => (fastCmd as LocalCommand).load();

function makeCtx(initial: Record<string, unknown> = {}) {
  return { config: { ...initial } } as unknown as CommandContext;
}

describe("/tui 命令", () => {
  test("无参展示当前模式，不改 config", async () => {
    const mod = await loadTui();
    const ctx = makeCtx({ alternateBuffer: false });
    const r = await mod.call("", ctx);
    expect((r as { value: string }).value).toContain("主屏 Static");
    expect((ctx.config as { alternateBuffer?: boolean }).alternateBuffer).toBe(false);
  });

  test("on 切换全屏并同步运行时 config", async () => {
    const mod = await loadTui();
    const ctx = makeCtx({ alternateBuffer: false });
    const r = await mod.call("on", ctx);
    expect((r as { value: string }).value).toContain("全屏");
    expect((ctx.config as { alternateBuffer?: boolean }).alternateBuffer).toBe(true);
  });

  test("非法参数被拒绝", async () => {
    const mod = await loadTui();
    const r = await mod.call("maybe", makeCtx());
    expect((r as { value: string }).value).toContain("无效参数");
  });
});

describe("/fast 命令", () => {
  test("无参展示开关态 + 网关能力尾注", async () => {
    const mod = await loadFast();
    const r = await mod.call("", makeCtx({ fastMode: false }));
    const value = (r as { value: string }).value;
    expect(value).toContain("Fast Mode: off");
    expect(value).toContain("暂无实际加速"); // 诚实告知，不造假
  });

  test("on 切换预留开关并同步 config", async () => {
    const mod = await loadFast();
    const ctx = makeCtx({ fastMode: false });
    const r = await mod.call("on", ctx);
    expect((r as { value: string }).value).toContain("已开启");
    expect((ctx.config as { fastMode?: boolean }).fastMode).toBe(true);
  });

  test("非法参数被拒绝", async () => {
    const mod = await loadFast();
    const r = await mod.call("turbo", makeCtx());
    expect((r as { value: string }).value).toContain("无效参数");
  });
});
