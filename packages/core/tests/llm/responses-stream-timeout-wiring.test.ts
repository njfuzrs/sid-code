/**
 * OpenAI **Responses** 路径的流超时接线回归（2026-08-16，遥测零触发分诊产出）。
 *
 * 缺陷怎么被发现的：分诊「15 类遥测事件里 12 类零触发」时，把 events.jsonl 的
 * `TimeoutFired` 全部翻出来，8 条**全部**是 `fallback_stream_timeout`，
 * lifecycle 三层（idle / content_progress / overall）一次没触发过。
 * 静态看每层代码都在、单测全绿 —— 断点在层与层之间的**阈值配比**上。
 *
 * 根因：Chat Completions 路径把事件级 idle 放宽到 overall 同量级、且不启用
 * content progress 层，这是**有前提**的——它的解析器 `parseSSE` 内有一套更严格的
 * **字节级** idle/content 超时先触发。而 Responses 路径照抄了这套放宽，
 * 但它的解析器 `parseResponsesStream` → `readSSEEvents` 里**一个定时器都没有**。
 * 于是字节级防线不存在、事件级又被主动调宽，两层同时失守。
 *
 * 本文件钉住的不是某个数字，而是那条**因果链**：
 *   「解析器无字节级定时器」⇒「事件级 idle/content 必须按真实档位启用」。
 * 前提变了（比如将来给 readSSEEvents 加了字节级超时）测试会提示重新评估，
 * 而不是默默放过 —— 这正是原缺陷能潜伏的方式。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createStreamLifecycle } from "@sid-code/core/llm/stream-lifecycle.ts";
import { isResponsesContentProgress } from "@sid-code/core/llm/openai-responses.ts";
import type { StreamEvent, StreamTelemetrySignal } from "@sid-code/core/llm/types.ts";

const SRC = join(import.meta.dir, "../../src/llm");

/** 读源码文本。注意用 readFileSync 而非 grep：openai.ts 曾含 NUL 字节让 grep 静默漏报。 */
function readSource(file: string): string {
  return readFileSync(join(SRC, file), "utf8");
}

describe("Responses 路径：前提——解析器没有字节级超时", () => {
  test("parseResponsesStream / readSSEEvents 全文零定时器", () => {
    const src = readSource("openai-responses.ts");
    // 这是上面那条因果链的**前提**。它若不再成立（有人补了字节级看门狗），
    // 下面「事件级必须启用」的结论就该重新评估，而不是照旧。
    expect(src).not.toMatch(/setTimeout|setInterval/);
  });

  test("对照：Chat Completions 的 parseSSE 确实有字节级超时（放宽事件级的依据）", () => {
    const src = readSource("openai.ts");
    // 若这条断言红了，说明 openai.ts 的字节级防线被移走 —— 那么 Chat Completions
    // 路径把事件级 idle 放宽到 overall 的做法也失去依据，必须一起改。
    expect(src).toContain("IDLE_TIMEOUT_MS");
    expect(src).toContain("CONTENT_PROGRESS_TIMEOUT_MS");
  });
});

describe("Responses 路径：结论——事件级 idle/content 按真实档位启用", () => {
  /**
   * 截出 OPENAI-RESPONSES 那个 createStreamLifecycle 配置块（含 label 之后的回调部分）。
   *
   * 用 `label:` 定位、向前找构造调用、向后取到消费循环为止：配置项散在 label 前后两侧
   * （阈值在前、onTimeout/isContentProgress 在后），只取一侧会漏掉一半断言目标。
   */
  function responsesLifecycleBlock(): string {
    const src = readSource("openai.ts");
    const label = src.indexOf('label: "OPENAI-RESPONSES"');
    expect(label).toBeGreaterThan(0);
    const open = src.lastIndexOf("createStreamLifecycle", label);
    expect(open).toBeGreaterThan(0);
    const close = src.indexOf("parseResponsesStream(response.body", label);
    expect(close).toBeGreaterThan(label);
    return src.slice(open, close);
  }

  test("idleTimeoutMs 取 idle 档，不是 overall 档", () => {
    const block = responsesLifecycleBlock();
    expect(block).toContain("idleTimeoutMs: streamTimeouts.idleTimeoutMs");
    // 原缺陷形态：idleTimeoutMs 被赋成 overall（600s）→ idle 层实际永不先触发。
    expect(block).not.toContain("idleTimeoutMs: LIFECYCLE_PRESETS.mainLoop.overallTimeoutMs");
  });

  test("contentProgressTimeoutMs 已传（否则 content progress 层整层空转）", () => {
    const block = responsesLifecycleBlock();
    // stream-lifecycle 的 contentProgressEnabled 要求**阈值 + 判定函数**同时传；
    // 原代码只传了 isContentProgress，判定函数因此是死代码。
    expect(block).toContain("contentProgressTimeoutMs: streamTimeouts.contentProgressTimeoutMs");
    // 判定函数必须用 openai-responses.ts 的唯一导出，不能就地手写第二份：
    // 手写那份把 content_block_start 也算进展，而 Responses 流每开一个块都发一次，
    // 反复开块不产 delta 的流会被它一直续命 —— 恰好绕过本层。
    expect(block).toContain("isContentProgress: isResponsesContentProgress");
    expect(block).not.toMatch(/isContentProgress:\s*\(ev\)\s*=>/);
  });

  test("三层超时各自上报自己的 layer 与阈值（不再压成 idle_timeout + overall 阈值）", () => {
    const src = readSource("openai.ts");
    const label = src.indexOf('label: "OPENAI-RESPONSES"');
    const block = src.slice(label, label + 2000);
    expect(block).toContain("content_progress_timeout");
    expect(block).toContain("turn_hard_timeout");
    // 原缺陷：threshold_ms 一律报 overall 的 600s，与真实触发阈值不符 →
    // 错误归因比没有归因更坏（分不清"彻底静默"与"只有心跳无内容"）。
    expect(block).toContain("streamTimeouts.contentProgressTimeoutMs");
    expect(block).toContain("streamTimeouts.idleTimeoutMs");
  });
});

