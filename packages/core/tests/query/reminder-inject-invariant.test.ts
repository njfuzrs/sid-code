/**
 * Reminder 注入不变量哨兵（queryLoop 集成）
 *
 * 2026-10-31 分档：不变量 3 只约束 **transient 档**（每轮重算的内容）。「只播一次」的
 * persistent 档（MCP 说明 / 延迟工具增量 / skill listing / IDE 增量）改为写进历史、
 * 每轮原样重放——它们走 transient 时第 2 轮就从请求里消失，前缀在最后一条消息上断一整块，
 * 模型也再看不到这些说明。persistent 档的验收见下方同名 describe。
 *
 * 守卫两条不变量 + 一个量化闸门，全部有实测事故背书：
 *
 * **不变量 3「注入产物永不写回 ctxMgr」** —— 此前**完全无测试守卫**。
 * 破坏后会同时引发三处故障，且都不会立刻报错、只会静默变坏：
 *   1. TUI 泄漏：history-adapter 把工具列表 / MCP 说明当用户消息渲染出来；
 *   2. 压缩误取：auto-compact 抽"用户最初的请求"时抓到 `<available-deferred-tools>`；
 *   3. 逐轮累积：reminder 落历史后下一轮再注一遍，N 轮后上下文被自己的提醒占满。
 * 唯一例外是止损阀终态的"强制结束"notice（无下一轮可注入，只能直插历史），
 * 那条本身带 `<system-reminder>` 围栏、且不属于本文件校验的注入通道。
 *
 * **量化闸门：真实用户指令起始偏移 < 5%** —— 2026-07-29 实测为 40%
 * （轨迹 20260729-180624-b8ae8e78），模型第一眼看到的是延迟工具列表和 MCP 说明，
 * 转而抓 system prompt 记忆索引里的一条 `## 陈述句` 当用户意图。
 *
 * **P2 delta 化：延迟工具列表不得每轮全量重注** —— 原实现实测 11 轮请求里 10 轮
 * 内容逐字节相同（4204 字符 × 10），既是纯浪费也在持续稀释用户指令权重。
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "@sid-code/core/llm/types.ts";

/** 复刻事故轨迹的用户指令（/commit 展开，~1600 字符量级） */
const USER_INSTRUCTION =
  "# Commit: 生成提交信息并提交\n\n基于当前 git 变更生成规范 commit message 并提交。" +
  "\n".repeat(3) +
  "步骤说明".repeat(200);

async function* emptyStream(): AsyncIterable<StreamEvent> {}

function toolUseResp(id: string, name = "read"): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: { file_path: "/tmp/x" } }],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 5 },
  } as AccumulatedResponse;
}

function finalResp(text = "已完成"): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

/** 每次发送给 LLM 的最后一条 user 消息的 text block 序列（发送副本，非历史） */
interface SentTurn {
  blocks: string[];
  /** 模拟 OpenAI 族 join("\n") 后的 wire 形态（最坏情况：block 边界丢失） */
  wire: string;
}

