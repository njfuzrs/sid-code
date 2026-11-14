/**
 * CP-11（P1）：语义召回记忆必须走 persistent 通道。
 *
 * 修前 `query/loop.ts` 是 `reminderParts.push(recalled)` —— 只进发送副本
 * （`query/reminder-inject.ts` 打 `transient: true`），所以召回内容只活**本轮的第 1 次
 * 请求**：工具循环第 2 次请求起模型看不到它，而且该条 user 消息尾部少一整块，
 * 前缀正好断在那里（成本面板里那次被记成 `none_local` 的断裂，CP-9）。
 *
 * 修后走 `persistentReminderParts`：写回最后一条 user 消息，后续每轮原样重放。
 * 这不是「顺手统一风格」——周边三条假设都要求内容留在上下文里：
 * ① `memory/recall.ts` 的 alreadySurfaced 不再召回已注入的记忆；
 * ② `cli/src/app.ts` 的 surfacedRecalledMemories 同理；
 * ③ `RECALL_SESSION_MAX_BYTES` 是「两次压缩之间」的累计预算。
 *
 * ## 为什么驱动真实 queryLoop
 *
 * 这条缺陷的本质是「两个通道选错了」，手造 messages 的快照测试天然造不出这个错误
 * （快照里想放什么就放什么）。只有让真实主循环连发 3 次请求，再回头看这 3 次
 * 实际发出的请求体，才能证明「召回块一直在同一条 user 消息里」。
 *
 * 验收对应方案文档的 D1（G1）与 D2（变异自证：改回 reminderParts 即变红）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryLoop, type QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type {
  AccumulatedResponse,
  ContentBlock,
  SendParams,
  StreamEvent,
} from "@sid-code/core/llm/types.ts";

/** 召回块的标记文案（与生产 app.ts 生成的附件同名即可，判据只认这段文本） */
const RECALL_MARK = "<recalled-memory>";
const RECALL_TEXT = `${RECALL_MARK}\n用户偏好：所有回复用中文。\n</recalled-memory>`;

let testDir = "";
let savedTmp: string | undefined;

beforeEach(() => {
  // 落盘隔离：collector 显式 outputDir + 进程级 tmp 重定向，双保险
  // （bunfig preload 有兜底，但「要断言落盘内容的测试仍应自己隔离」）
  savedTmp = process.env.SID_CODE_TMPDIR;
  testDir = mkdtempSync(join(tmpdir(), "sid-recall-persistent-"));
  process.env.SID_CODE_TMPDIR = testDir;
});

afterEach(() => {
  if (savedTmp === undefined) delete process.env.SID_CODE_TMPDIR;
  else process.env.SID_CODE_TMPDIR = savedTmp;
  rmSync(testDir, { recursive: true, force: true });
});

/** 最小工具：让工具循环有东西可调 */
function readTool() {
  return {
    name: () => "read",
    description: () => "read",
    inputSchema: () => ({ type: "object", properties: { file_path: { type: "string" } } }),
    execute: async () => ({ output: "ok" }),
    readOnly: () => true,
  };
}

function textOf(messages: readonly unknown[] | undefined): string {
  if (!messages) return "";
  const out: string[] = [];
  for (const msg of messages as Array<{ content?: unknown }>) {
    const content = msg?.content;
    if (typeof content === "string") {
      out.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; text?: string }>) {
      if (block?.type === "text" && typeof block.text === "string") out.push(block.text);
    }
  }
  return out.join("\n");
}

/** events.jsonl 里的 prefix_break 事件（按 index 升序，index 是请求序号，1 起） */
function prefixBreaks(): Array<Record<string, unknown>> {
  const raw = readFileSync(join(testDir, "sessions", "sess-recall", "events.jsonl"), "utf-8");
  return raw
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === "prefix_break")
    .map((e) => e.data)
    .sort((a, b) => Number(a.index) - Number(b.index));
}

/**
 * 跑一次真实 queryLoop：第 1、2 次请求让模型调工具，第 3 次收尾。
 *
 * `turns` 的三个值就是验收 D1 说的「一次用户提问 + 3 次工具循环请求」。
 */
