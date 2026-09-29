/**
 * N3 门禁：子代理 sidechain 必须在**全部三条执行路径**上落盘。
 *
 * 修之前只有 executeInner（进程内）写 sidechain；默认的 spawn 路径与自定义路径 0 处，
 * 实测 20 个真跑过子代理的会话、磁盘 sidechain 文件 0 个。现有 sidechain-resume.test.ts
 * 直接 new SidechainWriter，不经 SubAgent 的分派，所以对缺失路径完全不可见。
 * 本文件一律走生产入口（execute / executeCustom），断言磁盘上真的有文件、内容能被恢复扫描读到。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";
import { currentProjectSessionDir } from "@sid-code/core/session/store.ts";
import {
  reconstructSidechainMessages,
  scanUnfinishedSidechains,
} from "@sid-code/core/session/sidechain.ts";

const PARENT = "S-PARENT-N3";

class EchoTool implements LegacyTool {
  name() {
    return "echo";
  }
  description() {
    return "echo";
  }
  inputSchema() {
    return { type: "object", properties: { text: { type: "string" } } };
  }
  readOnly() {
    return true;
  }
  async execute(input: unknown): Promise<LegacyToolResult> {
    return { output: `echo: ${(input as { text?: string })?.text ?? ""}` };
  }
}

/** 进程内路径用：一轮纯文本回复即结束。 */
class TextProvider implements Provider {
  name() {
    return "mock";
  }
  defaultModel() {
    return "mock-model";
  }
  async *sendMessageStream(_p: SendParams): AsyncIterable<StreamEvent> {
    yield {
      type: "message_start",
      message: { id: "m1", role: "assistant", usage: { inputTokens: 10, outputTokens: 0 } },
    } as StreamEvent;
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } as StreamEvent;
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "自定义完成" },
    } as StreamEvent;
    yield { type: "content_block_stop", index: 0 } as StreamEvent;
    yield {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { outputTokens: 3 },
    } as StreamEvent;
  }
}

/** 假子进程：stdout 喂 NDJSON，stdin 只记录（手法同 subagent-spawn-progress-emit.test.ts）。 */
function fakeSpawnedProcess(messages: object[]) {
  const enc = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      for (const m of messages) c.enqueue(enc.encode(JSON.stringify(m) + "\n"));
      c.close();
    },
  });
  let killed = false;
  return {
    stdin: { write: (d: Uint8Array) => d.length },
    stdout,
    get killed() {
      return killed;
    },
    kill: () => {
      killed = true;
    },
    exited: Promise.resolve(0),
    exitCode: 0,
  };
}

async function withMockSpawn<T>(mock: (...a: any[]) => any, fn: () => Promise<T>): Promise<T> {
  const original = Bun.spawn;
  (Bun as any).spawn = mock;
  try {
    return await fn();
  } finally {
    (Bun as any).spawn = original;
  }
}

function sidechainFiles(): string[] {
  const dir = currentProjectSessionDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(`${PARENT}-`) && f.endsWith(".jsonl"));
}

