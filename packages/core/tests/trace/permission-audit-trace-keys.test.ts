/**
 * 权限审计 ↔ 轨迹共同键（Harness 厚薄归位专项 B19 / B20 / B21，Refs #672）。
 *
 * 修前（2026-11-08 本机实测）：
 *  - 轨迹 `PermissionDecision` 6.8 万条里带 tool_use_id 的 0 条，审计 `AuditEntry` 无 session_id，
 *    只能按「紧随 PreToolUse」+ ±1s 时间窗配对，拒绝只配上 286/464；
 *  - ask 的终局（人工批准 / 拒绝、hook 裁决、超时）审计里一条都没有，`user_confirmed` 全量 false；
 *  - A5 hook-ask 无交互拒绝不落审计；A2 注入校验器与 A6 展开超限在轨迹上都是 step=2，不可分；
 *  - 审计 10MB × 1 代、98.4% 是 allow，约 11.5 天后 deny 被挤出轮转。
 *
 * 走生产入口：真 PermissionChecker → 真 executeTools（主循环权限门）→ 门面 → 真 collector 落盘，
 * 审计走真 AuditLogger 落到 SID_CONFIG_DIR 下。只断言到观察者入参的测试守不住 collector 映射
 * （#668 刚踩过），所以这里一律读 events.jsonl 与审计文件。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  setPermissionDecisionObserver,
  guardOf,
  type PermissionDecisionEvent,
} from "@sid-code/core/permission/decision-telemetry.ts";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import {
  AuditLogger,
  isRetainedAuditEntry,
  retainedAuditPath,
} from "@sid-code/core/permission/audit.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { executeTools, type ToolExecutorDeps } from "@sid-code/core/query/tool-executor.ts";
import { getSessionId, setSessionId } from "@sid-code/core/bootstrap/state.ts";
import { runForkedAgent, type ForkedAgentContext } from "@sid-code/core/agent/forked-agent.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import type { AuditEntry } from "@sid-code/core/permission/types.ts";

let dir: string;
const saved = {
  index: process.env.SID_CODE_SESSION_INDEX,
  config: process.env.SID_CONFIG_DIR,
  sessionId: getSessionId(),
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "sid-audit-keys-")));
  process.env.SID_CODE_SESSION_INDEX = join(dir, "session-index.jsonl");
  process.env.SID_CONFIG_DIR = join(dir, "cfg");
  setSessionId("proc-sess-1");
});

afterEach(async () => {
  setPermissionDecisionObserver(null);
  // 落盘走同步 appendFileSync，但 collector 有 import().then()，先让微任务跑干再还原 env
  await new Promise((r) => setTimeout(r, 0));
  setSessionId(saved.sessionId);
  for (const [k, v] of [
    ["SID_CODE_SESSION_INDEX", saved.index],
    ["SID_CONFIG_DIR", saved.config],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const auditPath = () => join(dir, "cfg", "logs", "permissions-audit.log");
const readJsonl = (p: string): any[] =>
  existsSync(p)
    ? readFileSync(p, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** 交互式 default 档：`git push` 落 Step 14 ask（不是危险命令，是「默认要问」） */
function interactiveChecker(ws: string, extra: Record<string, unknown> = {}) {
  return new PermissionChecker(
    { ...defaultConfig(), print: false, maxTurns: undefined, ...extra } as never,
    undefined,
    ws,
  );
}

async function startCollector(sessionId: string, ws: string) {
  const { HookSystem } = await import("@sid-code/core/hook/system.ts");
  const hooks = new HookSystem();
  hooks.setSessionId(sessionId);
  hooks.setCwd(ws);
  const trajDir = join(dir, "trajectories");
  new TraceCollector({ outputDir: trajDir }).registerHooks(hooks);
  await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
  // 空白会话会被清掉：补一轮模型调用（同 permission-step-mode-observability.test.ts）
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
  const events = async () => {
    await hooks.fireSessionEndEvent("exit");
    return readJsonl(join(trajDir, "sessions", sessionId, "events.jsonl"));
  };
  return { hooks, events };
}

