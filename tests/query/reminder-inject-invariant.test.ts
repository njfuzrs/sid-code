/**
 * Reminder 注入不变量哨兵（queryLoop 集成）
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
import { queryLoop } from "../../src/query/loop.ts";
import type { QueryLoopConfig } from "../../src/query/loop.ts";
import type { QueryDeps } from "../../src/query/types.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { Registry as ToolRegistry } from "../../src/tool/registry.ts";
import { ModelFallback } from "../../src/llm/fallback.ts";
import { SessionState } from "../../src/session/state.ts";
import type { Config } from "../../src/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "../../src/llm/types.ts";

/** 复刻事故轨迹的用户指令（/commit 展开，~1600 字符量级） */
const USER_INSTRUCTION = "# Commit: 生成提交信息并提交\n\n基于当前 git 变更生成规范 commit message 并提交。"
  + "\n".repeat(3) + "步骤说明".repeat(200);

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
    autoCompact: async () => {},
    handleContextOverflow: () => null,
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

describe("不变量 3：注入产物永不写回 ctxMgr", () => {
  test("跑完多轮后，历史里不含任何注入通道产物", async () => {
    const { loopConfig, ctxMgr } = makeHarness(
      [toolUseResp("t1"), toolUseResp("t2"), finalResp()],
      { deferredTools: ["mcp__foo__bar", "mcp__baz__qux"] },
    );
    for await (const _ of queryLoop(loopConfig)) { /* drain */ }

    const history = historyUserTexts(ctxMgr).join("\n");
    // 三类注入产物一个都不许落历史
    expect(history).not.toContain("<available-deferred-tools>");
    expect(history).not.toContain("MCP Server Instructions");
    expect(history).not.toContain("LSP 诊断");
    // 用户原始指令必须完好无损（未被注入内容污染 / 未被替换）
    expect(history).toContain("# Commit: 生成提交信息并提交");
  });

  test("用户消息在历史里保持为单一未污染的 text block", async () => {
    const { loopConfig, ctxMgr } = makeHarness([finalResp()], {
      deferredTools: ["mcp__foo__bar"],
    });
    for await (const _ of queryLoop(loopConfig)) { /* drain */ }

    const first = ctxMgr.getMessages().find((m) => m.role === "user");
    const blocks = (first!.content as any[]).filter((b) => b.type === "text");
    expect(blocks.length).toBe(1);
    expect(blocks[0].text).toBe(USER_INSTRUCTION); // 逐字节等于原文
  });
});

describe("量化闸门：真实用户指令不被注入内容淹没", () => {
  test("首轮发送副本里，用户指令起始偏移 < 5%（原实测 40%）", async () => {
    const { loopConfig, sentTurns } = makeHarness([finalResp()], {
      // 复刻事故量级：19 个延迟工具名
      deferredTools: Array.from({ length: 19 }, (_, i) => `mcp__server${i}__some_long_tool_name`),
    });
    for await (const _ of queryLoop(loopConfig)) { /* drain */ }

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
    for await (const _ of queryLoop(loopConfig)) { /* drain */ }

    // 首轮无 critical（止损阀只在 tool_result 轮触发）→ 用户指令应在最前
    expect(sentTurns[0].blocks[0]).toBe(USER_INSTRUCTION);
  });

  test("每个注入 block 都带 <system-reminder> 围栏（P0-a）", async () => {
    const { loopConfig, sentTurns } = makeHarness([finalResp()], {
      deferredTools: ["mcp__foo__bar"],
    });
    for await (const _ of queryLoop(loopConfig)) { /* drain */ }

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
    for await (const _ of queryLoop(loopConfig)) { /* drain */ }

    const announceTurns = sentTurns.filter((t) =>
      t.wire.includes("<available-deferred-tools>"),
    );
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

    for await (const _ of queryLoop(loopConfig)) { /* drain */ }

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