async function runThreeRequests(): Promise<{
  sent: SendParams[];
  ctxMgr: ContextManager;
  recallCalls: number;
}> {
  const sent: SendParams[] = [];
  const ctxMgr = new ContextManager({ maxTokens: 200_000 });
  ctxMgr.setSystemPrompt("system");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "帮我查一下缓存策略" }] });

  const tools = new ToolRegistry();
  tools.register(readTool() as any);

  const hs = new HookSystem();
  hs.setSessionId("sess-recall");
  hs.setCwd("/tmp/test");
  new TraceCollector({ outputDir: testDir }).registerHooks(hs);
  await hs.fireSessionStartEvent("startup", { model: "m" });

  let responds = 0;
  let recallCalls = 0;

  const deps: QueryDeps = {
    sendWithRetry: (p: SendParams) => {
      sent.push(p);
      return (async function* empty(): AsyncIterable<StreamEvent> {})();
    },
    processStream: async () => {
      responds++;
      if (responds <= 2) {
        const content: ContentBlock[] = [
          { type: "tool_use", id: `t${responds}`, name: "read", input: { file_path: "a" } },
        ];
        return {
          role: "assistant",
          content,
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5 },
        } as AccumulatedResponse;
      }
      return {
        role: "assistant",
        content: [{ type: "text", text: "完成" }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      } as AccumulatedResponse;
    },
    executeTools: async (blocks: ContentBlock[]) => ({
      results: blocks
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({
          type: "tool_result" as const,
          tool_use_id: b.id,
          content: "ok",
        })) as ContentBlock[],
    }),
    autoCompact: async () => ({ kind: "skipped" as const }),
    getAbortSignal: () => undefined,
    uuid: () => "uuid-recall-test",
    drainRecalledMemories: async () => {
      recallCalls++;
      return RECALL_TEXT;
    },
  };

  const loopConfig: QueryLoopConfig = {
    config: {
      model: "mock-model",
      provider: "anthropic",
      maxTurns: 4,
      maxTokens: 8192,
    } as unknown as Config,
    ctxMgr,
    toolRegistry: tools,
    sessionState: new SessionState("recall-persistent-test"),
    fallback: new ModelFallback(),
    hookSystem: hs,
    deps,
  };

  for await (const _ev of queryLoop(loopConfig)) {
    /* drain */
  }
  return { sent, ctxMgr, recallCalls };
}

describe("CP-11 语义召回走 persistent 通道（D1）", () => {
  test("3 次工具循环请求里，召回块都在同一条 user 消息中", async () => {
    const { sent, recallCalls } = await runThreeRequests();

    // 前提：真的跑了 3 次请求，且只在首轮召回一次（不是每轮都召回）
    expect(sent.length).toBe(3);
    expect(recallCalls).toBe(1);

    // 「同一条 user 消息」= 历史里那条用户提问（index 0），而不是尾部新长出来的消息。
    // 聚合成一个数组再断言：失败时直接打印断在第几轮，而不是停在第一次不匹配处。
    const missingRounds = sent
      .map((p, i) => ({ round: i + 1, first: (p.messages[0] as { content?: unknown })?.content }))
      .filter((x) => !textOf([{ content: x.first }]).includes(RECALL_MARK))
      .map((x) => x.round);
    expect(missingRounds).toEqual([]);
  }, 20_000);

  test("召回块写回了 ctxMgr 历史（不是只进发送副本）", async () => {
    const { ctxMgr } = await runThreeRequests();
    expect(textOf(ctxMgr.getMessages())).toContain(RECALL_MARK);
  });

  test("字节检测器对第 2、3 次请求都报 broken=false（前缀不再断在召回块）", async () => {
    const { sent } = await runThreeRequests();
    expect(sent.length).toBe(3);

    const rows = prefixBreaks();
    // index 1 是首轮，无可比对象不落事件；第 2、3 次各落一条
    expect(rows.map((r) => r.index)).toEqual([2, 3]);
    // 聚合断言：失败时直接列出断在第几次，而不是停在第一条不匹配处
    expect(rows.filter((r) => r.broken !== false).map((r) => r.index)).toEqual([]);
  });
});
