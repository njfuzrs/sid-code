/**
 * 录制回放（VCR）测试 —— 缺陷清单 P2-11
 *
 * 最重要的一组是「往返保真」：录制 → 回放 → 经**生产的** processStream 累加 →
 * 与原始录制逐字段比对。这条不过，回放器就只是个花哨的 mock：
 * 它能"跑通"，但走的是与生产不同的代码路径，测不到真正会出问题的那段逻辑。
 *
 * 用真实 raw.jsonl 片段做语料（结构按本机实际文件核验，含 request_sent 标记行、
 * 增量 new_messages、thinking + text + 多个 tool_use 混合的响应）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ProviderRegistry } from "../../src/llm/registry.ts";
import { validateConfig } from "../../src/config/schema.ts";
import type { ValidationError } from "../../src/config/schema.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReplayProvider,
  parseRawJsonl,
  blocksToStreamEvents,
  createReplayProvider,
  type ReplayTurn,
} from "../../src/llm/mocks/replay-provider.ts";
import { processStream } from "../../src/query/stream-processor.ts";
import type { SendParams, StreamEvent, ContentBlock } from "../../src/llm/types.ts";

const PARAMS: SendParams = { model: "test", messages: [], maxTokens: 1024 };

/**
 * 真实 raw.jsonl 形态的语料。
 * 刻意保留三个真实特征：① 混有 request_sent 标记行；② 首行带完整 messages/system/tools，
 * 后续行只有 new_messages + _messages_count；③ 响应含 thinking + text + tool_use 混合。
 */
const SAMPLE_RAW = [
  JSON.stringify({
    timestamp: "2026-08-05T13:51:07.880Z", index: 1, type: "request_sent",
    model: "glm-5.2", msg_count: 1, estimated_input_tokens: 27071,
  }),
  JSON.stringify({
    timestamp: "2026-08-05T13:51:20.000Z", index: 1, model: "glm-5.2",
    request: {
      model: "glm-5.2",
      system: "你是 sid-code",
      messages: [{ role: "user", content: [{ type: "text", text: "帮我看个 bug" }] }],
      tools: [{ name: "read", description: "读文件", input_schema: {} }],
    },
    response: {
      content: [
        { type: "thinking", thinking: "先读一下文件", signature: "sig-abc" },
        { type: "text", text: "我来看看这个文件" },
        { type: "tool_use", id: "toolu_1", name: "read", input: { file_path: "/a/b.ts", offset: 10 } },
      ],
      stop_reason: "tool_use",
    },
    usage: { input_tokens: 32643, output_tokens: 260, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    stop_reason: "tool_use", is_partial: false,
  }),
  JSON.stringify({
    timestamp: "2026-08-05T13:51:30.000Z", index: 2, type: "request_sent",
    model: "glm-5.2", msg_count: 3,
  }),
  JSON.stringify({
    timestamp: "2026-08-05T13:51:40.000Z", index: 2, model: "glm-5.2",
    request: { model: "glm-5.2", _messages_count: 3, new_messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "文件内容" }] }] },
    response: {
      content: [{ type: "text", text: "找到了，是第 12 行的空指针" }],
      stop_reason: "end_turn",
    },
    usage: { input_tokens: 32718, output_tokens: 196, cache_read_input_tokens: 28544, cache_creation_input_tokens: 0 },
    stop_reason: "end_turn", is_partial: false,
  }),
].join("\n");

/** 收集一次回放的全部事件 */
async function collect(p: ReplayProvider): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of p.sendMessageStream(PARAMS)) out.push(ev);
  return out;
}

