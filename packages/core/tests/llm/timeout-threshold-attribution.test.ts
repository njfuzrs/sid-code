/**
 * 超时归因的 `threshold_ms` **不得与真实触发阈值脱节**（2026-08-17）。
 *
 * ── 缺陷是怎么被发现的 ──
 *
 * 复核 PR #41（遥测零触发分诊）的落地时，逐一读三条协议线的 `onTimeout` 回调。
 * PR #41 已经把 **Responses** 路径修对了（每层报自己的阈值，见
 * `responses-stream-timeout-wiring.test.ts`），但同一处病灶在另外两条线上还活着：
 *
 * | 路径 | lifecycle 实际用的值 | 上报的 threshold_ms（修复前） |
 * | --- | --- | --- |
 * | `openai.ts` Chat Completions | overall = `streamTimeouts.overallTimeoutMs`（**可被 env 覆盖**） | 一律 `LIFECYCLE_PRESETS.mainLoop.overallTimeoutMs` |
 * | `anthropic.ts` 原生 Messages | content/overall = `anthropicStreamTimeouts.*`（**可被两个 env 覆盖**） | 三层一律读 `LIFECYCLE_PRESETS.mainLoop.*` |
 *
 * ── 为什么这是缺陷而不是风格问题 ──
 *
 * 缺陷引入时默认配置下两者恰好相等（`PROVIDER_STREAM_DEFAULTS.overallTimeoutMs === BASE * 2.0`），
 * 所以**测试全绿、日志好看、机理讲得通** —— 直到有人设了
 * `SID_CODE_ANTHROPIC_OVERALL_TIMEOUT_MS=120000`：流 120s 就断，事件里却写着
 * `threshold_ms: 600000`。排查的人拿这个从未生效过的数字去对时间线，只会得出
 * 「看着没超时却断了」的结论，转而去查网络/网关。
 * **错误归因比没有归因更坏**，这是本仓反复记的教训（见 `attribution-decoupled-from-signal`）。
 *
 * 而它恰恰只在**被覆盖时**才发作 —— 也就是运维为了排查一个线上超时问题去调阈值的那一刻，
 * 归因数据同时变成假的。这是最坏的失效时机。
 *
 * ── 本文件钉的是什么 ──
 *
 * 不钉具体数字（数字会随档位调整变化，钉了就是把当前值焊死）。钉的是**同源性**：
 * 上报的表达式必须与配进 lifecycle 的表达式取自同一个来源。
 * 所以断言写成「块里出现了那个变量名」而非「等于 600000」。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveProviderStreamTimeouts,
  PROVIDER_STREAM_DEFAULTS,
} from "@sid-code/core/config/network-profile.ts";
import { LIFECYCLE_PRESETS } from "@sid-code/core/llm/stream-lifecycle.ts";

const SRC = join(import.meta.dir, "../../src/llm");

/**
 * 读源码文本。刻意用 readFileSync 而非 grep/rg：
 * `openai.ts` 曾含 NUL 字节让 grep 静默漏报（见 `app-ts-nul-byte-breaks-grep`），
 * 而"静默漏报"对哨兵测试是最致命的失效方式 —— 它会变成一个恒绿的假门禁。
 */
function readSource(file: string): string {
  return readFileSync(join(SRC, file), "utf8");
}

/** 截出某个 `label: "X"` 所属的 createStreamLifecycle 配置块（含 label 之后的回调）。 */
function lifecycleBlock(file: string, label: string, endAnchor: string): string {
  const src = readSource(file);
  const at = src.indexOf(`label: "${label}"`);
  expect(at).toBeGreaterThan(0);
  const open = src.lastIndexOf("createStreamLifecycle", at);
  expect(open).toBeGreaterThan(0);
  const close = src.indexOf(endAnchor, at);
  expect(close).toBeGreaterThan(at);
  return src.slice(open, close);
}