function makeHarness(responses: AccumulatedResponse[], opts?: { deferredTools?: string[] }) {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test system prompt");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: USER_INSTRUCTION }] });

  const sentTurns: SentTurn[] = [];
  let call = 0;

  const deps: QueryDeps = {
    sendWithRetry: (params: any) => {
      const msgs = params?.messages ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== "user" || !Array.isArray(m.content)) continue;
        const blocks = m.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text as string);
        sentTurns.push({ blocks, wire: blocks.join("\n") });
        break;
      }
      return emptyStream();
    },
    processStream: async () => responses[call++] ?? finalResp(),
    executeTools: async (content: any[]) => ({
      results: content
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({ type: "tool_result" as const, tool_use_id: b.id, content: "ok" })),
    }),
    autoCompact: async () => ({ kind: "skipped" as const }),
    getAbortSignal: () => undefined,
    uuid: () => "uuid-test",
  };

  const toolRegistry = new ToolRegistry();
  if (opts?.deferredTools) {
    // 最小 stub，避免依赖真实 MCP 注册链路。必须同时覆盖这几个方法：
    // loop.ts 的 toolSearchEnabled 定档要读 size() / definitions() / activeDefinitions()
    // （size()===0 直接返回 false，且需要 definitions - activeDefinitions 有差集才算"有延迟工具"），
    // 播报逻辑再读 deferredToolNames()。少覆盖任何一个都会让整段延迟工具逻辑被跳过。
    const names = opts.deferredTools;
    (toolRegistry as any).size = () => names.length + 1;
    (toolRegistry as any).definitions = () => [
      { name: "read", description: "read", input_schema: { type: "object", properties: {} } },
      ...names.map((n) => ({
        name: n,
        description: "deferred tool ".repeat(50),
        input_schema: { type: "object", properties: {} },
      })),
    ];
    (toolRegistry as any).activeDefinitions = () => [
      { name: "read", description: "read", input_schema: { type: "object", properties: {} } },
    ];
    (toolRegistry as any).deferredToolNames = () => names;
  }

  const loopConfig: QueryLoopConfig = {
    // toolSearch: true 恒开，跳过"延迟工具 token 占比 ≥ 阈值"的自动判定——
    // 本文件测的是播报的 delta 语义，不该被定档启发式的阈值波动带偏。
    config: {
      model: "deepseek-v4-pro",
      provider: "openai",
      maxTurns: 30,
      toolSearch: true,
    } as unknown as Config,
    ctxMgr,
    toolRegistry,
    sessionState: new SessionState("test-session"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, ctxMgr, sentTurns };
}

/** ctxMgr 历史里所有 user text block 的文本 */
function historyUserTexts(ctxMgr: ContextManager): string[] {
  const out: string[] = [];
  for (const m of ctxMgr.getMessages()) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content as any[]) {
      if (b.type === "text" && typeof b.text === "string") out.push(b.text);
    }
  }
  return out;
}

/** 每次发送的完整 messages（深拷贝，供前缀比对） */
function captureFullSends(loopConfig: QueryLoopConfig): any[][] {
  const sends: any[][] = [];
  const orig = loopConfig.deps.sendWithRetry;
  loopConfig.deps.sendWithRetry = (params: any) => {
    sends.push(JSON.parse(JSON.stringify(params?.messages ?? [])));
    return (orig as any)(params);
  };
  return sends;
}

/** 一次性 MCP 说明 dep：首次调用返回说明块，之后返回 null（同 app.ts 的 announcedMcpServers 去重） */
function onceMcpDelta() {
  let announced = false;
  return () => {
    if (announced) return null;
    announced = true;
    return ["## demo-server\n使用 demo 工具前先调用 demo_init。"];
  };
}

