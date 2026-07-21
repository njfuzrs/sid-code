/**
 * /batch 命令测试（§4.4）
 *
 * 覆盖：无参打印用法 / 带任务转成 submit_prompt 编排指令（含 Workflow + worktree 隔离要点）。
 */
import { describe, test, expect } from "bun:test";
import batchCmd from "../../src/command/commands/batch/index.ts";
import type { CommandContext, LocalCommand } from "../../src/command/types.ts";

const loadBatch = () => (batchCmd as LocalCommand).load();
const ctx = {} as unknown as CommandContext;

describe("/batch 命令", () => {
  test("无参 → 打印用法（text）", async () => {
    const mod = await loadBatch();
    const r = await mod.call("", ctx);
    expect(r.type).toBe("text");
    expect((r as { value: string }).value).toContain("用法");
  });

  test("带任务 → submit_prompt 含编排要点", async () => {
    const mod = await loadBatch();
    const r = await mod.call("给每个命令补单测", ctx);
    expect(r.type).toBe("submit_prompt");
    const prompt = (r as { prompt: string }).prompt;
    expect(prompt).toContain("给每个命令补单测"); // 原任务
    expect(prompt).toContain("Workflow"); // 委托既有 fan-out 基建
    expect(prompt).toContain("worktree"); // 冲突隔离
    expect(prompt).toContain("独立"); // 并行独立单元
  });
});
