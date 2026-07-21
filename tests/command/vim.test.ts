/**
 * /vim 命令测试（P1-4）
 *
 * 覆盖：无参 toggle / 显式 on|off / -p 持久化标志 / 非法参数 / 无 setVimMode 回退。
 */
import { describe, test, expect } from "bun:test";
import vimCmd from "../../src/command/commands/vim/index.ts";
import type { CommandContext, LocalCommand } from "../../src/command/types.ts";

/** 收窄到 local 命令的 load（vim 恒为 type:"local"）。 */
const loadVim = () => (vimCmd as LocalCommand).load();

/** 构造最小 ctx，记录 setVimMode 调用。 */
function makeCtx(initial = false) {
  let cur = initial;
  const calls: Array<{ enabled: boolean; persist?: boolean }> = [];
  const ctx = {
    setVimMode: (enabled: boolean, persist?: boolean) => {
      cur = enabled;
      calls.push({ enabled, persist });
    },
    getVimMode: () => cur,
  } as unknown as CommandContext;
  return { ctx, calls, get cur() { return cur; } };
}

describe("/vim 命令", () => {
  test("无参 toggle：false→true→false", async () => {
    const mod = await loadVim();
    const h = makeCtx(false);
    const r1 = await mod.call("", h.ctx);
    expect(h.cur).toBe(true);
    expect(r1).toEqual({ type: "text", value: expect.stringContaining("已开启") });
    await mod.call("", h.ctx);
    expect(h.cur).toBe(false);
  });

  test("显式 on / off", async () => {
    const mod = await loadVim();
    const h = makeCtx(false);
    await mod.call("on", h.ctx);
    expect(h.cur).toBe(true);
    await mod.call("off", h.ctx);
    expect(h.cur).toBe(false);
  });

  test("-p 透传 persist=true", async () => {
    const mod = await loadVim();
    const h = makeCtx(false);
    await mod.call("on -p", h.ctx);
    expect(h.calls.at(-1)).toEqual({ enabled: true, persist: true });
    const r = await mod.call("off save", h.ctx);
    expect(h.calls.at(-1)).toEqual({ enabled: false, persist: true });
    expect(r).toEqual({ type: "text", value: expect.stringContaining("settings.json") });
  });

  test("非法参数报错，不改状态", async () => {
    const mod = await loadVim();
    const h = makeCtx(false);
    const r = await mod.call("xyz", h.ctx);
    expect(r).toEqual({ type: "text", value: expect.stringContaining("无效参数") });
    expect(h.calls.length).toBe(0);
  });

  test("无 setVimMode 回退提示（无 TUI）", async () => {
    const mod = await loadVim();
    const r = await mod.call("", {} as CommandContext);
    expect(r).toEqual({ type: "text", value: expect.stringContaining("不支持") });
  });
});