describe("Anthropic 原生：三层阈值上报与 lifecycle 配置同源", () => {
  const block = () => lifecycleBlock("anthropic.ts", "ANTHROPIC", "for await");

  test("content_progress / overall 上报 anthropicStreamTimeouts，不是 preset 常量", () => {
    const b = block();
    // 配置侧（这两行是既有行为，一并锁住，防止有人改了配置忘了改上报）
    expect(b).toContain(
      "contentProgressTimeoutMs: anthropicStreamTimeouts.contentProgressTimeoutMs",
    );
    expect(b).toContain("overallTimeoutMs: anthropicStreamTimeouts.overallTimeoutMs");
    // 上报侧必须取同一个来源
    expect(b).toContain("anthropicStreamTimeouts.contentProgressTimeoutMs");
    expect(b).toContain("anthropicStreamTimeouts.overallTimeoutMs");
    // 原缺陷形态：这两层的阈值从 preset 读。
    expect(b).not.toContain("LIFECYCLE_PRESETS.mainLoop.contentProgressTimeoutMs");
    expect(b).not.toContain("LIFECYCLE_PRESETS.mainLoop.overallTimeoutMs");
  });

  test("idle 层仍报 preset（它本来就没走 env，这不是漏改）", () => {
    const b = block();
    // 这一层刻意保持 preset：`SID_CODE_IDLE_TIMEOUT_MS` 的语义是 openai 的**字节级** idle
    // （见 network-profile.ts 的 env 清单注释），拿它覆盖 anthropic 的**事件级** idle
    // 是串了两个不同层的概念。所以此处同源意味着「都读 preset」，不是「都读 env」。
    expect(b).toContain("idleTimeoutMs: LIFECYCLE_PRESETS.mainLoop.idleTimeoutMs");
    expect(b).toContain("LIFECYCLE_PRESETS.mainLoop.idleTimeoutMs");
  });
});

describe("OpenAI Chat Completions：两层阈值上报与 lifecycle 配置同源", () => {
  const block = () => lifecycleBlock("openai.ts", "OPENAI", "parseSSE(");

  test("overall 上报 streamTimeouts.overallTimeoutMs，不是 preset", () => {
    const b = block();
    expect(b).toContain("overallTimeoutMs: streamTimeouts.overallTimeoutMs");
    // 修复后：overall 分支取 streamTimeouts，idle 分支才取 preset（见下一个用例）。
    expect(b).toContain("? streamTimeouts.overallTimeoutMs");
  });

  test("idle 报 preset.overallTimeoutMs —— 因为它配的就是这个值（刻意放宽）", () => {
    const b = block();
    // 本路径的事件级 idle 被**刻意**放宽到 overall 量级，理由是 parseSSE 内有更严格的
    // 字节级 idle 先触发（对照断言见 responses-stream-timeout-wiring.test.ts）。
    // 所以这里"报 preset.overall"是正确的同源，不是漏改 —— 两者必须一起出现，
    // 若将来 idleTimeoutMs 改了档位而上报没跟着改，本用例会红。
    expect(b).toContain("idleTimeoutMs: LIFECYCLE_PRESETS.mainLoop.overallTimeoutMs");
    expect(b).toContain(": LIFECYCLE_PRESETS.mainLoop.overallTimeoutMs");
  });
});

describe("为什么默认值下看不出问题（这个缺陷的潜伏机制）", () => {
  test("解析值来自 PROVIDER_STREAM_DEFAULTS，与 preset **不再**恰好同值", () => {
    const resolved = resolveProviderStreamTimeouts({ providerKind: "anthropic" });
    // 上报必须与配进 lifecycle 的来源同源 —— 这是本文件的主张，与档位数值无关。
    expect(resolved.overallTimeoutMs).toBe(PROVIDER_STREAM_DEFAULTS.overallTimeoutMs);

    // ⚠️ 这一条曾经断言 `=== LIFECYCLE_PRESETS.mainLoop.overallTimeoutMs`，
    // 作为"为什么缺陷能潜伏"的**事实陈述**：默认档位下两个来源恰好同值，
    // 于是任何"跑一遍看数字对不对"的验证都会通过。
    //
    // PR10 之后这个巧合**没有了**：provider 层 overall 走
    // PROVIDER_STREAM_DEFAULTS（解除 300s 删失后的独立取值），而 preset 那档仍从
    // watchdogNoProgressMs 按 2.0× 派生 —— 两者不再相等。
    // 潜伏条件消失是好事（默认配置下脱节就能被看见），所以把断言翻过来钉住这个新事实：
    // 谁把两者改回同值，就等于把潜伏机制又装回来了。
    expect(resolved.overallTimeoutMs).not.toBe(LIFECYCLE_PRESETS.mainLoop.overallTimeoutMs);
  });

  test("设了 env 之后两者分叉 —— 这才是缺陷发作的条件", () => {
    const KEY = "SID_CODE_ANTHROPIC_OVERALL_TIMEOUT_MS";
    // 存/恢复原值，不无条件 delete：bun test 同批多文件跑在同一进程里，
    // 直接删会把别的用例（或 preload 兜底）依赖的值一起抹掉。
    const saved = process.env[KEY];
    try {
      process.env[KEY] = "120000";
      const resolved = resolveProviderStreamTimeouts({ providerKind: "anthropic" });
      expect(resolved.overallTimeoutMs).toBe(120_000);
      // 分叉成立：此时若上报仍读 preset，事件里就会写着一个从未生效过的 600000。
      expect(resolved.overallTimeoutMs).not.toBe(LIFECYCLE_PRESETS.mainLoop.overallTimeoutMs);
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
  });
});
