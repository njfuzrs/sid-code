/**
 * 账单侧缓存断裂检测：消息前缀进判据
 *
 * 缺陷：兜底判据 `combinePrefixHash` 只含 system / tools / 工具顺序，不含消息。
 * 历史被原地改写时它照样不变，于是本地断裂被判成 `server_fluctuation`。
 * 对齐轨迹实测（10-21~10-30）：字节侧 `prefix_break` 确认断了且浪费 > 1% 的请求里，
 * 账单侧有 35 次判成了服务端波动。
 *
 * 本文件只测 CacheBreakDetector 本身（只调 checkResponse，不进环形缓冲、不落盘）。
 */
import { describe, test, expect } from "bun:test";
import { CacheBreakDetector, type CacheCheckParams } from "@sid-code/core/api/cache-detection.ts";
import { serializeMessageForFingerprint } from "@sid-code/core/api/message-fingerprint.ts";

const TOOLS = [{ name: "read", description: "read file" }];

/** 每条约 2KB，6 条约 12KB，改写第 3 条起作废约一半，远超 1% */
function msg(i: number, tag = ""): { role: string; content: string } {
  return { role: i % 2 ? "assistant" : "user", content: `第 ${i} 条${tag} ` + "x".repeat(2000) };
}
const history = (n: number) => Array.from({ length: n }, (_, i) => msg(i));

function params(over: Partial<CacheCheckParams>): CacheCheckParams {
  return {
    cacheReadTokens: 10_000,
    systemPrompt: "you are helpful",
    toolSchemas: TOOLS,
    model: "m",
    ...over,
  };
}

/** 先建基线，再发第二轮（cache_read 掉 50%，满足 5% 且 2000 token 的双重阈值） */
function run(prevMsgs: unknown[] | undefined, currMsgs: unknown[] | undefined) {
  const d = new CacheBreakDetector(() => 0); // 时间不前进，排除 ttl_expiry
  d.checkResponse(params({ cacheReadTokens: 10_000, messages: prevMsgs }));
  return d.checkResponse(params({ cacheReadTokens: 5_000, messages: currMsgs }));
}

describe("消息前缀进判据", () => {
  test("system / tools 不变、第 3 条消息被改写 → message_history，不是 server_fluctuation", () => {
    const prev = history(6);
    const curr = [...history(6)];
    curr[3] = msg(3, "（被改写）");
    curr.push(msg(6));
    const r = run(prev, curr)!;
    expect(r.categories).toEqual(["message_history"]);
    expect(r.messagePrefixChanged).toBe(true);
    expect(r.firstChangedMessageIndex).toBe(3);
    expect(r.messageWastedRatio!).toBeGreaterThan(0.3);
    expect(r.changes[0]).toContain("第 3 条");
  });

  test("纯尾部追加 → 消息前缀没变，仍判 server_fluctuation", () => {
    const prev = history(6);
    const curr = [...history(6), msg(6), msg(7)];
    const r = run(prev, curr)!;
    expect(r.categories).toEqual(["server_fluctuation"]);
    expect(r.messagePrefixChanged).toBe(false);
    expect(r.firstChangedMessageIndex).toBeUndefined();
  });

  test("只改了最后一条且很小（浪费 ≤ 1%）→ 不归 message_history，仍判 server_fluctuation", () => {
    // 最后一条只有几个字符：模拟尾部 transient reminder 被撤掉
    const prev = [...history(30), { role: "user", content: "<reminder/>" }];
    const curr = [...history(30), { role: "user", content: "继续" }];
    const r = run(prev, curr)!;
    expect(r.messagePrefixChanged).toBe(true);
    expect(r.messageWastedRatio!).toBeLessThanOrEqual(0.01);
    expect(r.categories).toEqual(["server_fluctuation"]);
  });

  test("消息被截短（本轮比上一轮少）→ 截掉的部分算改写", () => {
    const prev = history(6);
    const curr = history(2);
    const r = run(prev, curr)!;
    // 条数骤减会先命中 compact 兜底归因；这里只断言消息前缀的诊断字段
    expect(r.messagePrefixChanged).toBe(true);
    expect(r.firstChangedMessageIndex).toBe(2);
  });

  test("不传 messages → 行为与旧版一致：判 server_fluctuation，且不带消息诊断字段", () => {
    const r = run(undefined, undefined)!;
    expect(r.categories).toEqual(["server_fluctuation"]);
    expect("messagePrefixChanged" in r).toBe(false);
  });

  test("只有一轮传了 messages → 不可判，不能当成「没变」也不能当成「变了」", () => {
    const r = run(undefined, history(6))!;
    expect(r.categories).toEqual(["server_fluctuation"]);
    expect("messagePrefixChanged" in r).toBe(false);
  });

  test("system prompt 变了时仍归 system_prompt（消息判据不抢先）", () => {
    const d = new CacheBreakDetector(() => 0);
    const prev = history(6);
    const curr = [...history(6)];
    curr[3] = msg(3, "（被改写）");
    d.checkResponse(params({ cacheReadTokens: 10_000, messages: prev }));
    const r = d.checkResponse(
      params({ cacheReadTokens: 5_000, systemPrompt: "changed", messages: curr }),
    )!;
    expect(r.categories).toEqual(["system_prompt"]);
    // 诊断字段照样带上，读的人能看到两处都变了
    expect(r.messagePrefixChanged).toBe(true);
  });
});

describe("序列化与字节侧 prefix_break 同源", () => {
  test("循环引用降级为空串，不抛错", () => {
    const a: Record<string, unknown> = { role: "user" };
    a.self = a;
    expect(serializeMessageForFingerprint(a)).toBe("");
  });

  test("prefix-break-probe 不再自带一份序列化实现", async () => {
    const src = await Bun.file(
      new URL("../../src/trace/prefix-break-probe.ts", import.meta.url),
    ).text();
    expect(src).toContain("serializeMessageForFingerprint");
    expect(src).not.toMatch(/function safeStringify\(/);
  });
});
