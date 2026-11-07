/**
 * 子代理委派形态与结束状态进轨迹（06H1 T3）
 *
 * 背景：此前「这次委派是隔离还是 fork」在轨迹里答不上来 —— fork 只有一行 info 日志；
 * SubagentStop 的 `status` 又只有 completed/error/unknown，分不出「执行失败」与
 * 「被中止」（本地 40 条非 completed 的 sidechain 里 13 条是 aborted，事件里与 error 同形）。
 *
 * 这里锁住四条不变式：
 * 1. 普通子代理 delegation_mode=isolated，且不带 fork 的两个计数（缺字段 ≠ 写 0）
 * 2. fork 子代理 delegation_mode=fork，并带 inherited_messages / parent_messages
 * 3. 团队成员的 delegation_mode=team（身份取自 ALS，不靠调用方自报）
 * 4. SubagentStop.end_status 能区分 completed / failed / aborted，旧 status 字段口径不变
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { withTeamMember } from "@sid-code/core/swarm/team-context.ts";

/** 只回一句话就收尾的 provider：把子代理跑到正常结束。 */
class OneShotProvider implements Provider {
  name() {
    return "one-shot";
  }
  defaultModel() {
    return "m";
  }
  async *sendMessageStream(_params: SendParams): AsyncIterable<StreamEvent> {
    yield {
      type: "message_start",
      message: { id: "m1", role: "assistant", usage: { inputTokens: 1, outputTokens: 0 } },
    } as StreamEvent;
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } as StreamEvent;
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "## 结论\n完成" },
    } as StreamEvent;
    yield { type: "content_block_stop", index: 0 } as StreamEvent;
    yield {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { outputTokens: 1 },
    } as StreamEvent;
  }
}

/** 一进模型请求就抛错的 provider：用来制造「执行失败 / 被中止」两种非成功出口。
 *  带 status 400 是为了走不可重试分支——普通 Error 会被判 transient 并重试退避，
 *  5s 单测超时等不到终态。 */
class ThrowProvider implements Provider {
  name() {
    return "throw";
  }
  defaultModel() {
    return "m";
  }
  async *sendMessageStream(_params: SendParams): AsyncIterable<StreamEvent> {
    throw Object.assign(new Error("boom"), { status: 400 });
  }
}

interface RecordedEvent {
  event?: string;
  data?: Record<string, unknown>;
}

let base: string;
let outDir: string;
const savedConfigDir = process.env.SID_CONFIG_DIR;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sid-deleg-mode-"));
  outDir = join(base, "traj");
  mkdirSync(outDir, { recursive: true });
  // 子代理会写 sidechain / session registry，全部重定向到 tmpdir（不碰真实 ~/.sid-code）
  process.env.SID_CONFIG_DIR = join(base, "home");
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedConfigDir;
  rmSync(base, { recursive: true, force: true });
});

async function runWithTrace(
  sessionId: string,
  provider: Provider,
  run: (agent: SubAgent) => Promise<unknown>,
): Promise<RecordedEvent[]> {
  const hookSystem = new HookSystem();
  hookSystem.setSessionId(sessionId);
  hookSystem.setCwd(base);
  const collector = new TraceCollector({ outputDir: outDir });
  collector.registerHooks(hookSystem);
  await hookSystem.fireSessionStartEvent("startup", { model: "m" });

  const agent = new SubAgent(provider, "m", new Registry(), hookSystem);
  await run(agent);
  // SubagentStop 在 finally 里 fire 但不 await（不该让收尾阻塞子代理返回），
  // 给它一个微任务窗口再把事件读出来。
  await new Promise((r) => setTimeout(r, 20));

  const text = readFileSync(join(outDir, "sessions", sessionId, "events.jsonl"), "utf-8");
  return text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as RecordedEvent);
}

const findEvent = (events: RecordedEvent[], name: string) => events.find((e) => e.event === name);

