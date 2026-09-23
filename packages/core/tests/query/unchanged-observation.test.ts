/**
 * P2-20：同指纹同返回值空转检测（运行时口径）
 *
 * 缺陷：digest.ts 的 observationEntropyPathological（同指纹连续 ≥3 次同返回值）
 * 只在 /insights 离线算，query/loop.ts 零引用 —— 运行时空转 22 次也没有任何信号。
 * 本阀补运行时检测，且**只报不拦**（工具循环检测默认全关有实测背书的否决）。
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  observeToolResult,
  createUnchangedObservationState,
  observationFingerprint,
  UNCHANGED_OBSERVATION_THRESHOLD,
} from "../../src/query/unchanged-observation.ts";

const obs = (toolName: string, input: unknown, output: string) => ({ toolName, input, output });

describe("observeToolResult：连续同返回值计数", () => {
  it("同指纹同返回值达阈值时报告一次", () => {
    const st = createUnchangedObservationState();
    const r1 = observeToolResult(st, obs("web_fetch", { url: "u" }, "same"));
    const r2 = observeToolResult(st, obs("web_fetch", { url: "u" }, "same"));
    const r3 = observeToolResult(st, obs("web_fetch", { url: "u" }, "same"));
    expect([r1.run, r2.run, r3.run]).toEqual([1, 2, 3]);
    expect(r1.shouldReport).toBe(false);
    expect(r2.shouldReport).toBe(false);
    expect(r3.shouldReport).toBe(true);
    expect(r3.tool).toBe("web_fetch");
  });

  it("同一段空转只报一次（达阈值后继续重复不再刷屏）", () => {
    const st = createUnchangedObservationState();
    for (let i = 0; i < UNCHANGED_OBSERVATION_THRESHOLD; i++) {
      observeToolResult(st, obs("web_search", { q: "x" }, "same"));
    }
    const again = observeToolResult(st, obs("web_search", { q: "x" }, "same"));
    expect(again.run).toBe(UNCHANGED_OBSERVATION_THRESHOLD + 1);
    expect(again.shouldReport).toBe(false);
  });

  it("返回值变了即清零 —— 「世界在变」是有新信息，不是空转", () => {
    const st = createUnchangedObservationState();
    observeToolResult(st, obs("bash", { command: "c" }, "a"));
    observeToolResult(st, obs("bash", { command: "c" }, "a"));
    const changed = observeToolResult(st, obs("bash", { command: "c" }, "b"));
    expect(changed.run).toBe(1);
    expect(changed.shouldReport).toBe(false);
  });

  it("清零后再次卡住应当再报（那是新的一段空转，不是同一段刷屏）", () => {
    const st = createUnchangedObservationState();
    for (let i = 0; i < 3; i++) observeToolResult(st, obs("bash", { command: "c" }, "a"));
    observeToolResult(st, obs("bash", { command: "c" }, "different")); // 清零
    observeToolResult(st, obs("bash", { command: "c" }, "z"));
    observeToolResult(st, obs("bash", { command: "c" }, "z"));
    const reReport = observeToolResult(st, obs("bash", { command: "c" }, "z"));
    expect(reReport.shouldReport).toBe(true);
  });

  it("入参不同 → 不同指纹，各自独立计数（不跨指纹合并）", () => {
    const st = createUnchangedObservationState();
    observeToolResult(st, obs("grep", { pattern: "a" }, "hit"));
    observeToolResult(st, obs("grep", { pattern: "b" }, "hit"));
    const third = observeToolResult(st, obs("grep", { pattern: "a" }, "hit"));
    // pattern:a 只出现过 2 次，不该因 pattern:b 也返回 "hit" 而被算到 3
    expect(third.run).toBe(2);
    expect(third.shouldReport).toBe(false);
  });

  it("连续性在同指纹自己的子序列里算，不受其它工具穿插影响", () => {
    const st = createUnchangedObservationState();
    observeToolResult(st, obs("web_fetch", { url: "u" }, "same"));
    observeToolResult(st, obs("read", { file_path: "/f" }, "content"));
    observeToolResult(st, obs("web_fetch", { url: "u" }, "same"));
    observeToolResult(st, obs("read", { file_path: "/f" }, "content"));
    const r = observeToolResult(st, obs("web_fetch", { url: "u" }, "same"));
    expect(r.run).toBe(3);
    expect(r.shouldReport).toBe(true);
  });

  it("入参键序抖动不产生伪差异（键排序后序列化）", () => {
    expect(observationFingerprint("t", { a: 1, b: 2 })).toBe(
      observationFingerprint("t", { b: 2, a: 1 }),
    );
  });

  it("超长返回值按前 2000 字符比较（与 digest 同上界）", () => {
    const st = createUnchangedObservationState();
    const base = "X".repeat(2000);
    observeToolResult(st, obs("bash", { command: "c" }, base + "tail-1"));
    observeToolResult(st, obs("bash", { command: "c" }, base + "tail-2"));
    const r = observeToolResult(st, obs("bash", { command: "c" }, base + "tail-3"));
    // 前 2000 字符相同 → 视为同返回值（digest 侧 truncate(...,2000) 同口径）
    expect(r.run).toBe(3);
  });
});

describe("P2-20：阈值与离线 digest 同源（两套尺子会让曲线对不上）", () => {
  it("digest.ts 从本模块 import 阈值，而非自己写一个数字", () => {
    const digestSrc = readFileSync(join(import.meta.dir, "../../src/trace/digest.ts"), "utf-8");
    // 必须是 import 进来的
    expect(digestSrc).toContain(
      'import { UNCHANGED_OBSERVATION_THRESHOLD } from "../query/unchanged-observation.ts"',
    );
    // 且不得在 digest 侧重新定义（重定义就是两套尺子）
    expect(digestSrc).not.toMatch(/const\s+UNCHANGED_OBSERVATION_THRESHOLD\s*=/);
  });

  it("运行时告警不做任何干预（埋点里 intervened 恒为 false）", () => {
    const loopSrc = readFileSync(join(import.meta.dir, "../../src/query/loop.ts"), "utf-8");
    expect(loopSrc).toContain('event: "UnchangedObservationRun"');
    expect(loopSrc).toContain("intervened: false");
  });
});
