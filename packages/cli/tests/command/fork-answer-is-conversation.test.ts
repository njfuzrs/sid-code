/**
 * fork 型 prompt 命令（未写 context 的磁盘 skill、带 allowed-tools 的自定义命令）的产出
 * 是**模型的回答**，必须进对话，不能被当成命令报告塞进输出面板 / 状态栏。
 *
 * #223 之后 app.ts 把所有 message 结果都交给 routeCommandResult，fork 产出 ≥3 行即进面板：
 * /interview /project-qa 这类与模型交互的命令，回答 Esc 一关就没了，下一轮模型也看不到。
 * 修法是在三个 fork 出口给结果打 `conversational`，app.ts 据此按一轮对话落。
 *
 * 锁四件事：
 * 1. 三个 fork 出口（executor / SkillCommand / CustomCommand）都打标记；
 * 2. 标记压过 outputPanel 声明，适配器两向透传不丢；
 * 3. 普通 local 命令的多行报告仍然不带标记（面板语义不回退）；
 * 4. 落成的消息在历史区渲染为「触发命令 + 模型回答」，不泄漏展开提示词。
 */

import { describe, test, expect } from "bun:test";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { CommandExecutor } from "@sid-code/cli/command/executor.ts";
import { adaptLegacyCommand, convertResult } from "@sid-code/cli/command/adapter.ts";
import { SkillCommand } from "@sid-code/cli/command/skill-command.ts";
import { CustomCommand } from "@sid-code/cli/command/custom.ts";
import { buildCommandAnswerMessages } from "@sid-code/cli/ui/command-result-route.ts";
import { messagesToHistoryItems } from "@sid-code/cli/ui/history-adapter.ts";
import type { UnifiedCommand, CommandContext } from "@sid-code/cli/command/types.ts";

const ANSWER = ["第一题：说说重试为什么不会重复计费？", "", "（请作答）", "第四行"].join("\n");

/** 把 SubAgent.fromRegistry 换成固定回答的桩，跑完恢复 */
async function withFakeSubAgent<T>(fn: () => Promise<T>): Promise<T> {
  const orig = SubAgent.fromRegistry;
  (SubAgent as any).fromRegistry = () => ({
    setPermissionChecker: () => {},
    executeCustom: async () => ({ success: true, output: ANSWER }),
  });
  try {
    return await fn();
  } finally {
    (SubAgent as any).fromRegistry = orig;
  }
}

function forkPromptCmd(over: Partial<UnifiedCommand> = {}): UnifiedCommand {
  return {
    name: "interview",
    description: "测试",
    type: "prompt",
    context: "fork",
    source: "skill",
    getPromptForCommand: async () => "展开后的完整提示词",
    ...over,
  } as UnifiedCommand;
}

describe("fork 出口打 conversational 标记", () => {
  test("CommandExecutor：fork prompt 命令的回答带标记，即使命令声明了 outputPanel", async () => {
    const ctx = { providerRegistry: {} } as unknown as CommandContext;
    const r = await withFakeSubAgent(() =>
      new CommandExecutor(ctx).executeSlashCommand("/interview Q12", [
        forkPromptCmd({ outputPanel: true }),
      ]),
    );
    expect(r).toEqual({ type: "message", value: ANSWER, conversational: true });
  });

  test("SkillCommand（旧体系）fork 回答带标记", async () => {
    const skill = {
      name: "interview",
      description: "口试",
      prompt: "# interview",
      source: "project",
    } as any;
    const ctx = { providerRegistry: {}, registry: {} } as any;
    const r = await withFakeSubAgent(() => new SkillCommand(skill).execute("", ctx));
    expect(r).toMatchObject({ kind: "message", message: ANSWER, conversational: true });
  });

  test("CustomCommand：带 allowed-tools 走 fork，回答带标记", async () => {
    const cmd = new CustomCommand("project-qa", "盘点 $ARGUMENTS", "", {
      allowedTools: ["read"],
    } as any);
    const ctx = { providerRegistry: {}, registry: {} } as any;
    const r = await withFakeSubAgent(() => cmd.execute("讲稿", ctx));
    expect(r).toEqual({ kind: "message", message: ANSWER, conversational: true });
  });
});

describe("标记在适配层不丢、不污染普通命令", () => {
  test("legacy → LocalCommandResult：conversational 透传，且不附 panel", () => {
    expect(convertResult({ kind: "message", message: ANSWER, conversational: true })).toEqual({
      type: "text",
      value: ANSWER,
      conversational: true,
    });
  });

  test("自定义命令经 adaptLegacyCommand + 执行器全链路，outputPanel 声明压不过标记", async () => {
    const legacy = {
      name: () => "project-qa",
      aliases: () => [],
      description: () => "",
      execute: async () => ({ kind: "message" as const, message: ANSWER, conversational: true }),
    };
    const cmd = { ...adaptLegacyCommand(legacy as any, "project"), outputPanel: true };
    const r = await new CommandExecutor({} as CommandContext).executeSlashCommand("/project-qa", [
      cmd as UnifiedCommand,
    ]);
    expect(r).toEqual({ type: "message", value: ANSWER, conversational: true });
  });

  test("普通 local 命令的多行报告不带标记（面板语义不回退）", async () => {
    const doc = {
      name: "doc",
      description: "",
      type: "local",
      outputPanel: true,
      load: async () => ({ call: async () => ({ type: "text", value: ANSWER }) }),
    } as unknown as UnifiedCommand;
    const r = await new CommandExecutor({} as CommandContext).executeSlashCommand("/doc", [doc]);
    expect(r).toEqual({ type: "message", value: ANSWER, panel: {} });
  });
});

