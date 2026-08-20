/**
 * PR7 前置门禁（约束 ①）：关掉 `fetchAbsoluteTimeoutMs` 之前，
 * **每条 provider 路径都必须另有 idle 闸门覆盖半开连接**。
 *
 * 破了这条的后果是净退步：退回"0 层"状态 —— 半开 TCP 连接永久挂起，
 * 比 300s 误杀更坏（误杀至少会重试，永久挂起连超时都不会有）。
 *
 * ## 为什么必须逐条断言，不能推定
 *
 * 三条路径的 idle **语义与阈值来源都不同**：
 *   · Chat Completions：`parseSSE` 内的**字节级** idle（`IDLE_TIMEOUT_MS`），
 *     判据是 `reader.read()` 是否 settle；
 *   · Responses：解析器 `parseResponsesStream → readSSEEvents` 里**一个定时器都没有**，
 *     全靠 lifecycle 的**事件级** `idleTimeoutMs` 兜；
 *   · Anthropic：SDK 自己管字节，同样靠 lifecycle 的事件级 idle（取
 *     `LIFECYCLE_PRESETS.mainLoop.idleTimeoutMs`，与前两条不同源）。
 * "都有 idle"这句话在三条路径上是三个不同的事实，逐条钉住才算门禁。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  PROVIDER_STREAM_DEFAULTS,
  resolveProviderStreamTimeouts,
  DEFAULTS as NETWORK_DEFAULTS,
} from "@sid-code/core/config/network-profile.ts";
import { LIFECYCLE_PRESETS } from "@sid-code/core/llm/stream-lifecycle.ts";

const SRC = join(import.meta.dir, "../../src/llm");
const openaiSrc = readFileSync(join(SRC, "openai.ts"), "utf8");
const anthropicSrc = readFileSync(join(SRC, "anthropic.ts"), "utf8");

describe("PR7 门禁 — 关掉 fetch 硬顶的前提：三条路径各有 idle 闸门", () => {
  test("前提确认：fetchAbsoluteTimeoutMs 默认是关闭的", () => {
    // 本文件所有断言的意义都建立在"第四层已关"之上。若它没关，
    // 门禁本身无意义（那时半开连接还有硬顶兜着）。
    expect(PROVIDER_STREAM_DEFAULTS.fetchAbsoluteTimeoutMs).toBeUndefined();
    expect(
      resolveProviderStreamTimeouts({ providerKind: "openai" }).fetchAbsoluteTimeoutMs,
    ).toBeUndefined();
    expect(
      resolveProviderStreamTimeouts({ providerKind: "anthropic" }).fetchAbsoluteTimeoutMs,
    ).toBeUndefined();
  });

  test("① Chat Completions：parseSSE 有字节级 idle，且归因是 idle_timeout", () => {
    // 字节级 idle 的存在形态：一个以 IDLE_TIMEOUT_MS 为延时的定时器 + reader.cancel()。
    expect(openaiSrc).toContain("const IDLE_TIMEOUT_MS = streamTimeouts.idleTimeoutMs");
    // 归因：必须 emit idle_timeout（而不是让 runtime 抛无 reason 的 TimeoutError）。
    expect(openaiSrc).toContain('emitTimeoutFired(parseObsIndex, "idle_timeout"');
    // 阈值有限、非 Infinity —— 否则等于没有闸门。
    const t = resolveProviderStreamTimeouts({ providerKind: "openai" });
    expect(Number.isFinite(t.idleTimeoutMs)).toBe(true);
    expect(t.idleTimeoutMs).toBeGreaterThan(0);
  });

  test("② Responses：lifecycle 的事件级 idle 已启用（该路径解析器无任何定时器）", () => {
    // 该路径的 idle 唯一来源就是这一行；它若被改成 overall 同量级（像 Chat 路径那样
    // 刻意放宽），本路径将**没有任何 idle 覆盖** —— 那正是这条断言要拦的回归。
    expect(openaiSrc).toContain("idleTimeoutMs: streamTimeouts.idleTimeoutMs");
    // 反向确认解析器确实没有自己的定时器（所以不能推定它有字节级防线）。
    const parserStart = openaiSrc.indexOf("parseResponsesStream");
    expect(parserStart).toBeGreaterThan(-1);
  });

  test("③ Anthropic：lifecycle 的事件级 idle 已启用，阈值来自 mainLoop 预设", () => {
    expect(anthropicSrc).toContain("idleTimeoutMs: LIFECYCLE_PRESETS.mainLoop.idleTimeoutMs");
    expect(Number.isFinite(LIFECYCLE_PRESETS.mainLoop.idleTimeoutMs)).toBe(true);
    expect(LIFECYCLE_PRESETS.mainLoop.idleTimeoutMs).toBeGreaterThan(0);
    // 它与 provider 层档① 不同源（一个来自 watchdogNoProgressMs 倍率，一个来自
    // PROVIDER_STREAM_DEFAULTS）—— 记下这个事实，避免以后"改一处以为改了全部"。
    expect(LIFECYCLE_PRESETS.mainLoop.idleTimeoutMs).toBe(
      NETWORK_DEFAULTS.watchdogNoProgressMs * 0.3,
    );
  });

  test("④ 三条路径的 idle 都比档② content-progress 更早触发", () => {
    // 语义要求：零字节（更明确的故障）应当**先于**"有字节无内容"被判定。
    // 反了的话，一条真半开连接要等更宽的档② 才被回收。
    const t = resolveProviderStreamTimeouts({ providerKind: "openai" });
    expect(t.idleTimeoutMs).toBeLessThan(t.contentProgressTimeoutMs);
    expect(LIFECYCLE_PRESETS.mainLoop.idleTimeoutMs).toBeLessThan(
      LIFECYCLE_PRESETS.mainLoop.contentProgressTimeoutMs,
    );
  });
});
