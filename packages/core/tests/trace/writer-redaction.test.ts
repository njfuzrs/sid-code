/**
 * 轨迹落盘脱敏测试（SEC-AUDIT-2026-07-19 P2）
 *
 * 轨迹是本仓核心资产：会被 /trace 读、被 uploader 上传、被贴进 issue/PR。
 * 而它记录的恰好是完整请求/响应对（含 Authorization 头、模型吐出的 key）。
 * 契约：**所有**落盘内容都经 maskSensitiveData，且脱敏后仍是合法 JSON。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TraceWriter } from "@sid-code/core/trace/writer.ts";

const BASE_DIR = join("/tmp", `sid-trace-redact-${process.pid}`);
const OPENAI_KEY = "sk-abcdefghij0123456789xyz";
const BEARER = "Bearer abcdefghijklmnopqrstuvwxyz0123";

let writer: TraceWriter;
let sessionDir: string;

beforeEach(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
  writer = new TraceWriter(BASE_DIR, "test-session");
  sessionDir = writer.getSessionDir();
});

afterEach(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});

/** 读落盘文件，断言"无明文凭证 + 有掩码 + 仍可 JSON.parse"。 */
function expectRedacted(fileName: string, plaintext: string, isJsonl = false): string {
  const p = join(sessionDir, fileName);
  expect(existsSync(p)).toBe(true);
  const txt = readFileSync(p, "utf-8");

  // 核心断言：明文凭证不在落盘内容里
  expect(txt).not.toContain(plaintext);
  expect(txt).toContain("****");

  // 脱敏只产生 `*`，不能破坏 JSON 转义 —— 否则 /trace、jq、uploader 全部读不了
  const parsed = isJsonl ? JSON.parse(txt.trim().split("\n")[0]!) : JSON.parse(txt);
  expect(parsed).toBeDefined();
  return txt;
}

describe("TraceWriter 落盘脱敏", () => {
  test("raw.jsonl 脱敏 Authorization 头与响应里的 key", () => {
    writer.appendRaw({
      timestamp: "2026-08-07T00:00:00Z",
      index: 1,
      model: "test-model",
      request: { model: "test-model", headers: { authorization: BEARER } } as any,
      response: { note: `the key is ${OPENAI_KEY}` } as any,
    } as any);

    const txt = expectRedacted("raw.jsonl", OPENAI_KEY, true);
    expect(txt).not.toContain(BEARER);
  });

  test("messages.json 脱敏消息内容里的凭证", () => {
    writer.writeMessagesSnapshot({
      messages: [{ role: "user", content: `我的 key 是 ${OPENAI_KEY}` }],
    });
    expectRedacted("messages.json", OPENAI_KEY);
  });

  test("session-summary.json 脱敏", () => {
    writer.writeSessionSummary({ note: OPENAI_KEY, errors: 0 });
    expectRedacted("session-summary.json", OPENAI_KEY);
  });

  test("events.jsonl 脱敏", () => {
    writer.appendEvent({
      event: "PreToolUse",
      session_id: "s",
      timestamp: "2026-08-07T00:00:00Z",
      data: { leaked: OPENAI_KEY },
    });
    expectRedacted("events.jsonl", OPENAI_KEY, true);
  });

  test("session.traj 脱敏", async () => {
    await writer.writeTraj({ trajectory: [{ text: OPENAI_KEY }] });
    expectRedacted("session.traj", OPENAI_KEY);
  });

  test("无凭证的普通内容不被改动", () => {
    const clean = { messages: [{ role: "user", content: "帮我改一下 src/app.ts" }] };
    writer.writeMessagesSnapshot(clean);
    const txt = readFileSync(join(sessionDir, "messages.json"), "utf-8");
    expect(JSON.parse(txt)).toEqual(clean);
    // 没有凭证就不该出现掩码痕迹
    expect(txt).not.toContain("****");
  });

  test("errors.jsonl 也脱敏（此前是唯一漏网的落盘路径）", () => {
    writer.appendError({
      kind: "api_error",
      message: `request failed with header authorization: ${BEARER}`,
    });
    const txt = expectRedacted("errors.jsonl", BEARER, true);
    expect(txt).not.toContain(BEARER);
  });
});

/**
 * 回归：脱敏曾把 cost 小数改成 `0.4428********0257`，使整份 session.traj 无法
 * JSON.parse，`/trace` 与 trace-digest 单文件损坏即整体 rc=1（2026-08-07 事故）。
 *
 * 契约升级为：**落盘产物必定可解析，且所有数字保持原值**。
 */
describe("落盘产物必定可解析且数字不失真", () => {
  // 实测在盘上真的造成过损坏的 cost 值
  const REAL_COSTS = [
    0.4428123456780257, 0.5154235074925331, 0.1015861489997812, 1.0327980477802163, 2.24225,
  ];

  test("session.traj：cost 小数原值保留且可解析", async () => {
    for (const cost of REAL_COSTS) {
      await writer.writeTraj({
        trajectory: [],
        metadata: { total_cost_usd: cost, total_api_calls: 11 },
        info: { model_stats: { total_cost_usd: cost } },
      });
      const txt = readFileSync(join(sessionDir, "session.traj"), "utf-8");
      const parsed = JSON.parse(txt); // 损坏则此处直接抛
      expect(parsed.metadata.total_cost_usd).toBe(cost);
      expect(parsed.info.model_stats.total_cost_usd).toBe(cost);
      expect(txt).not.toContain("*");
    }
  });

  test("session.traj：同时含凭证与 cost —— 凭证脱敏、数字不动、仍可解析", async () => {
    const cost = 0.4428123456780257;
    await writer.writeTraj({
      trajectory: [{ text: OPENAI_KEY }],
      metadata: { total_cost_usd: cost },
    });
    const txt = readFileSync(join(sessionDir, "session.traj"), "utf-8");
    const parsed = JSON.parse(txt);
    expect(txt).not.toContain(OPENAI_KEY);
    expect(parsed.metadata.total_cost_usd).toBe(cost);
  });

  test("events.jsonl / raw.jsonl：每行都可解析且 cost 不失真", () => {
    const cost = 0.5154235074925331;
    writer.appendEvent({
      event: "AfterModelRaw",
      session_id: "s",
      timestamp: "2026-08-07T00:00:00Z",
      data: { cost_usd: cost, input_tokens: 4428123456780257 },
    });
    writer.appendRaw({ index: 1, model: "m", usage: { cost_usd: cost } } as any);

    for (const f of ["events.jsonl", "raw.jsonl"]) {
      const txt = readFileSync(join(sessionDir, f), "utf-8");
      for (const line of txt.trim().split("\n")) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      expect(txt).toContain(String(cost));
    }
  });
});