describe("不变量 3：transient 档注入产物永不写回 ctxMgr", () => {
  test("每轮重算类（LSP 诊断等）不落历史；用户原文完好", async () => {
    const { loopConfig, ctxMgr } = makeHarness(
      [toolUseResp("t1"), toolUseResp("t2"), finalResp()],
      { deferredTools: ["mcp__foo__bar", "mcp__baz__qux"] },
    );
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    const history = historyUserTexts(ctxMgr).join("\n");
    expect(history).not.toContain("LSP 诊断");
    expect(history).toContain("# Commit: 生成提交信息并提交");
  });

  test("用户原文 block 逐字节不变，注入内容都是独立 block", async () => {
    const { loopConfig, ctxMgr } = makeHarness([finalResp()], {
      deferredTools: ["mcp__foo__bar"],
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    const first = ctxMgr.getMessages().find((m) => m.role === "user");
    const blocks = (first!.content as any[]).filter((b) => b.type === "text");
    expect(blocks[0].text).toBe(USER_INSTRUCTION);
    // 第一个之外的 block 只能是持久档（带标记），不能有 transient 块落历史
    for (const b of blocks.slice(1)) {
      expect(b.persistentReminder).toBe(true);
      expect(b.transient).toBeUndefined();
    }
  });
});

describe("persistent 档：只播一次的内容写进历史、之后每轮原样重放", () => {
  test("首轮注入的 MCP 说明与延迟工具清单，第 2、3 轮请求里仍在且位置不变", async () => {
    const { loopConfig, ctxMgr } = makeHarness(
      [toolUseResp("t1"), toolUseResp("t2"), finalResp()],
      { deferredTools: ["mcp__foo__bar"] },
    );
    loopConfig.deps.getMcpInstructionsDelta = onceMcpDelta();
    const sends = captureFullSends(loopConfig);
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    expect(sends.length).toBeGreaterThanOrEqual(3);
    // 首轮：msg[0] = [用户原文, 持久块...]
    const firstMsg0 = sends[0][0];
    const persisted = firstMsg0.content.filter((b: any) => b.persistentReminder);
    expect(persisted.map((b: any) => b.text).join("\n")).toContain("MCP Server Instructions");
    expect(persisted.map((b: any) => b.text).join("\n")).toContain("<available-deferred-tools>");
    // 后续每轮：msg[0] 与首轮逐字节相同（前缀不断）
    for (const later of sends.slice(1)) {
      expect(later[0]).toEqual(firstMsg0);
    }
    // 终态历史也留着它（对应文档「终态 messages.json 含 MCP 说明」）
    expect(historyUserTexts(ctxMgr).join("\n")).toContain("MCP Server Instructions");
  });

  test("前缀不断：每轮 messages 都是上一轮实际发送内容的前缀扩展", async () => {
    // 不剥 transient：缓存前缀比的是上一轮**实际发出**的字节。本 harness 里没有每轮重算类
    // 注入，所以任何一块在下一轮消失都是真断裂——修复前 MCP 说明 / 延迟工具清单正是这样丢的。
    const { loopConfig } = makeHarness([toolUseResp("t1"), toolUseResp("t2"), finalResp()], {
      deferredTools: ["mcp__foo__bar"],
    });
    loopConfig.deps.getMcpInstructionsDelta = onceMcpDelta();
    const sends = captureFullSends(loopConfig);
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }
    expect(sends.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < sends.length; i++) {
      const prev = sends[i - 1];
      const cur = sends[i];
      for (let k = 0; k < prev.length - 1; k++) expect(cur[k]).toEqual(prev[k]);
      const last = prev.length - 1;
      expect(cur[last].content.slice(0, prev[last].content.length)).toEqual(prev[last].content);
    }
  });

  test("不逐轮累积：持久块在历史里各只出现一次", async () => {
    const { loopConfig, ctxMgr } = makeHarness(
      [toolUseResp("t1"), toolUseResp("t2"), toolUseResp("t3"), finalResp()],
      { deferredTools: ["mcp__foo__bar"] },
    );
    loopConfig.deps.getMcpInstructionsDelta = onceMcpDelta();
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }
    const texts = historyUserTexts(ctxMgr);
    expect(texts.filter((t) => t.includes("MCP Server Instructions")).length).toBe(1);
    expect(texts.filter((t) => t.includes("<available-deferred-tools>")).length).toBe(1);
  });

  test("transient 块排在持久块之后（撤掉 transient 只在消息尾部变化）", async () => {
    const { loopConfig } = makeHarness([finalResp()], { deferredTools: ["mcp__foo__bar"] });
    loopConfig.deps.getMcpInstructionsDelta = onceMcpDelta();
    // 造一个每轮重算的 ambient：drainAsyncHookRewakes 走 transient
    loopConfig.deps.drainAsyncHookRewakes = () => ["hook 反馈 x"];
    const sends = captureFullSends(loopConfig);
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }
    const content = sends[0][0].content as any[];
    const lastPersist = content.map((b) => !!b.persistentReminder).lastIndexOf(true);
    const firstTransient = content.findIndex((b) => b.transient);
    expect(lastPersist).toBeGreaterThan(0);
    expect(firstTransient).toBeGreaterThan(lastPersist);
  });
});

