/**
 * 卡 E1（2026-10-14）：子代理轨迹关联键统一。
 *
 * 事故 20261014-110202-8c0ffb30：同一个子代理在轨迹里有三种 id
 * （SubagentStart `subagent-explore-<taskId>` / StreamPhase·RetryTelemetry `<parent>-sub-<taskId>` /
 * sidechain 裸 taskId），`parent_session_id` 恒 undefined、没有 `parent_tool_use_id`，
 * 残卷里的 `<output-file>` 指向会被驱逐的 `tasks/*.output`。
 *
 * 本文件走生产入口 `SubAgent.execute`，断言：
 *   1. hook（SubagentStart/Stop）、遥测（RetryTelemetry.agentId）、sidechain_start.canonicalAgentId
 *      三处是**同一个**规范 id；
 *   2. parent_session_id / parent_tool_use_id 非空且与派发方一致；
 *   3. 失败残卷的 `<output-file>` 指向 sidechain 文件，`evictTaskOutput` 之后仍在；带 `<parent-session>`；
 *   4. 两个工具执行器只给 sub_agent 注入 `_parentToolUseId`，且模型伪造的值会被剥掉。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import { executeTools } from "@sid-code/core/agent/tool-executor.ts";
import { stripInternalFields } from "@sid-code/core/tool/internal-fields.ts";
import { currentProjectSessionDir } from "@sid-code/core/session/store.ts";
import { evictTaskOutput, getAllTasks } from "@sid-code/core/task/index.ts";
import {
  setRetryTelemetryObserver,
  type RetryTelemetryEvent,
} from "@sid-code/core/llm/retry-telemetry.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { ContentBlock, StreamEvent } from "@sid-code/core/llm/types.ts";

const PARENT = "20261014-000000-e1e1e1e1";
const PARENT_TOOL_USE = "toolu_e1_parent";

async function* okStream(): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any;
  yield {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "交付" },
  } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { outputTokens: 1 },
  } as any;
}

function provider(fail: boolean): Provider {
  // 成功路径先抛一次可重试错误：mock 流不经真 provider，不会有 stream_completed，
  // 一次 retry 才能让漏斗发出带 agentId 的 RetryTelemetry 供断言。
  let calls = 0;
  return {
    name: () => "openai",
    defaultModel: () => "m",
    sendMessageStream: () =>
      !fail && ++calls === 1
        ? (async function* () {
            throw new Error("Connection error.");
          })()
        : fail
          ? (async function* () {
              // 非可重试的终态错误：漏斗立即放弃，子代理走失败残卷分支
              throw Object.assign(new Error("401 invalid api key"), { status: 401 });
            })()
          : okStream(),
  } as unknown as Provider;
}

function probe(sys: HookSystem, ev: HookEventName) {
  const seen: any[] = [];
  sys.registerHook(
    { type: "runtime", name: `probe-${ev}`, action: async (i) => void seen.push(i) },
    ev,
    { source: "runtime" as any },
  );
  return seen;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("E1：子代理规范 id 贯穿 hook / 遥测 / sidechain", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["HOME", "SID_CONFIG_DIR", "SIDCODE_NO_SPAWN", "SID_CODE_RETRY_BACKOFF_BASE_MS"];

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    home = mkdtempSync(join(tmpdir(), "sid-e1-"));
    process.env.HOME = home;
    process.env.SID_CONFIG_DIR = join(home, ".sid-code");
    process.env.SIDCODE_NO_SPAWN = "1";
    process.env.SID_CODE_RETRY_BACKOFF_BASE_MS = "0";
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    setRetryTelemetryObserver(null);
    rmSync(home, { recursive: true, force: true });
  });

  function makeAgent(fail: boolean) {
    const sys = new HookSystem();
    sys.setSessionId(PARENT);
    const starts = probe(sys, HookEventName.SubagentStart);
    const stops = probe(sys, HookEventName.SubagentStop);
    const agent = new SubAgent(provider(fail), "m", new Registry(), sys);
    agent.setParentSessionId(PARENT);
    return { agent, starts, stops };
  }

  test("成功路径：SubagentStart/Stop、RetryTelemetry、sidechain_start 是同一个规范 id", async () => {
    const telemetry: RetryTelemetryEvent[] = [];
    setRetryTelemetryObserver((e) => telemetry.push(e));
    const { agent, starts, stops } = makeAgent(false);

    const r = await agent.execute({
      type: "explore",
      description: "E1",
      prompt: "x",
      _parentToolUseId: PARENT_TOOL_USE,
    });
    await settle();
    expect(r.success).toBe(true);

    expect(starts.length).toBe(1);
    const id = starts[0].agent_id as string;
    // 规范形态：<parentSessionId>-sub-<taskId>
    expect(id.startsWith(`${PARENT}-sub-`)).toBe(true);
    expect(starts[0].parent_session_id).toBe(PARENT);
    expect(starts[0].parent_tool_use_id).toBe(PARENT_TOOL_USE);
    // 旧形态保留在 legacy 字段，不再占 agent_id
    expect(starts[0].legacy_agent_id).toMatch(/^subagent-explore-/);

    expect(stops.length).toBe(1);
    expect(stops[0].agent_id).toBe(id);
    expect(stops[0].parent_tool_use_id).toBe(PARENT_TOOL_USE);

    // 遥测：属于子代理的事件 agentId 全部等于规范 id（不止「存在」：一条都不许是别的形态）
    const mine = telemetry.filter((e) => e.agentId);
    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine.map((e) => e.agentId))).toEqual(new Set([id]));

    // sidechain_start 带关联键
    const dir = currentProjectSessionDir();
    const files = readdirSync(dir).filter((f) => f.startsWith(`${PARENT}-`));
    expect(files.length).toBe(1);
    const head = JSON.parse(readFileSync(join(dir, files[0]!), "utf-8").split("\n")[0]!);
    expect(head).toMatchObject({
      type: "sidechain_start",
      parentSessionId: PARENT,
      parentToolUseId: PARENT_TOOL_USE,
      canonicalAgentId: id,
      agentType: "explore",
    });
  });

  test("失败残卷：<output-file> 指向 sidechain（驱逐 tasks/*.output 后仍在），带 <parent-session>", async () => {
    const { agent } = makeAgent(true);
    const r = await agent.execute({
      type: "explore",
      description: "E1-fail",
      prompt: "x",
      _parentToolUseId: PARENT_TOOL_USE,
    });
    expect(r.success).toBe(false);

    const m = r.output.match(/<output-file>(.+?)<\/output-file>/);
    expect(m).not.toBeNull();
    const outputFile = m![1]!;
    expect(outputFile.startsWith(currentProjectSessionDir())).toBe(true);
    expect(outputFile.endsWith(".jsonl")).toBe(true);
    expect(r.output).toContain(`<parent-session>${PARENT}</parent-session>`);

    // 驱逐全部任务输出：sidechain 不受影响（这正是旧 tasks/*.output 在事故后找不到的原因）
    for (const t of getAllTasks()) evictTaskOutput(t.id);
    expect(existsSync(outputFile)).toBe(true);
  });
});

describe("E1：_parentToolUseId 由执行器注入、不接受模型伪造", () => {
  test("stripInternalFields 剥掉模型自带的 _parentToolUseId", () => {
    const cleaned = stripInternalFields({ prompt: "x", _parentToolUseId: "forged" }) as Record<
      string,
      unknown
    >;
    expect("_parentToolUseId" in cleaned).toBe(false);
  });

  function capturingTool(name: string) {
    const seen: any[] = [];
    return {
      seen,
      tool: {
        name: () => name,
        description: () => name,
        inputSchema: () => ({ type: "object", properties: {} }),
        readOnly: () => true,
        isConcurrencySafe: () => true,
        execute: async (input: any) => {
          seen.push(input);
          return { output: "ok" };
        },
      },
    };
  }

  test("子代理侧执行器：sub_agent 拿到真实 tool_use id（伪造值被覆盖），其它工具不注入", async () => {
    const sub = capturingTool("sub_agent");
    const other = capturingTool("read_x");
    const reg = new Registry();
    reg.register(sub.tool as any);
    reg.register(other.tool as any);
    const allowAll = { check: async () => ({ allowed: true }) } as any;
    const blocks = [
      { type: "tool_use", id: "tu-real", name: "sub_agent", input: { _parentToolUseId: "forged" } },
      { type: "tool_use", id: "tu-2", name: "read_x", input: {} },
    ] as ContentBlock[];
    await executeTools(blocks, reg, undefined, undefined, allowAll);
    expect(sub.seen[0]._parentToolUseId).toBe("tu-real");
    expect("_parentToolUseId" in other.seen[0]).toBe(false);
  });

  test("主循环执行器同样注入（源码锚点：剥离之后、仅 sub_agent）", () => {
    // 主循环 executeSingleTool 的依赖面很大，这里锁源码形态：注入必须在 stripInternalFields 之后，
    // 顺序反了就会把自己注入的值剥掉（GAP-08 记过同型的顺序约束）。
    const src = readFileSync(join(import.meta.dir, "../../src/query/tool-executor.ts"), "utf-8");
    const strip = src.indexOf("effectiveInput = stripInternalFields(validation.data);");
    const inject = src.indexOf("_parentToolUseId: block.id");
    expect(strip).toBeGreaterThan(0);
    expect(inject).toBeGreaterThan(strip);
    expect(src.slice(strip, inject)).toContain('block.name === "sub_agent"');
  });
});