// ============================================================
// 解析
// ============================================================
describe("VCR · raw.jsonl 解析", () => {
  test("只取完整 pair，跳过 request_sent 标记行", () => {
    const turns = parseRawJsonl(SAMPLE_RAW);
    // 4 行里有 2 行是 request_sent 标记
    expect(turns).toHaveLength(2);
    expect(turns[0]!.index).toBe(1);
    expect(turns[1]!.index).toBe(2);
  });

  test("响应内容与 stop_reason / usage 全部解析出来", () => {
    const [t1] = parseRawJsonl(SAMPLE_RAW);
    expect(t1!.content).toHaveLength(3);
    expect(t1!.stopReason).toBe("tool_use");
    expect(t1!.usage.inputTokens).toBe(32643);
    expect(t1!.usage.outputTokens).toBe(260);
    expect(t1!.model).toBe("glm-5.2");
  });

  test("cache token 字段解析（省钱指标要用）", () => {
    const turns = parseRawJsonl(SAMPLE_RAW);
    expect(turns[1]!.usage.cacheReadInputTokens).toBe(28544);
  });

  test("坏行跳过而非整体失败——崩溃会话末行常是半条 JSON", () => {
    // 这是刻意的容错：因为一行残缺就无法回放，等于把最需要复现的
    // 「进程被 kill 的会话」排除在回放能力之外。
    const withGarbage = SAMPLE_RAW + '\n{"index":3,"response":{"content":[{"type":"tex';
    const turns = parseRawJsonl(withGarbage);
    expect(turns).toHaveLength(2); // 前两轮照常可用
  });

  test("空文本 / 纯空行返回空数组，不抛", () => {
    expect(parseRawJsonl("")).toHaveLength(0);
    expect(parseRawJsonl("\n\n  \n")).toHaveLength(0);
  });

  test("无 response 或 response.content 非数组的行被跳过", () => {
    const lines = [
      JSON.stringify({ index: 1, response: null }),
      JSON.stringify({ index: 2, response: { content: "不是数组" } }),
      JSON.stringify({ index: 3 }),
    ].join("\n");
    expect(parseRawJsonl(lines)).toHaveLength(0);
  });

  test("按 index 排序——resume 续接的会话行序可能与 index 不一致", () => {
    const lines = [
      JSON.stringify({ index: 3, response: { content: [{ type: "text", text: "c" }], stop_reason: "end_turn" } }),
      JSON.stringify({ index: 1, response: { content: [{ type: "text", text: "a" }], stop_reason: "end_turn" } }),
      JSON.stringify({ index: 2, response: { content: [{ type: "text", text: "b" }], stop_reason: "end_turn" } }),
    ].join("\n");
    expect(parseRawJsonl(lines).map((t) => t.index)).toEqual([1, 2, 3]);
  });
});

// ============================================================
// 事件序列保真
// ============================================================
describe("VCR · 事件序列保真", () => {
  test("逐块发 start/delta/stop，不是一次性塞一个事件", async () => {
    // 关键：下游的累加器、index→position 映射、thinking 计时全靠这个序列驱动。
    // 一次性塞进去虽然能"跑通"，但走的是与生产不同的路径，回归测试就失去意义。
    const p = ReplayProvider.fromRawJsonl(SAMPLE_RAW);
    const events = await collect(p);
    const types = events.map((e) => e.type);

    expect(types[0]).toBe("message_start");
    expect(types[types.length - 2]).toBe("message_delta");
    expect(types[types.length - 1]).toBe("message_stop");
    // 3 个块 × (start + delta + stop) = 9
    expect(types.filter((t) => t === "content_block_start")).toHaveLength(3);
    expect(types.filter((t) => t === "content_block_stop")).toHaveLength(3);
  });

  test("tool_use 的 input 走 input_json_delta 分片路径", async () => {
    // 真实事故（input={} + 未到达的 content_block_stop）只在这条路径上才测得到。
    // 若回放直接把 input 塞进 content_block_start，那类 bug 永远复现不出来。
    const p = ReplayProvider.fromRawJsonl(SAMPLE_RAW);
    const events = await collect(p);

    const toolStart = events.find(
      (e) => e.type === "content_block_start" && (e as any).content_block?.type === "tool_use",
    ) as any;
    expect(toolStart.content_block.input).toEqual({}); // start 时是空的
    expect(toolStart.content_block.name).toBe("read");

    const jsonDelta = events.find(
      (e) => e.type === "content_block_delta" && (e as any).delta?.type === "input_json_delta",
    ) as any;
    expect(jsonDelta).toBeDefined();
    expect(JSON.parse(jsonDelta.delta.partial_json)).toEqual({ file_path: "/a/b.ts", offset: 10 });
  });

  test("thinking 块带 signature（丢了会让多轮回传 400）", async () => {
    const p = ReplayProvider.fromRawJsonl(SAMPLE_RAW);
    const events = await collect(p);
    const thinkingStart = events.find(
      (e) => e.type === "content_block_start" && (e as any).content_block?.type === "thinking",
    ) as any;
    expect(thinkingStart.content_block.signature).toBe("sig-abc");
  });

  test("未知块类型原样透传，不静默丢弃", () => {
    // 本仓库已记录的教训：手写字段列表 / 手写分派链会静默丢块。
    const blocks = [{ type: "future_block_type", payload: "x" }] as unknown as ContentBlock[];
    const events = [...blocksToStreamEvents(blocks, "end_turn", { inputTokens: 1, outputTokens: 1 })];
    const start = events.find((e) => e.type === "content_block_start") as any;
    expect(start.content_block.type).toBe("future_block_type");
    expect(events.filter((e) => e.type === "content_block_stop")).toHaveLength(1);
  });

  test("usage 透传到 message_delta", async () => {
    const p = ReplayProvider.fromRawJsonl(SAMPLE_RAW);
    const events = await collect(p);
    const delta = events.find((e) => e.type === "message_delta") as any;
    expect(delta.usage.inputTokens).toBe(32643);
    expect(delta.delta.stop_reason).toBe("tool_use");
  });

  test("空 content 的响应也产出合法事件序列（不产生半截流）", () => {
    const events = [...blocksToStreamEvents([], "end_turn", { inputTokens: 0, outputTokens: 0 })];
    expect(events.map((e) => e.type)).toEqual(["message_start", "message_delta", "message_stop"]);
  });
});