function mockTool(name: string) {
  const readOnly = name === "glob";
  return {
    name: () => name,
    description: () => `mock ${name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => readOnly,
    isConcurrencySafe: () => readOnly,
    execute: async () => ({ output: "ok" }),
  };
}

function mainDeps(checker: PermissionChecker, hooks: unknown, confirm: boolean): ToolExecutorDeps {
  const tools = new Map(["bash", "glob"].map((n) => [n, mockTool(n)]));
  return {
    config: { checkpoint: { enabled: false } } as never,
    toolRegistry: {
      get: (n: string) => tools.get(n) ?? null,
      isDeferred: () => false,
      isActivated: () => true,
      isToolSearchEnabled: () => false,
    } as never,
    sessionState: {
      sessionId: "keys",
      addToolDuration: () => {},
      recordToolResult: () => {},
    } as never,
    hookSystem: hooks as never,
    permissionChecker: checker,
    preToolUseCache: new Map(),
    getAbortSignal: () => undefined,
    requestUserConfirmation: async () => confirm,
  } as ToolExecutorDeps;
}

const use = (id: string, command: string) => ({
  type: "tool_use" as const,
  id,
  name: "bash",
  input: { command },
});

// ─── B19 + B20：主循环 ask 终局，三方按 tool_use_id join ───

describe("主循环 ask → 人工作答：PreToolUse / PermissionDecision / 审计按 tool_use_id join", () => {
  for (const confirm of [true, false]) {
    test(`人工${confirm ? "批准" : "拒绝"}：审计终局行 user_confirmed=true、confirm_source=user，并进保留日志`, async () => {
      const ws = join(dir, "ws");
      const checker = interactiveChecker(ws);
      const { hooks, events } = await startCollector("sess-join", ws);
      const id = `toolu_join_${confirm ? "ok" : "no"}`;

      await executeTools([use(id, "git push")], mainDeps(checker, hooks, confirm));
      const evs = await events();

      // 轨迹：PreToolUse 与 PermissionDecision 带同一个 id
      const pre = evs.find((e) => e.event === "PreToolUse");
      expect(pre?.data?.tool_use_id).toBe(id);
      const decision = evs.find((e) => e.event === "PermissionDecision");
      expect(decision.data).toMatchObject({
        tool_use_id: id,
        outcome: confirm ? "allow" : "deny",
        prompted: true,
        source: "user",
      });

      // 审计：同一个 id 的终局行，盖了本进程会话键
      const rows = readJsonl(auditPath()).filter((r) => r.tool_use_id === id);
      const final = rows.find((r) => r.confirm_source !== undefined);
      expect(final).toMatchObject({
        tool_use_id: id,
        session_id: "proc-sess-1",
        decision: confirm ? "allow" : "deny",
        user_confirmed: true,
        confirm_source: "user",
      });

      // B21：终局行（含人工批准的 allow）进保留日志
      const kept = readJsonl(retainedAuditPath(auditPath())).filter((r) => r.tool_use_id === id);
      expect(kept.map((r) => r.confirm_source)).toContain("user");
    });
  }

  test("规则直接放行：审计行带 tool_use_id + session_id，但不进保留日志（98% 的噪声留在主日志）", async () => {
    const ws = join(dir, "ws");
    const checker = interactiveChecker(ws);
    const { hooks, events } = await startCollector("sess-allow", ws);

    // glob 是只读白名单工具（Step 10 放行），不经确认
    await executeTools(
      [{ type: "tool_use", id: "toolu_glob", name: "glob", input: { pattern: "*" } }],
      mainDeps(checker, hooks, false),
    );
    const evs = await events();

    const decision = evs.find((e) => e.event === "PermissionDecision");
    expect(decision.data).toMatchObject({
      tool_use_id: "toolu_glob",
      outcome: "allow",
      prompted: false,
    });
    const row = readJsonl(auditPath()).find((r) => r.tool_use_id === "toolu_glob");
    expect(row).toMatchObject({ decision: "allow", session_id: "proc-sess-1" });
    expect(row.confirm_source).toBeUndefined();
    expect(
      readJsonl(retainedAuditPath(auditPath())).some((r) => r.tool_use_id === "toolu_glob"),
    ).toBe(false);
  });
});

// ─── B20：A2 / A6 在轨迹可分 ───

describe("A2 注入校验器在轨迹上带 guard（headless 拒绝）", () => {
  test("brace-expansion 拒绝：PermissionDecision.guard=injection:brace-expansion，审计行同 id", async () => {
    const ws = join(dir, "ws");
    const checker = new PermissionChecker(
      { ...defaultConfig(), print: true } as never,
      undefined,
      ws,
    );
    const { hooks, events } = await startCollector("sess-guard", ws);

    await executeTools([use("toolu_brace", "echo {a,b}")], mainDeps(checker, hooks, false));
    const evs = await events();

    const decision = evs.find((e) => e.event === "PermissionDecision");
    expect(decision.data).toMatchObject({
      tool_use_id: "toolu_brace",
      outcome: "deny",
      step: "headless:2",
      guard: "injection:brace-expansion",
    });
    const row = readJsonl(auditPath()).find((r) => r.tool_use_id === "toolu_brace");
    expect(row).toMatchObject({ decision: "deny", session_id: "proc-sess-1" });
  });

  test("guardOf 只认闭集标签：注入校验器 / 展开超限；LLM 自由文本与其他类型一律不取", () => {
    expect(
      guardOf({ decisionReason: { type: "dangerousCommand", pattern: "injection:newlines" } }),
    ).toBe("injection:newlines");
    expect(guardOf({ decisionReason: { type: "dangerousCommand", pattern: "展开超限" } })).toBe(
      "expansion-limit",
    );
    expect(
      guardOf({ decisionReason: { type: "dangerousCommand", pattern: "LLM: rm 了 /etc/passwd" } }),
    ).toBeUndefined();
    expect(guardOf({ decisionReason: { type: "rule", pattern: "injection:newlines" } })).toBe(
      undefined,
    );
    expect(guardOf({})).toBeUndefined();
  });
});

// ─── B20：A5 hook-ask 无交互拒绝补审计 ───

describe("A5 PreToolUse hook ask 在无交互通道下拒绝：审计里要有这一行", () => {
  test("print 模式 + hook ask → 审计 deny 行，带 tool_use_id", async () => {
    const ws = join(dir, "ws");
    const checker = new PermissionChecker(
      { ...defaultConfig(), print: true } as never,
      undefined,
      ws,
    );
    const d = await checker.check(
      { toolName: "glob", input: { pattern: "*" }, toolUseId: "toolu_hookask" },
      undefined,
      undefined,
      { hookPermissionDecision: "ask" },
    );
    expect(d).toMatchObject({ allowed: false, step: "hook-ask" });
    const row = readJsonl(auditPath()).find((r) => r.tool_use_id === "toolu_hookask");
    expect(row).toMatchObject({
      decision: "deny",
      session_id: "proc-sess-1",
      decisionReason: { reason: "PreToolUse hook ask (non-interactive)" },
    });
  });
});

// ─── A9：auto 分类器回退成因 ───

describe("A9 auto 档分类器回退人工时带成因标记", () => {
  const cases: Array<[string, () => Promise<unknown>, string]> = [
    ["分类器抛错", async () => Promise.reject(new Error("boom")), "error"],
    ["分类器判不安全", async () => ({ safe: false, reason: "危险" }), "unsafe"],
    [
      "分类器不可用",
      async () => ({ safe: false, reason: "-", classifierUnavailable: true }),
      "unavailable",
    ],
  ];
  for (const [name, classify, expected] of cases) {
    test(`${name} → metadata.autoClassifier=${expected}，决策本身仍是 needsConfirmation`, async () => {
      const c = interactiveChecker(join(dir, "ws"), { permissionMode: "auto" });
      c.setToolClassifier({ isAvailable: () => true, classify } as never);
      const d = await c.check({ toolName: "bash", input: { command: "git push" } });
      expect(d.allowed).toBe(false);
      expect(d.needsConfirmation).toBe(true);
      expect(d.metadata?.autoClassifier).toBe(expected);
    });
  }

  test("落盘：ask 终局的 PermissionDecision 带 auto_classifier", async () => {
    const ws = join(dir, "ws");
    const c = interactiveChecker(ws, { permissionMode: "auto" });
    c.setToolClassifier({
      isAvailable: () => true,
      classify: async () => ({ safe: false, reason: "危险" }),
    } as never);
    const { hooks, events } = await startCollector("sess-auto", ws);
    await executeTools([use("toolu_auto", "git push")], mainDeps(c, hooks, true));
    const evs = await events();
    const decision = evs.find((e) => e.event === "PermissionDecision");
    expect(decision.data).toMatchObject({ tool_use_id: "toolu_auto", auto_classifier: "unsafe" });
  });
});

// ─── B19 / B20：forked 路径 ───

function forkCtx(command: string): ForkedAgentContext {
  let call = 0;
  const provider = {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream() {
      if (call++ === 0) {
        yield {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_fork_1", name: "bash" },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ command }) },
        };
        yield { type: "content_block_stop", index: 0 };
        yield {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { outputTokens: 1 },
        };
        return;
      }
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "完成" } };
      yield { type: "content_block_stop", index: 0 };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { outputTokens: 1 },
      };
    },
  };
  return {
    systemPrompt: "s",
    messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    provider: provider as never,
    toolRegistry: new ToolRegistry(),
    model: "mock-model",
    statefulTools: [],
  };
}

describe("forked 路径：带 tool_use_id 与 step=forked，不编造 mode", () => {
  test("canUseTool 拒绝 → 事件 step=forked、tool_use_id 与模型给的 id 一致、无 mode", async () => {
    const got: PermissionDecisionEvent[] = [];
    setPermissionDecisionObserver((e) => got.push(e));
    await runForkedAgent(forkCtx("rm -rf x"), {
      promptMessages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      canUseTool: () => ({ behavior: "deny", message: "旁路提问不允许使用工具" }),
      maxTurns: 3,
      querySource: "btw",
    });
    const deny = got.find((e) => e.outcome === "deny")!;
    expect(deny).toMatchObject({ context: "forked", step: "forked", toolUseId: "toolu_fork_1" });
    expect(Object.keys(deny)).not.toContain("mode");
  });
});

// ─── B19 / B21：AuditLogger 写入口 ───

describe("AuditLogger：会话键统一盖章 + 保留日志判据", () => {
  const base = (over: Partial<AuditEntry>): AuditEntry => ({
    timestamp: new Date().toISOString(),
    type: "tool_use",
    tool: "bash",
    decision: "allow",
    ...over,
  });

  test("调用方没给 session_id 就盖本进程的；显式给了不覆盖；进程 id 为空不写空串", () => {
    const logger = new AuditLogger(auditPath());
    logger.log(base({ resource: "a" }));
    logger.log(base({ resource: "b", session_id: "explicit" }));
    setSessionId("");
    logger.log(base({ resource: "c" }));
    const rows = readJsonl(auditPath());
    expect(rows.map((r) => r.session_id)).toEqual(["proc-sess-1", "explicit", undefined]);
    expect(Object.keys(rows[2])).not.toContain("session_id");
  });

  test("保留判据：deny 与确认终局进，静默 allow 与启动探针不进", () => {
    expect(isRetainedAuditEntry(base({ decision: "deny" }))).toBe(true);
    expect(isRetainedAuditEntry(base({ decision: "allow", confirm_source: "user" }))).toBe(true);
    expect(isRetainedAuditEntry(base({ decision: "allow" }))).toBe(false);
    expect(isRetainedAuditEntry(base({ decision: "deny", source: "policy-probe" }))).toBe(false);

    const logger = new AuditLogger(auditPath());
    logger.log(base({ resource: "quiet-allow" }));
    logger.log(base({ resource: "deny", decision: "deny" }));
    logger.log(base({ resource: "probe", decision: "deny", source: "policy-probe" }));
    expect(readJsonl(auditPath()).map((r) => r.resource)).toEqual(["quiet-allow", "deny", "probe"]);
    expect(readJsonl(retainedAuditPath(auditPath())).map((r) => r.resource)).toEqual(["deny"]);
  });

  test("保留日志独立轮转：主日志被 allow 挤到轮转，旧 deny 仍在保留日志里", () => {
    const logger = new AuditLogger(auditPath());
    (logger as unknown as { maxSize: number }).maxSize = 400;
    logger.log(base({ resource: "old-deny", decision: "deny" }));
    for (let i = 0; i < 20; i++) logger.log(base({ resource: `allow-${i}` }));
    const primary = [...readJsonl(`${auditPath()}.1`), ...readJsonl(auditPath())];
    expect(primary.some((r) => r.resource === "old-deny")).toBe(false);
    expect(readJsonl(retainedAuditPath(auditPath())).map((r) => r.resource)).toEqual(["old-deny"]);
  });

  test("保留日志路径：x.log → x-retained.log（默认落 logs/permissions-audit-retained.log）", () => {
    expect(retainedAuditPath("/l/permissions-audit.log")).toBe("/l/permissions-audit-retained.log");
    expect(retainedAuditPath("/l/audit")).toBe("/l/audit-retained");
  });
});

// ─── 结构哨兵：审计只有一个写入口 ───

describe("哨兵：checker 的审计行全部经 audit() 盖 tool_use_id", () => {
  test("checker.ts 里直接调 this.auditLogger.log( 的只有 audit() 自己那一处", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/permission/checker.ts"), "utf-8");
    const hits = src.split("this.auditLogger.log(").length - 1;
    expect(hits).toBe(1);
    expect(src).toContain("private audit(req: PermissionRequest, entry: AuditEntry)");
  });
});

// ─── B19 / B20：子代理路径（agent/tool-executor → run-tool-use） ───

class MockBashTool {
  name() {
    return "bash";
  }
  description() {
    return "mock bash";
  }
  inputSchema() {
    return { type: "object", properties: { command: { type: "string" } } };
  }
  async execute() {
    return { output: "ok" };
  }
  readOnly() {
    return false;
  }
  isConcurrencySafe() {
    return false;
  }
}

describe("子代理路径：dontAsk 拒绝也带 tool_use_id 与 guard，审计行同 id", () => {
  test("注入校验器命中 → dontAsk 落拒：事件 context=subagent、guard 保留、审计可 join", async () => {
    const { executeTools: executeSubagentTools } =
      await import("@sid-code/core/agent/tool-executor.ts");
    const got: PermissionDecisionEvent[] = [];
    setPermissionDecisionObserver((e) => got.push(e));
    const checker = new PermissionChecker(
      { ...defaultConfig(), permissionMode: "dontAsk" } as never,
      undefined,
      join(dir, "ws"),
    );
    const registry = new ToolRegistry();
    registry.register(new MockBashTool() as never);
    await executeSubagentTools(
      [{ type: "tool_use", id: "toolu_sub_1", name: "bash", input: { command: "echo {a,b}" } }],
      registry,
      undefined,
      undefined,
      checker,
    );
    const deny = got.find((e) => e.outcome === "deny")!;
    expect(deny).toMatchObject({
      context: "subagent",
      toolUseId: "toolu_sub_1",
      step: "dontAsk",
      guard: "injection:brace-expansion",
    });
    const row = readJsonl(auditPath()).find((r) => r.tool_use_id === "toolu_sub_1");
    expect(row).toMatchObject({ decision: "deny", session_id: "proc-sess-1" });
  });
});