describe("Responses 路径：行为——只有心跳无内容时 content progress 层真的触发", () => {
  test("持续产出非进展事件（content_block_start）不能续命 content progress 层", async () => {
    // 这是上面静态断言的行为侧证明：用 Responses 自己的判定函数
    // （isResponsesContentProgress，只认 content_block_delta）驱动 lifecycle，
    // 喂一条"只有结构事件、没有真内容"的流 —— 必须超时并发出遥测。
    const signals: StreamTelemetrySignal[] = [];
    const lifecycle = createStreamLifecycle<StreamEvent>({
      idleTimeoutMs: 10_000, // 放宽：让 content progress 层先触发，隔离被测层
      contentProgressTimeoutMs: 60,
      overallTimeoutMs: 10_000,
      stallWarnMs: 10_000,
      label: "TEST-RESPONSES",
      isContentProgress: isResponsesContentProgress,
      onTelemetry: (sig) => signals.push(sig),
    });

    async function* keepAliveOnly(): AsyncGenerator<StreamEvent> {
      // 每 20ms 一个结构事件：idle 层会被不断续命（这正是"只有 ping"的形态），
      // 只有 content progress 层能识破它。
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 20));
        yield {
          type: "content_block_start",
          index: i,
          content_block: { type: "text", text: "" },
        } satisfies StreamEvent;
      }
    }

    const seen: StreamEvent[] = [];
    for await (const ev of lifecycle.guard(keepAliveOnly())) seen.push(ev);

    const snapshot = lifecycle.getSnapshot();
    expect(snapshot.timedOut).toBe(true);
    expect(snapshot.timeoutLayer).toBe("content_progress");
    // 遥测必须落地：能力生效但不可观测，等于回到本次分诊要解决的那个状态。
    expect(signals.map((s) => s.type)).toContain("stream_content_progress_timeout");
    // 流被中断，不是读到自然结束（20 个事件全收完就说明超时没生效）。
    expect(seen.length).toBeLessThan(20);
  });

  test("真内容（content_block_delta）持续到达时不误杀", async () => {
    const signals: StreamTelemetrySignal[] = [];
    const lifecycle = createStreamLifecycle<StreamEvent>({
      idleTimeoutMs: 10_000,
      contentProgressTimeoutMs: 200,
      overallTimeoutMs: 10_000,
      stallWarnMs: 10_000,
      label: "TEST-RESPONSES",
      isContentProgress: isResponsesContentProgress,
      onTelemetry: (sig) => signals.push(sig),
    });

    async function* realContent(): AsyncGenerator<StreamEvent> {
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 20));
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "x" },
        } satisfies StreamEvent;
      }
    }

    const seen: StreamEvent[] = [];
    for await (const ev of lifecycle.guard(realContent())) seen.push(ev);

    // 6 个事件全部收到、未超时 —— 证明这层不会把正常慢流误杀（误杀比漏杀更伤用户）。
    expect(seen.length).toBe(6);
    expect(lifecycle.getSnapshot().timedOut).toBe(false);
    expect(signals.map((s) => s.type)).not.toContain("stream_content_progress_timeout");
  });
});