// ============================================================
// 往返保真（本文件最重要的一组）
// ============================================================
describe("VCR · 往返保真（经生产 processStream）", () => {
  test("录制 → 回放 → processStream 累加，与原始录制逐字段相等", async () => {
    const turns = parseRawJsonl(SAMPLE_RAW);
    const p = new ReplayProvider(turns);

    for (const orig of turns) {
      const got = await processStream(p.sendMessageStream(PARAMS));

      expect(got.content.map((b: any) => b.type)).toEqual(orig.content.map((b: any) => b.type));
      expect(got.stopReason).toBe(orig.stopReason);

      for (let i = 0; i < orig.content.length; i++) {
        const ob = orig.content[i] as any;
        const gb = got.content[i] as any;
        if (ob.type === "text") expect(gb.text).toBe(ob.text);
        if (ob.type === "thinking") expect(gb.thinking).toBe(ob.thinking);
        if (ob.type === "tool_use") {
          expect(gb.name).toBe(ob.name);
          expect(gb.input).toEqual(ob.input); // 分片重组后必须逐字段相等
        }
      }
    }
  });

  test("tool_use 的 input 经分片重组后不丢字段、不改类型", async () => {
    const turns: ReplayTurn[] = [{
      index: 1, model: "m", stopReason: "tool_use", isPartial: false,
      usage: { inputTokens: 1, outputTokens: 1 },
      content: [{
        type: "tool_use", id: "t1", name: "edit",
        // 刻意混入嵌套对象、数组、数字、布尔、含引号与换行的字符串
        input: {
          file_path: "/a.ts", line: 42, dry_run: false,
          replacements: [{ old: 'say "hi"', new: "line1\nline2" }],
          nested: { deep: { deeper: [1, 2, 3] } },
        },
      }] as ContentBlock[],
    }];
    const p = new ReplayProvider(turns);
    const got = await processStream(p.sendMessageStream(PARAMS));
    const origInput = (turns[0]!.content[0] as any).input;
    expect((got.content[0] as any).input).toEqual(origInput);
    // 类型也不许漂：数字别变字符串、布尔别变字符串
    expect(typeof (got.content[0] as any).input.line).toBe("number");
    expect(typeof (got.content[0] as any).input.dry_run).toBe("boolean");
  });
});

