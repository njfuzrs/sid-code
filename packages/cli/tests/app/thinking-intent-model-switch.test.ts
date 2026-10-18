/**
 * 20261018 思考开关复审 丁：R7 / R8 / R9 / T2。
 *
 * 为什么测到 App 这一层：ThinkingManager 类本身的现算回调已有单测（thinking-manager-live），
 * 但「App 构造时传的是回调还是快照」「切模型后是否提示」只有 App 才知道——改回构造期快照、
 * 删掉 applyPrimaryModelSwitch 里的提示调用，类级单测都不会红。
 *
 * 经 SID_CONFIG_DIR 重定向到 tmp，不触碰真实 ~/.sid-code。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { App } from "@sid-code/cli/app.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import thinkCmd, {
  LOCKED_ON_NOTE,
  NO_TOGGLE_NOTE,
} from "@sid-code/cli/command/commands/think/think.ts";
import { thinkingIntentOverriddenNote } from "@sid-code/cli/ui/utils/thinking-label.ts";

const saved = {
  HOME: process.env.HOME,
  SID_CONFIG_DIR: process.env.SID_CONFIG_DIR,
  SID_CODE_THINKING: process.env.SID_CODE_THINKING,
};
let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `sid-think-switch-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testDir, ".sid-code"), { recursive: true });
  process.env.HOME = testDir;
  process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  delete process.env.SID_CODE_THINKING;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

function makeApp(model: string, provider: string, thinkingEnabled?: boolean): any {
  const config = {
    ...defaultConfig(),
    model,
    provider,
    availableModels: [],
    permissionMode: "default",
    ...(thinkingEnabled === undefined ? {} : { thinkingEnabled }),
  } as unknown as Config;
  return new App({ config, provider: {} as any, mcpManager: {} as any }) as any;
}

describe("T2：ThinkingManager 的 App 接线随当前模型现算", () => {
  test("启动在无开关族，/model 切到有开关族后 think hard 生效", () => {
    const app = makeApp("kimi-k2", "openai");
    expect(app.thinkingMgr.parseThinkingHint("think hard 重构").config).toBeUndefined();
    app.applyPrimaryModelSwitch("claude-sonnet-5");
    expect(app.thinkingMgr.parseThinkingHint("think hard 重构").config?.enabled).toBe(true);
  });
});

describe("R7：切模型后意图 off 被覆盖时提示一次", () => {
  test("off 切到恒思考模型提示；同一模型再切入不重复；切到可关模型不提示", () => {
    const app = makeApp("claude-sonnet-5", "anthropic", false);
    expect(app.runtimeThinking).toBe("off");
    app.applyPrimaryModelSwitch("claude-sonnet-5-5");
    expect(app.pendingThinkingNotes).toHaveLength(1);
    expect(app.pendingThinkingNotes[0]).toContain("claude-sonnet-5-5");
    expect(app.pendingThinkingNotes[0]).toContain("恒思考");

    app.applyPrimaryModelSwitch("claude-sonnet-5");
    app.applyPrimaryModelSwitch("claude-sonnet-5-5");
    expect(app.pendingThinkingNotes).toHaveLength(1);
  });

  test("off 切到无开关族提示 NO_TOGGLE 文案", () => {
    const app = makeApp("claude-sonnet-5", "anthropic", false);
    app.config.provider = "openai";
    app.applyPrimaryModelSwitch("gpt-5.2");
    expect(app.pendingThinkingNotes).toHaveLength(1);
    expect(app.pendingThinkingNotes[0]).toContain("没有独立的思考开关");
  });

  test("意图 auto / on 不提示", () => {
    const app = makeApp("claude-sonnet-5", "anthropic");
    app.applyPrimaryModelSwitch("claude-sonnet-5-5");
    expect(app.pendingThinkingNotes).toHaveLength(0);
  });

  test("TUI 就绪后走 sink，不再排队", () => {
    const app = makeApp("claude-sonnet-5", "anthropic", false);
    const got: string[] = [];
    app.thinkingNoteSink = (t: string) => got.push(t);
    app.applyPrimaryModelSwitch("claude-sonnet-5-5");
    expect(got).toHaveLength(1);
    expect(app.pendingThinkingNotes).toHaveLength(0);
  });
});

describe("R8：SID_CODE_THINKING=off 启动在关不掉的模型上", () => {
  test("启动检查产出一条提示", () => {
    process.env.SID_CODE_THINKING = "off";
    const app = makeApp("glm-5.3", "openai");
    app.noteThinkingIntentIfOverridden();
    expect(app.pendingThinkingNotes).toHaveLength(1);
    expect(app.pendingThinkingNotes[0]).toContain("glm-5.3");
  });

  test("可关模型上 env=off 不提示", () => {
    process.env.SID_CODE_THINKING = "off";
    const app = makeApp("claude-sonnet-5", "anthropic");
    app.noteThinkingIntentIfOverridden();
    expect(app.pendingThinkingNotes).toHaveLength(0);
  });

  test("判定函数：只有 off × (locked-on|none) 才有提示", () => {
    expect(thinkingIntentOverriddenNote("locked-on", "off")).toBe(LOCKED_ON_NOTE);
    expect(thinkingIntentOverriddenNote("none", "off")).toBe(NO_TOGGLE_NOTE);
    expect(thinkingIntentOverriddenNote("toggle", "off")).toBeNull();
    expect(thinkingIntentOverriddenNote("locked-on", "auto")).toBeNull();
    expect(thinkingIntentOverriddenNote("none", "on")).toBeNull();
  });
});

describe("R9：无开关族 /think off 也保存意图", () => {
  function ctxFor(control: "none" | "locked-on" | "toggle") {
    const calls: unknown[] = [];
    const ctx: any = {
      getThinkingState: () => ({
        runtime: undefined,
        applied: false,
        capability: {
          thinkingControl: control,
          supportsThinkingToggle: control !== "none",
          thinkingDefaultOn: false,
        },
      }),
      setThinking: (s: unknown, p: unknown) => calls.push([s, p]),
    };
    return { ctx, calls };
  }

  test("none 族 /think off → setThinking 被调用，回执附 NO_TOGGLE_NOTE", async () => {
    const { ctx, calls } = ctxFor("none");
    const r: any = await thinkCmd.call("off", ctx);
    expect(calls).toEqual([["off", false]]);
    expect(r.value).toContain(NO_TOGGLE_NOTE);
  });

  test("none 族 /think（无参数）不开空面板，直接说明", async () => {
    const { ctx, calls } = ctxFor("none");
    const r: any = await thinkCmd.call("", ctx);
    expect(calls).toHaveLength(0);
    expect(r).toEqual({ type: "text", value: NO_TOGGLE_NOTE });
  });

  test("locked-on /think off 仍附 LOCKED_ON_NOTE；toggle 不附提示", async () => {
    const a = ctxFor("locked-on");
    const ra: any = await thinkCmd.call("off", a.ctx);
    expect(ra.value).toContain(LOCKED_ON_NOTE);
    const b = ctxFor("toggle");
    const rb: any = await thinkCmd.call("off", b.ctx);
    expect(rb.value).not.toContain(LOCKED_ON_NOTE);
    expect(rb.value).not.toContain(NO_TOGGLE_NOTE);
  });
});