describe("量化闸门：真实用户指令不被注入内容淹没", () => {
  test("首轮发送副本里，用户指令起始偏移 < 5%（原实测 40%）", async () => {
    const { loopConfig, sentTurns } = makeHarness([finalResp()], {
      // 复刻事故量级：19 个延迟工具名
      deferredTools: Array.from({ length: 19 }, (_, i) => `mcp__server${i}__some_long_tool_name`),
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    expect(sentTurns.length).toBeGreaterThan(0);
    const first = sentTurns[0];
    const idx = first.wire.indexOf("# Commit: 生成提交信息并提交");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx / first.wire.length).toBeLessThan(0.05);
  });

  test("用户指令是首轮的第一个 text block（ambient 全部后置）", async () => {
    const { loopConfig, sentTurns } = makeHarness([finalResp()], {
      deferredTools: ["mcp__foo__bar"],
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    // 首轮无 critical（止损阀只在 tool_result 轮触发）→ 用户指令应在最前
    expect(sentTurns[0].blocks[0]).toBe(USER_INSTRUCTION);
  });

  test("每个注入 block 都带 <system-reminder> 围栏（P0-a）", async () => {
    const { loopConfig, sentTurns } = makeHarness([finalResp()], {
      deferredTools: ["mcp__foo__bar"],
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    for (const turn of sentTurns) {
      for (const b of turn.blocks) {
        if (b === USER_INSTRUCTION) continue;
        expect(b.trim().startsWith("<system-reminder>")).toBe(true);
      }
    }
  });
});

describe("P2：延迟工具列表 delta 化", () => {
  test("工具集合不变时，只在首轮播报一次，后续轮不重复注入", async () => {
    const { loopConfig, sentTurns } = makeHarness(
      [toolUseResp("t1"), toolUseResp("t2"), toolUseResp("t3"), finalResp()],
      { deferredTools: ["mcp__foo__bar", "mcp__baz__qux"] },
    );
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    const announceTurns = sentTurns.filter((t) => t.wire.includes("<available-deferred-tools>"));
    expect(sentTurns.length).toBeGreaterThan(1); // 确实跑了多轮
    expect(announceTurns.length).toBe(1); // 但只播报一次
    expect(announceTurns[0].wire).toContain("mcp__foo__bar");
  });

  test("新增延迟工具时补播增量，且只含新增项", async () => {
    let deferred = ["mcp__foo__bar"];
    // 先按初始集合建 harness（装好 size/definitions 等 stub 让定档为 true），
    // 再把 deferredToolNames 换成读可变的 deferred，模拟运行中工具集增长。
    const { loopConfig, sentTurns } = makeHarness(
      [toolUseResp("t1"), toolUseResp("t2"), finalResp()],
      { deferredTools: ["mcp__foo__bar"] },
    );
    (loopConfig.toolRegistry as any).deferredToolNames = () => deferred;

    // 第二轮之后新增一个工具（模拟新 MCP server 连上）
    const origProcess = loopConfig.deps.processStream;
    let n = 0;
    loopConfig.deps.processStream = async (...args: any[]) => {
      if (++n === 2) deferred = ["mcp__foo__bar", "mcp__new__tool"];
      return (origProcess as any)(...args);
    };

    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    const announceTurns = sentTurns.filter((t) => t.wire.includes("<available-deferred-tools>"));
    expect(announceTurns.length).toBe(2); // 首轮全量 + 一次增量
    const delta = announceTurns[1].wire;
    expect(delta).toContain("mcp__new__tool");
    // 增量播报里**不该**再夹带已播报过的工具名（否则等于又一次全量）
    const toolsBlock = delta.slice(
      delta.indexOf("<available-deferred-tools>"),
      delta.indexOf("</available-deferred-tools>"),
    );
    expect(toolsBlock).not.toContain("mcp__foo__bar");
  });
});
