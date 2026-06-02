/**
 * 旧命令 → 新命令适配器测试（Task 1）
 */

import { describe, test, expect } from "bun:test";
import {
  adaptLegacyCommand,
  convertResult,
} from "../../src/command/adapter.ts";
import type {
  Command as LegacyCommand,
  CommandContext,
} from "../../src/command/types.ts";

// 最小可用的 CommandContext（仅适配器用到的字段）
const fakeCtx = {
  ctxMgr: {} as any,
  toolRegistry: {} as any,
  config: {} as any,
  sessionId: "test",
  provider: {} as any,
  sessionState: {} as any,
  cwd: "/tmp",
} as CommandContext;

describe("convertResult", () => {
  test("message → text", () => {
    expect(convertResult({ kind: "message", message: "hi" })).toEqual({
      type: "text",
      value: "hi",
    });
  });

  test("error → text（带错误前缀）", () => {
    expect(convertResult({ kind: "error", message: "oops" })).toEqual({
      type: "text",
      value: "错误: oops",
    });
  });

  test("clear / quit 保留语义", () => {
    expect(convertResult({ kind: "clear" })).toEqual({ type: "clear" });
    expect(convertResult({ kind: "quit", message: "bye" })).toEqual({
      type: "quit",
      message: "bye",
    });
  });

  test("submit_prompt 保留 prompt", () => {
    expect(
      convertResult({ kind: "submit_prompt", prompt: "do it" }),
    ).toEqual({ type: "submit_prompt", prompt: "do it" });
  });

  test("dialog 保留 dialog 字段（不再降级为 skip）", () => {
    expect(convertResult({ kind: "dialog", dialog: "model" })).toEqual({
      type: "dialog",
      dialog: "model",
    });
  });

  test("confirm 保留并递归转换 onConfirm", async () => {
    const r = convertResult({
      kind: "confirm",
      message: "确认?",
      onConfirm: async () => ({ kind: "message", message: "已确认" }),
    });
    expect(r.type).toBe("confirm");
    if (r.type === "confirm") {
      expect(r.message).toBe("确认?");
      const next = await r.onConfirm();
      expect(next).toEqual({ type: "text", value: "已确认" });
    }
  });
});

describe("adaptLegacyCommand", () => {
  class FakeCmd implements LegacyCommand {
    name() {
      return "fake";
    }
    aliases() {
      return ["f"];
    }
    description() {
      return "假命令";
    }
    async execute(args: string) {
      return { kind: "message" as const, message: `执行: ${args}` };
    }
  }

  test("适配后类型为 local，元数据保留", () => {
    const u = adaptLegacyCommand(new FakeCmd());
    expect(u.type).toBe("local");
    expect(u.name).toBe("fake");
    expect(u.aliases).toEqual(["f"]);
    expect(u.description).toBe("假命令");
    expect(u.source).toBe("builtin");
  });

  test("load() 调用旧命令并转换结果", async () => {
    const u = adaptLegacyCommand(new FakeCmd());
    if (u.type !== "local") throw new Error("应为 local");
    const mod = await u.load();
    const result = await mod.call("hello", fakeCtx);
    expect(result).toEqual({ type: "text", value: "执行: hello" });
  });

  test("子命令递归适配", () => {
    class ParentCmd implements LegacyCommand {
      name() {
        return "parent";
      }
      aliases() {
        return [];
      }
      description() {
        return "父命令";
      }
      subCommands() {
        return [new FakeCmd()];
      }
      async execute() {
        return { kind: "message" as const, message: "" };
      }
    }
    const u = adaptLegacyCommand(new ParentCmd());
    const subs = u.subCommands?.();
    expect(subs?.length).toBe(1);
    expect(subs?.[0].name).toBe("fake");
  });
});