function records(file: string): Array<Record<string, any>> {
  return readFileSync(join(currentProjectSessionDir(), file), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

describe("N3：sidechain 在全部执行路径上落盘", () => {
  let testDir: string;
  let origHome: string | undefined;
  let origConfigDir: string | undefined;
  let origNoSpawn: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-n3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = testDir;
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
    origNoSpawn = process.env.SIDCODE_NO_SPAWN;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (origNoSpawn === undefined) delete process.env.SIDCODE_NO_SPAWN;
    else process.env.SIDCODE_NO_SPAWN = origNoSpawn;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  test("spawn 路径（默认）：落 start → user → tool_use/tool_result → 最终输出 → end(completed)", async () => {
    delete process.env.SIDCODE_NO_SPAWN;
    const reg = new Registry();
    reg.register(new EchoTool());
    const agent = new SubAgent(new TextProvider(), "test-model", reg);
    (agent as any).spawnConfig = { providerName: "anthropic", apiKey: "k" };
    agent.setParentSessionId(PARENT);

    const proc = fakeSpawnedProcess([
      { type: "tool_use", id: "tu1", name: "echo", input: { text: "hi" } },
      {
        type: "result",
        success: true,
        output: "spawn 完成",
        usage: { inputTokens: 10, outputTokens: 5 },
        turns: 1,
        toolUseCount: 1,
      },
    ]);
    const result = await withMockSpawn(
      () => proc,
      () => agent.execute({ type: "explore", description: "n3 spawn", prompt: "干活" }),
    );
    expect(result.success).toBe(true);

    const files = sidechainFiles();
    expect(files.length).toBe(1);
    const recs = records(files[0]!);
    expect(recs[0]!.type).toBe("sidechain_start");
    expect(recs[0]!.agentType).toBe("explore");
    expect(recs.at(-1)).toMatchObject({ type: "sidechain_end", status: "completed" });
    const blocks = recs.filter((r) => r.type === "message").flatMap((r) => r.content);
    expect(blocks.some((b: any) => b.type === "text" && b.text === "干活")).toBe(true);
    expect(blocks.some((b: any) => b.type === "tool_use" && b.id === "tu1")).toBe(true);
    expect(blocks.some((b: any) => b.type === "tool_result" && b.tool_use_id === "tu1")).toBe(true);
    expect(blocks.some((b: any) => b.type === "text" && b.text === "spawn 完成")).toBe(true);

    // 恢复侧能读回：tool_use 与 tool_result 配对完整，不会被当悬空剔除。
    const agentId = recs[0]!.agentId as string;
    const rebuilt = reconstructSidechainMessages(PARENT, agentId);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.ended).toBe(true);
    expect(rebuilt!.messages.some((m) => m.content.some((b: any) => b.type === "tool_use"))).toBe(
      true,
    );
  });

  test("spawn 路径子进程意外退出：end(failed)，不留成「未结束」", async () => {
    delete process.env.SIDCODE_NO_SPAWN;
    const agent = new SubAgent(new TextProvider(), "test-model", new Registry());
    (agent as any).spawnConfig = { providerName: "anthropic", apiKey: "k" };
    agent.setParentSessionId(PARENT);
    const proc = fakeSpawnedProcess([]); // 没有 result 就退出
    await withMockSpawn(
      () => proc,
      () => agent.execute({ type: "explore", description: "n3 crash", prompt: "干活" }),
    );
    const files = sidechainFiles();
    expect(files.length).toBe(1);
    expect(records(files[0]!).at(-1)).toMatchObject({ type: "sidechain_end", status: "failed" });
    expect(scanUnfinishedSidechains(PARENT)).toEqual([]);
  });

  test("自定义路径（进程内 executeCustomInner）：落 start → 对话 → end(completed)", async () => {
    process.env.SIDCODE_NO_SPAWN = "1";
    const agent = new SubAgent(new TextProvider(), "test-model", new Registry());
    agent.setParentSessionId(PARENT);
    const result = await agent.executeCustom({
      systemPrompt: "你是自定义代理",
      userPrompt: "自定义任务",
      allowedTools: [],
      type: "my-skill",
    });
    expect(result.success).toBe(true);

    const files = sidechainFiles();
    expect(files.length).toBe(1);
    const recs = records(files[0]!);
    expect(recs[0]).toMatchObject({ type: "sidechain_start", agentType: "my-skill" });
    expect(recs.at(-1)).toMatchObject({ type: "sidechain_end", status: "completed" });
    const texts = recs
      .filter((r) => r.type === "message")
      .flatMap((r) => r.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text);
    expect(texts).toContain("自定义任务");
    expect(texts).toContain("自定义完成");
  });

  test("同类型自定义代理跑两次 ⇒ 两个独立 sidechain 文件（不串写）", async () => {
    process.env.SIDCODE_NO_SPAWN = "1";
    const agent = new SubAgent(new TextProvider(), "test-model", new Registry());
    agent.setParentSessionId(PARENT);
    const task = { systemPrompt: "s", userPrompt: "u", allowedTools: [], type: "dup" };
    await agent.executeCustom(task);
    await agent.executeCustom(task);
    expect(sidechainFiles().length).toBe(2);
  });

  test("未注入父会话 id ⇒ 不落盘（增强能力静默禁用，不影响执行）", async () => {
    process.env.SIDCODE_NO_SPAWN = "1";
    const agent = new SubAgent(new TextProvider(), "test-model", new Registry());
    const result = await agent.executeCustom({
      systemPrompt: "s",
      userPrompt: "u",
      allowedTools: [],
      type: "x",
    });
    expect(result.success).toBe(true);
    expect(sidechainFiles().length).toBe(0);
  });
});
