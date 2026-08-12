/**
 * /statusline 命令测试（P1-5）
 *
 * 覆盖：设置脚本 / 禁用 / toggle 无参展示 / 持久化标志解析 / 去引号 / 无 setter 降级。
 * 只依赖 CommandContext 的 setStatusLine/getStatusLine 两个回调，用轻量 mock。
 */

import { describe, test, expect } from "bun:test";
import statuslineCmd from "@sid-code/cli/command/commands/statusline/index.ts";
import type { CommandContext, LocalCommandModule } from "@sid-code/cli/command/types.ts";
import type { StatusLineConfig } from "@sid-code/cli/ui/statusline/run-statusline.ts";

/** 加载命令实现模块（延迟加载入口 → 实际 handler）。 */
async function loadHandler(): Promise<LocalCommandModule> {
  expect(statuslineCmd.type).toBe("local");
  const mod = await (statuslineCmd as any).load();
  return mod as LocalCommandModule;
}

/** 构造捕获 setStatusLine 调用的 mock ctx。 */
function makeCtx(initial?: StatusLineConfig | undefined) {
  let current: StatusLineConfig | undefined = initial;
  const calls: Array<{ config: StatusLineConfig | undefined; persist?: boolean }> = [];
  const ctx = {
    setStatusLine: (config: StatusLineConfig | undefined, persist?: boolean) => {
      calls.push({ config, persist });
      current = config;
    },
    getStatusLine: () => current,
  } as unknown as CommandContext;
  return {
    ctx,
    calls,
    get current() {
      return current;
    },
  };
}

describe("/statusline 命令", () => {
  test("设置脚本命令（当前会话，不持久化）", async () => {
    const mod = await loadHandler();
    const { ctx, calls } = makeCtx();
    const res = await mod.call("my-status.sh", ctx);
    expect(calls.length).toBe(1);
    expect(calls[0].config).toEqual({ type: "command", command: "my-status.sh" });
    expect(calls[0].persist).toBe(false);
    expect(res.type).toBe("text");
    expect((res as any).value).toContain("my-status.sh");
  });

  test("-p 标志触发持久化", async () => {
    const mod = await loadHandler();
    const { ctx, calls } = makeCtx();
    await mod.call("my-status.sh -p", ctx);
    expect(calls[0].config).toEqual({ type: "command", command: "my-status.sh" });
    expect(calls[0].persist).toBe(true);
  });

  test("--persist / save 别名同样触发持久化", async () => {
    const mod = await loadHandler();
    for (const flag of ["--persist", "save"]) {
      const { ctx, calls } = makeCtx();
      await mod.call(`x.sh ${flag}`, ctx);
      expect(calls[0].persist).toBe(true);
    }
  });

  test("去掉成对外层引号（单/双）", async () => {
    const mod = await loadHandler();
    for (const raw of [`'jq -r .model'`, `"jq -r .model"`]) {
      const { ctx, calls } = makeCtx();
      await mod.call(raw, ctx);
      expect(calls[0].config).toEqual({ type: "command", command: "jq -r .model" });
    }
  });

  test("off 禁用，config 传 undefined", async () => {
    const mod = await loadHandler();
    const { ctx, calls } = makeCtx({ type: "command", command: "old.sh" });
    const res = await mod.call("off", ctx);
    expect(calls[0].config).toBeUndefined();
    expect(calls[0].persist).toBe(false);
    expect((res as any).value).toContain("禁用");
  });

  test("off -p 禁用并持久化移除", async () => {
    const mod = await loadHandler();
    const { ctx, calls } = makeCtx({ type: "command", command: "old.sh" });
    await mod.call("off -p", ctx);
    expect(calls[0].config).toBeUndefined();
    expect(calls[0].persist).toBe(true);
  });

  test("disable / none 亦为禁用别名", async () => {
    const mod = await loadHandler();
    for (const word of ["disable", "none"]) {
      const { ctx, calls } = makeCtx({ type: "command", command: "x" });
      await mod.call(word, ctx);
      expect(calls[0].config).toBeUndefined();
    }
  });

  test("无参：展示当前配置，不改状态", async () => {
    const mod = await loadHandler();
    const { ctx, calls } = makeCtx({ type: "command", command: "cur.sh", padding: 2 });
    const res = await mod.call("", ctx);
    expect(calls.length).toBe(0); // 只读展示，不写
    const val = (res as any).value as string;
    expect(val).toContain("cur.sh");
    expect(val).toContain("用法");
  });

  test("无参且未配置：提示走内置状态栏", async () => {
    const mod = await loadHandler();
    const { ctx } = makeCtx(undefined);
    const res = await mod.call("", ctx);
    expect((res as any).value).toContain("内置");
  });

  test("无 setStatusLine 能力时优雅降级", async () => {
    const mod = await loadHandler();
    const res = await mod.call("x.sh", {} as CommandContext);
    expect((res as any).value).toContain("不支持");
  });
});