describe("落成的一轮对话", () => {
  test("历史区显示触发命令 + 模型回答，没有展开提示词", () => {
    const msgs = buildCommandAnswerMessages("/interview Q12", ANSWER);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    const items = messagesToHistoryItems(msgs);
    expect(items[0]).toMatchObject({ type: "command", input: "/interview Q12" });
    const rest = JSON.stringify(items.slice(1));
    expect(rest).toContain("第一题");
    expect(JSON.stringify(items)).not.toContain("展开后的完整提示词");
  });

  test("空回答也落一条 assistant 消息（空 content 会被 ctxMgr 丢掉，角色交替就断了）", () => {
    const [, a] = buildCommandAnswerMessages("/x", "  \n");
    expect(a.content[0]).toEqual({ type: "text", text: "（无输出）" });
  });
});

/**
 * 回车即回显：fork 开跑**之前**必须调 beginForkedRun（TUI 据此立刻上屏触发命令 + 进加载态），
 * 子代理拿到它给的中断信号，返回后无论成败都调 end。
 * 此前 `/interview` 要等子代理整段跑完才出现，期间整屏空白，像没执行。
 */
describe("beginForkedRun：开跑前回显，结束必收尾", () => {
  type Log = string[];
  function bracket(log: Log, abortBeforeReturn = false) {
    const ctrl = new AbortController();
    return {
      ctrl,
      beginForkedRun: () => {
        log.push("begin");
        return {
          signal: ctrl.signal,
          end: () => log.push("end"),
        };
      },
      abortBeforeReturn,
    };
  }
  async function withSubAgent<T>(
    log: Log,
    b: ReturnType<typeof bracket>,
    behavior: "ok" | "throw",
    fn: () => Promise<T>,
  ): Promise<T> {
    const orig = SubAgent.fromRegistry;
    (SubAgent as any).fromRegistry = () => ({
      setPermissionChecker: () => {},
      executeCustom: async (_task: unknown, signal?: AbortSignal) => {
        log.push(signal === b.ctrl.signal ? "run:signal" : "run:nosignal");
        if (b.abortBeforeReturn) b.ctrl.abort("user-cancel");
        if (behavior === "throw") throw new Error("boom");
        return { success: true, output: ANSWER };
      },
    });
    try {
      return await fn();
    } finally {
      (SubAgent as any).fromRegistry = orig;
    }
  }

  test("CommandExecutor：begin → 子代理拿到信号 → end", async () => {
    const log: Log = [];
    const b = bracket(log);
    const ctx = { providerRegistry: {}, beginForkedRun: b.beginForkedRun } as any;
    const r = await withSubAgent(log, b, "ok", () =>
      new CommandExecutor(ctx).executeSlashCommand("/interview", [forkPromptCmd()]),
    );
    expect(log).toEqual(["begin", "run:signal", "end"]);
    expect(r).toMatchObject({ conversational: true });
  });

  test("子代理抛错也调 end（否则 TUI 卡在加载态）", async () => {
    const log: Log = [];
    const b = bracket(log);
    const ctx = { providerRegistry: {}, beginForkedRun: b.beginForkedRun } as any;
    const r = await withSubAgent(log, b, "throw", () =>
      new CommandExecutor(ctx).executeSlashCommand("/interview", [forkPromptCmd()]),
    );
    expect(log).toEqual(["begin", "run:signal", "end"]);
    expect(r.type).toBe("error");
  });

  test("Esc 中断：返回取消错误，不把半截回答当对话落", async () => {
    const log: Log = [];
    const b = bracket(log, true);
    const ctx = { providerRegistry: {}, beginForkedRun: b.beginForkedRun } as any;
    const r = await withSubAgent(log, b, "ok", () =>
      new CommandExecutor(ctx).executeSlashCommand("/interview", [forkPromptCmd()]),
    );
    expect(r).toEqual({ type: "error", message: "已取消 /interview" });
    expect(log.at(-1)).toBe("end");
  });

  test("SkillCommand 与 CustomCommand 同样 begin → 信号 → end", async () => {
    for (const make of [
      () =>
        new SkillCommand({
          name: "interview",
          description: "",
          prompt: "# x",
          source: "project",
        } as any),
      () => new CustomCommand("project-qa", "盘点", "", { allowedTools: ["read"] } as any),
    ]) {
      const log: Log = [];
      const b = bracket(log);
      const ctx = { providerRegistry: {}, registry: {}, beginForkedRun: b.beginForkedRun } as any;
      const r = await withSubAgent(log, b, "ok", () => make().execute("", ctx));
      expect(log).toEqual(["begin", "run:signal", "end"]);
      expect(r).toMatchObject({ conversational: true });
    }
  });

  test("toCommandContext / toAppContext 双向透传 beginForkedRun", async () => {
    const { toCommandContext, toAppContext } = await import("@sid-code/cli/command/adapter.ts");
    const fn = () => ({ signal: new AbortController().signal, end: () => {} });
    expect(toCommandContext({ beginForkedRun: fn } as any).beginForkedRun).toBe(fn);
    expect(toAppContext({ beginForkedRun: fn } as any).beginForkedRun).toBe(fn);
  });
});
