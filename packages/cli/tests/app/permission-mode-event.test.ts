/**
 * B11：权限模式切换进轨迹（`PermissionModeChanged`）。
 *
 * ## 两个断言，各守一个失效模式
 *
 * 1. **静态门禁**：`app.ts` 里 `config.permissionMode =` 只能出现在 `setPermissionMode` 内。
 *    这条守的是「以后有人新增第 7 个赋值点、忘了记事件」——B11 的成因就是 6 处各写各的，
 *    其中 5 处不留痕。只测事件内容的话，新增赋值点照样全绿。
 * 2. **落盘断言**：真实 App 调 `setPermissionMode` → 真实 collector → 读 `events.jsonl`。
 *    只断言到内部队列或 setter 调用的话，映射漏了（B11 的 `confirm_via` 就是这样丢的）
 *    也是绿的。
 *
 * 落盘目标经 `SID_CONFIG_DIR` / `SID_CODE_SESSION_INDEX` 重定向到 tmpdir。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { App } from "@sid-code/cli/app.ts";
import { UnifiedCommandRegistry } from "@sid-code/cli/command/unified-registry.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import type { PermissionModeChangeSource } from "@sid-code/core/permission/mode.ts";

let dir: string;
const saved = {
  config: process.env.SID_CONFIG_DIR,
  index: process.env.SID_CODE_SESSION_INDEX,
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "sid-mode-event-")));
  process.env.SID_CONFIG_DIR = join(dir, "cfg");
  process.env.SID_CODE_SESSION_INDEX = join(dir, "session-index.jsonl");
});

afterEach(() => {
  for (const [k, v] of [
    ["SID_CONFIG_DIR", saved.config],
    ["SID_CODE_SESSION_INDEX", saved.index],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

function makeApp(mode: string): App {
  const config = {
    ...defaultConfig(),
    model: "mock-model",
    provider: "mock",
    availableModels: [],
    permissionMode: mode,
  } as unknown as Config;
  return new App({
    unifiedRegistry: new UnifiedCommandRegistry(),
    config,
    provider: {} as never,
    mcpManager: {} as never,
  });
}

/** 取私有字段 / 方法：这个测试要验的正是内部唯一出口的行为 */
type AppInternals = {
  setPermissionMode: (next: string, source: PermissionModeChangeSource) => void;
  recordProjectRulesPermissionEvent: (data: Record<string, unknown>) => void;
  traceCollector: TraceCollector | null;
  pendingTraceEvents: Array<{ event: string; data: Record<string, unknown> }>;
  config: Config;
};

/**
 * 起一个 initialized 的 collector 并挂到 App 上，返回读 events.jsonl 的函数。
 * 必须跑一轮模型：空会话会被 SessionEnd 的 cleanupIfBlankSession 删掉。
 */
async function attachCollector(
  app: App,
  sessionId: string,
): Promise<() => Promise<Array<Record<string, unknown>>>> {
  const { HookSystem } = await import("@sid-code/core/hook/system.ts");
  const hooks = new HookSystem();
  hooks.setSessionId(sessionId);
  hooks.setCwd(dir);
  const trajDir = join(dir, "trajectories");
  const collector = new TraceCollector({ outputDir: trajDir });
  collector.registerHooks(hooks);
  await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
  await hooks.fireBeforeModelEvent({
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
    raw_messages: [{ role: "user", content: "hi" }],
  });
  await hooks.fireAfterModelEvent(
    { model: "claude-test", messages: [], raw_messages: [{ role: "user", content: "hi" }] },
    {
      content_blocks: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    } as never,
  );
  (app as unknown as AppInternals).traceCollector = collector;

  return async () => {
    await hooks.fireSessionEndEvent("exit");
    return readFileSync(join(trajDir, "sessions", sessionId, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  };
}

describe("B11：权限模式切换的静态门禁", () => {
  test("app.ts 里 config.permissionMode 赋值只允许出现在 setPermissionMode 内", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/app.ts"), "utf-8");
    // 只数「写」：`(?!=)` 排除 `===` / `!==`，也没有前缀匹配到 `const mode = this.config.permissionMode`
    const assignments = [...src.matchAll(/this\.config\.permissionMode\s*=(?!=)/g)];
    expect(assignments.map((m) => m.index)).toHaveLength(1);

    const fnStart = src.indexOf("private setPermissionMode(");
    expect(fnStart).toBeGreaterThan(-1);
    // 下一个同类缩进的成员方法起点 = 本方法结束（app.ts 的方法都在类体 2 空格缩进）
    const fnEnd = src.indexOf("\n  /**", fnStart + 1);
    expect(fnEnd).toBeGreaterThan(fnStart);

    const at = assignments[0]!.index!;
    expect(at).toBeGreaterThan(fnStart);
    // 必须落在方法体内，且不在方法外的任何位置
    expect(at).toBeLessThan(fnEnd);
  });
});

describe("B11：PermissionModeChanged 落盘", () => {
  test("切换 → events.jsonl 带 from / to / source", async () => {
    const app = makeApp("default");
    const read = await attachCollector(app, "b11-switch");
    (app as unknown as AppInternals).setPermissionMode("plan", "keyboard");
    const events = await read();

    const changed = events.filter((e) => e.event === "PermissionModeChanged");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.data).toMatchObject({
      from: "default",
      to: "plan",
      source: "keyboard",
    });
    // 赋值本身也发生了（事件不是只写不改的旁路）
    expect((app as unknown as AppInternals).config.permissionMode).toBe("plan");
  });

  test("同值调用不写事件（没有发生切换），但仍保证赋值", async () => {
    const app = makeApp("acceptEdits");
    const read = await attachCollector(app, "b11-noop");
    (app as unknown as AppInternals).setPermissionMode("acceptEdits", "keyboard");
    const events = await read();

    expect(events.filter((e) => e.event === "PermissionModeChanged")).toHaveLength(0);
    expect((app as unknown as AppInternals).config.permissionMode).toBe("acceptEdits");
  });

  test("collector 未就绪时进 pending 队列，不静默丢弃", async () => {
    const app = makeApp("default");
    const internal = app as unknown as AppInternals;
    // 启动早期（企业策略回拨 / CLAUDE.md 模式下发）走的正是这条路径
    internal.setPermissionMode("plan", "claude_md");
    expect(internal.pendingTraceEvents).toEqual([
      {
        event: "PermissionModeChanged",
        data: { from: "default", to: "plan", source: "claude_md" },
      },
    ]);
  });

  test("source 只取闭集：plan 进出 / 策略回拨各自可区分", async () => {
    const app = makeApp("default");
    const internal = app as unknown as AppInternals;
    internal.setPermissionMode("plan", "plan_enter");
    internal.setPermissionMode("default", "plan_exit");
    internal.setPermissionMode("acceptEdits", "policy");
    const sources = internal.pendingTraceEvents
      .filter((e) => e.event === "PermissionModeChanged")
      .map((e) => (e.data as { source: string }).source);
    expect(sources).toEqual(["plan_enter", "plan_exit", "policy"]);
  });
});