// ============================================================
// 轮次控制
// ============================================================
describe("VCR · 轮次控制", () => {
  test("按顺序逐轮回放", async () => {
    const p = ReplayProvider.fromRawJsonl(SAMPLE_RAW);
    const r1 = await processStream(p.sendMessageStream(PARAMS));
    const r2 = await processStream(p.sendMessageStream(PARAMS));
    expect(r1.stopReason).toBe("tool_use");
    expect(r2.stopReason).toBe("end_turn");
    expect(p.getReplayedCount()).toBe(2);
  });

  test("默认耗尽即抛——静默补空响应会把「多跑一轮」的回归伪装成通过", async () => {
    const p = ReplayProvider.fromRawJsonl(SAMPLE_RAW);
    await collect(p);
    await collect(p);
    await expect(collect(p)).rejects.toThrow(/录制已耗尽/);
  });

  test('onExhausted: "end-turn" 让主循环自然收尾', async () => {
    const p = ReplayProvider.fromRawJsonl(SAMPLE_RAW, { onExhausted: "end-turn" });
    await collect(p);
    await collect(p);
    const extra = await processStream(p.sendMessageStream(PARAMS));
    expect(extra.stopReason).toBe("end_turn");
    expect(extra.content).toHaveLength(0);
  });

  test('onExhausted: "repeat-last" 重复最后一轮', async () => {
    const p = ReplayProvider.fromRawJsonl(SAMPLE_RAW, { onExhausted: "repeat-last" });
    await collect(p);
    await collect(p);
    const again = await processStream(p.sendMessageStream(PARAMS));
    expect(again.stopReason).toBe("end_turn");
    expect((again.content[0] as any).text).toBe("找到了，是第 12 行的空指针");
  });

  test("空录制 + repeat-last 给出可读错误而非 undefined 崩溃", async () => {
    const p = new ReplayProvider([], { onExhausted: "repeat-last" });
    await expect(collect(p)).rejects.toThrow(/录制为空/);
  });

  test("reset 后可重复用同一份录制", async () => {
    const p = ReplayProvider.fromRawJsonl(SAMPLE_RAW);
    await collect(p);
    await collect(p);
    p.reset();
    expect(p.getReplayedCount()).toBe(0);
    const r1 = await processStream(p.sendMessageStream(PARAMS));
    expect(r1.stopReason).toBe("tool_use");
  });

  test("记录主循环实际发出的请求，供用例断言「发了什么」", async () => {
    const p = ReplayProvider.fromRawJsonl(SAMPLE_RAW);
    await collect(p);
    expect(p.getReceivedParams()).toHaveLength(1);
    expect(p.getReceivedParams()[0]!.model).toBe("test");
  });
});

// ============================================================
// Provider 契约与 abort
// ============================================================
describe("VCR · Provider 契约", () => {
  test("满足 Provider 接口，可当普通 provider 用", () => {
    const p = createReplayProvider(parseRawJsonl(SAMPLE_RAW));
    expect(typeof p.name()).toBe("string");
    expect(typeof p.sendMessageStream).toBe("function");
    expect(p.capabilities!().streaming).toBe(true);
    // 录制里可能真的有 thinking 块，必须声明支持否则被上游能力过滤掉
    expect(p.capabilities!().thinking).toBe(true);
  });

  test("已中断的 signal 立即抛——回放也要能测「用户 ESC」路径", async () => {
    const p = ReplayProvider.fromRawJsonl(SAMPLE_RAW);
    const ac = new AbortController();
    ac.abort(new Error("用户中断"));
    const it = p.sendMessageStream(PARAMS, ac.signal)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow("用户中断");
  });

  test("流中途 abort 会中断回放（不是把剩余事件发完）", async () => {
    const p = ReplayProvider.fromRawJsonl(SAMPLE_RAW);
    const ac = new AbortController();
    let count = 0;
    await expect((async () => {
      for await (const _ev of p.sendMessageStream(PARAMS, ac.signal)) {
        count++;
        if (count === 2) ac.abort(new Error("中途取消"));
      }
    })()).rejects.toThrow("中途取消");
    expect(count).toBeLessThan(11); // 远少于完整的 11 个事件
  });

  test("getTotalTurns / getReplayedCount 反映真实进度", () => {
    const p = ReplayProvider.fromRawJsonl(SAMPLE_RAW);
    expect(p.getTotalTurns()).toBe(2);
    expect(p.getReplayedCount()).toBe(0);
  });
});