describe("SubagentStart.delegation_mode", () => {
  test("普通子代理 = isolated，且不带 fork 的两个计数", async () => {
    const events = await runWithTrace("sess-isolated", new OneShotProvider(), (agent) =>
      agent.execute({ type: "explore", description: "核验", prompt: "看看" }),
    );
    const start = findEvent(events, "SubagentStart");
    expect(start?.data?.delegation_mode).toBe("isolated");
    // 缺字段而不是 0：否则「fork 用了几次」的筛选会把所有隔离子代理都算进来
    expect(start?.data?.inherited_messages).toBeUndefined();
    expect(start?.data?.parent_messages).toBeUndefined();
  });

  test("fork 子代理 = fork，并带继承条数与父对话总条数", async () => {
    const events = await runWithTrace("sess-fork", new OneShotProvider(), (agent) =>
      agent.execute({
        type: "explore",
        description: "接着聊",
        prompt: "继续",
        forkMessages: [
          { role: "user", content: [{ type: "text", text: "之前的问题" }] },
          { role: "assistant", content: [{ type: "text", text: "之前的回答" }] },
        ],
        _forkParentMessageCount: 9,
      }),
    );
    const start = findEvent(events, "SubagentStart");
    expect(start?.data?.delegation_mode).toBe("fork");
    // 继承的是尾部窗口（2 条），父对话原有 9 条 —— 两个数一起才看得出漏了多少前缀
    expect(start?.data?.inherited_messages).toBe(2);
    expect(start?.data?.parent_messages).toBe(9);
  });

  test("团队成员 = team（身份来自 ALS，不靠调用方自报）", async () => {
    const events = await runWithTrace("sess-team", new OneShotProvider(), (agent) =>
      withTeamMember(
        {
          teamName: "t1",
          memberName: "m1",
          mailbox: {} as never,
          memberNames: ["m1"],
        },
        () => agent.execute({ type: "explore", description: "团队活", prompt: "看看" }),
      ),
    );
    const start = findEvent(events, "SubagentStart");
    expect(start?.data?.delegation_mode).toBe("team");
  });

  test("自定义子代理路径显式标 isolated（不留空）", async () => {
    const events = await runWithTrace("sess-custom", new OneShotProvider(), (agent) =>
      agent.executeCustom({ systemPrompt: "你是验证器", userPrompt: "看看", allowedTools: [] }),
    );
    const start = findEvent(events, "SubagentStart");
    expect(start?.data?.agent_type).toBe("custom");
    // 「缺字段」与「真的是 isolated」必须能区分，否则统计分母又要靠猜
    expect(start?.data?.delegation_mode).toBe("isolated");
  });
});

describe("SubagentStop.end_status", () => {
  test("正常完成 = completed，旧 status 字段口径不变", async () => {
    const events = await runWithTrace("sess-completed", new OneShotProvider(), (agent) =>
      agent.execute({ type: "explore", description: "核验", prompt: "看看" }),
    );
    const stop = findEvent(events, "SubagentStop");
    expect(stop?.data?.end_status).toBe("completed");
    // 旧字段保留：已有分析脚本按它统计，不能断
    expect(stop?.data?.status).toBe("completed");
  });

  test("执行失败 = failed", async () => {
    const events = await runWithTrace("sess-failed", new ThrowProvider(), (agent) =>
      agent.execute({ type: "explore", description: "失败", prompt: "看看" }),
    );
    const stop = findEvent(events, "SubagentStop");
    expect(stop?.data?.end_status).toBe("failed");
    // 旧口径把失败与中止都记成 error，这正是新字段要补的缺口
    expect(stop?.data?.status).toBe("error");
  });

  test("被中止 = aborted（旧字段分不出这一类）", async () => {
    const ac = new AbortController();
    ac.abort();
    const events = await runWithTrace("sess-aborted", new ThrowProvider(), (agent) =>
      agent.execute({ type: "explore", description: "中止", prompt: "看看" }, ac.signal),
    );
    const stop = findEvent(events, "SubagentStop");
    expect(stop?.data?.end_status).toBe("aborted");
    // 旧字段仍是 error —— 证明新老口径确实不同，不是同一个值换个名字
    expect(stop?.data?.status).toBe("error");
  });
});