// ============================================================
// 接线：能从 registry 走通（防退化成「只能在单测里 new」的死资产）
// ============================================================
describe("VCR · 经 ProviderRegistry 接线", () => {
  const ENV_FILE = "SID_CODE_REPLAY_FILE";
  const ENV_EXHAUSTED = "SID_CODE_REPLAY_ON_EXHAUSTED";
  let savedFile: string | undefined;
  let savedExhausted: string | undefined;
  let tmpRaw = "";

  beforeEach(() => {
    savedFile = process.env[ENV_FILE];
    savedExhausted = process.env[ENV_EXHAUSTED];
    tmpRaw = join(mkdtempSync(join(tmpdir(), "sidcode-replay-")), "raw.jsonl");
    writeFileSync(tmpRaw, SAMPLE_RAW, "utf-8");
  });

  afterEach(() => {
    if (savedFile === undefined) delete process.env[ENV_FILE];
    else process.env[ENV_FILE] = savedFile;
    if (savedExhausted === undefined) delete process.env[ENV_EXHAUSTED];
    else process.env[ENV_EXHAUSTED] = savedExhausted;
  });

  function registry() {
    return new ProviderRegistry({
      provider: "replay", model: "m", anthropicKey: "", openaiKey: "",
    } as any);
  }

  test("provider=replay + SID_CODE_REPLAY_FILE 能拿到可回放 provider", async () => {
    // 这条是「配了能到达」——本清单 P0-3 的复盘写明，那个缺陷能活下来的唯一原因
    // 就是没有任何测试断言这件事。
    process.env[ENV_FILE] = tmpRaw;
    const p = registry().getProvider();
    expect(p.name()).toBe("replay");

    const got = await processStream(p.sendMessageStream(PARAMS));
    expect(got.stopReason).toBe("tool_use");
    expect((got.content[1] as any).text).toBe("我来看看这个文件");
  });

  test("未配 SID_CODE_REPLAY_FILE 时给出可操作的错误信息", () => {
    delete process.env[ENV_FILE];
    expect(() => registry().getProvider()).toThrow(/SID_CODE_REPLAY_FILE/);
  });

  test("从 CLI 走时默认 end-turn，录制放完自然收尾而非抛错", async () => {
    process.env[ENV_FILE] = tmpRaw;
    const p = registry().getProvider();
    await processStream(p.sendMessageStream(PARAMS));
    await processStream(p.sendMessageStream(PARAMS));
    // 第 3 轮：录制已耗尽，应自然收尾
    const extra = await processStream(p.sendMessageStream(PARAMS));
    expect(extra.stopReason).toBe("end_turn");
  });

  test("SID_CODE_REPLAY_ON_EXHAUSTED 可覆盖耗尽行为", async () => {
    process.env[ENV_FILE] = tmpRaw;
    process.env[ENV_EXHAUSTED] = "throw";
    const p = registry().getProvider();
    await processStream(p.sendMessageStream(PARAMS));
    await processStream(p.sendMessageStream(PARAMS));
    await expect(
      processStream(p.sendMessageStream(PARAMS)),
    ).rejects.toThrow(/录制已耗尽/);
  });

  test("fromFileSync 与 fromFile 解析结果一致", async () => {
    const sync = ReplayProvider.fromFileSync(tmpRaw);
    const async_ = await ReplayProvider.fromFile(tmpRaw);
    expect(sync.getTotalTurns()).toBe(async_.getTotalTurns());
    expect(sync.getTotalTurns()).toBe(2);
  });

  test("配置校验层必须放行 provider=replay（registry 认了不算，schema 也得认）", () => {
    // 这条是本批修复现场踩出来的坑，值得单独一个测试钉住：
    // registry 里接好了、31 个单测全绿，但跑真实 CLI 直接
    // 「配置验证失败：无效值 "replay"」——因为上面那些测试都是自己 new
    // ProviderRegistry，**绕过了配置校验层**。schema 不放开，registry 的分支
    // 永远走不到，与本清单 P0-3（写完但配置层不可达）是同一个形态。
    const result = validateConfig({
      provider: "replay",
      model: "replay-model",
      availableModels: [{ name: "replay-model", provider: "replay", api_key: "none" }],
    } as any);
    const fatal = result.errors.filter(
      (e: ValidationError) => e.path === "provider" || e.path === "model",
    );
    expect(fatal).toHaveLength(0);
  });
});
