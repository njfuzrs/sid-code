/**
 * 工具调用标记残片（GLM `</arg_value>`）检测 + 剥离回归门禁
 *
 * 现象（会话 20261020-130145-4898833d，glm-5.3-uniapi）：最终文本末尾多出孤立的 `</arg_value>`，
 * 原样进了 `-p --output-format json` 的 content。口径（2026-10-30 拍板）：记录 + 剥掉末尾孤立标签。
 *
 * 三层断言：
 *   1. 纯函数：只剥「末尾 + 孤立 + 闭合」，其余一律不动
 *   2. 流式：标签被切成多片也能扣住剥掉；落 protocol-violation；有 tool_calls 时不动
 *   3. 非流式：同一口径
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stripTrailingToolMarkupResidue,
  splitToolMarkupHoldback,
} from "@sid-code/core/llm/tool-markup-residue.ts";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import { installFetchFromFixture, type VcrChunk } from "./vcr/vcr.ts";

describe("stripTrailingToolMarkupResidue", () => {
  test("末尾孤立 </arg_value> 被剥掉（含其后空白）", () => {
    expect(stripTrailingToolMarkupResidue("方案如下\n```\n</arg_value>\n")).toEqual({
      text: "方案如下\n```",
      tag: "</arg_value>",
    });
  });

  test("其它两个闭合标签同样识别", () => {
    expect(stripTrailingToolMarkupResidue("完成</tool_call>")?.tag).toBe("</tool_call>");
    expect(stripTrailingToolMarkupResidue("完成</arg_key>")?.tag).toBe("</arg_key>");
  });

  test("成对出现（有开标签）属于正文，不动", () => {
    expect(stripTrailingToolMarkupResidue("格式是 <arg_value>x</arg_value>")).toBeNull();
  });

  test("标签在正文中间不动", () => {
    expect(stripTrailingToolMarkupResidue("末尾的 </arg_value> 是残片，见上")).toBeNull();
  });

  test("普通文本不动", () => {
    expect(stripTrailingToolMarkupResidue("hello <b>world</b>")).toBeNull();
    expect(stripTrailingToolMarkupResidue("")).toBeNull();
  });
});

describe("splitToolMarkupHoldback", () => {
  test("标签前缀被扣住", () => {
    expect(splitToolMarkupHoldback("abc</arg_v")).toEqual({ emit: "abc", hold: "</arg_v" });
    expect(splitToolMarkupHoldback("abc<")).toEqual({ emit: "abc", hold: "<" });
  });

  test("完整标签后跟空白仍扣住", () => {
    expect(splitToolMarkupHoldback("abc</arg_value>\n")).toEqual({
      emit: "abc",
      hold: "</arg_value>\n",
    });
  });

  test("不可能是残片的尾巴直接放行", () => {
    expect(splitToolMarkupHoldback("a <b> c")).toEqual({ emit: "a <b> c", hold: "" });
    expect(splitToolMarkupHoldback("a </arg_value> b")).toEqual({
      emit: "a </arg_value> b",
      hold: "",
    });
    expect(splitToolMarkupHoldback("x </ y")).toEqual({ emit: "x </ y", hold: "" });
  });
});

// ─── provider 端到端 ───

const PARAMS: SendParams = {
  model: "glm-5.3-uniapi",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 100,
};

let dumpRoot: string;
let prevConfigDir: string | undefined;
let restore: (() => void) | null = null;

beforeEach(() => {
  dumpRoot = mkdtempSync(join(tmpdir(), "sid-residue-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = dumpRoot;
});

afterEach(() => {
  restore?.();
  restore = null;
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(dumpRoot, { recursive: true, force: true });
});

function residueDumps(): Array<Record<string, unknown>> {
  const dir = join(dumpRoot, "protocol-violations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith("-tool-markup-residue.json"))
    .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
}

const sse = (o: unknown): VcrChunk => ({ data: `data: ${JSON.stringify(o)}\n\n`, delayMs: 0 });
const textChunk = (content: string) =>
  sse({ id: "x", choices: [{ index: 0, delta: { content } }] });
const finish = (reason = "stop") =>
  sse({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const DONE: VcrChunk = { data: "data: [DONE]\n\n", delayMs: 0 };

async function runStream(chunks: VcrChunk[]): Promise<StreamEvent[]> {
  restore = installFetchFromFixture({
    provider: "openai",
    scenario: "tool-markup-residue",
    response: { status: 200, headers: { "content-type": "text/event-stream" }, chunks },
  });
  const provider = new OpenAIProvider("test-key", "glm-5.3-uniapi");
  const events: StreamEvent[] = [];
  for await (const ev of provider.sendMessageStream(PARAMS)) events.push(ev);
  return events;
}

const textOf = (events: StreamEvent[]) =>
  events
    .map((e) =>
      e.type === "content_block_delta" && e.delta.type === "text_delta" ? e.delta.text : "",
    )
    .join("");

describe("OpenAIProvider 流式：末尾残片", () => {
  test("被切成多片的 </arg_value> 被剥掉，并落 protocol-violation", async () => {
    const events = await runStream([
      textChunk("方案已写完。"),
      textChunk("</arg"),
      textChunk("_val"),
      textChunk("ue>\n"),
      finish(),
      DONE,
    ]);
    expect(textOf(events)).toBe("方案已写完。");
    const dumps = residueDumps();
    expect(dumps).toHaveLength(1);
    expect(dumps[0]).toMatchObject({
      kind: "tool-markup-residue",
      model: "glm-5.3-uniapi",
      tag: "</arg_value>",
      stripped: true,
      path: "stream",
    });
    expect(String(dumps[0]!.text_tail)).toContain("方案已写完");
  });

  test("暂扣的前缀后面接了别的内容 → 原样放回，不落盘", async () => {
    const events = await runStream([textChunk("a </arg_v"), textChunk("alue> b"), finish(), DONE]);
    expect(textOf(events)).toBe("a </arg_value> b");
    expect(residueDumps()).toHaveLength(0);
  });

  test("成对标签在末尾不剥", async () => {
    const events = await runStream([textChunk("<arg_value>x</arg_value>"), finish(), DONE]);
    expect(textOf(events)).toBe("<arg_value>x</arg_value>");
    expect(residueDumps()).toHaveLength(0);
  });

  test("有结构化 tool_calls 时不剥（前言文本原样保留）", async () => {
    const events = await runStream([
      textChunk("先读文件</arg_value>"),
      sse({
        id: "x",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "read", arguments: '{"p":1}' } },
              ],
            },
          },
        ],
      }),
      finish("tool_calls"),
      DONE,
    ]);
    expect(textOf(events)).toBe("先读文件</arg_value>");
    expect(residueDumps()).toHaveLength(0);
  });

  test("EOF 收尾（无 [DONE]）同样剥离", async () => {
    const events = await runStream([textChunk("ok</arg_value>"), finish()]);
    expect(textOf(events)).toBe("ok");
    expect(residueDumps()).toHaveLength(1);
  });
});

describe("OpenAIProvider 非流式：末尾残片", () => {
  async function runNonStream(message: Record<string, unknown>) {
    restore = installFetchFromFixture({
      provider: "openai",
      scenario: "tool-markup-residue-ns",
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "x",
          choices: [
            { index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      },
    });
    const provider = new OpenAIProvider("test-key", "glm-5.3-uniapi");
    return provider.sendMessageNonStreaming(PARAMS);
  }

  test("无 tool_calls → 剥掉并落盘", async () => {
    const res = await runNonStream({ content: "结论如上\n</arg_value>" });
    const texts = res.content.filter((b) => b.type === "text").map((b: any) => b.text);
    expect(texts).toEqual(["结论如上"]);
    expect(residueDumps()).toHaveLength(1);
    expect(residueDumps()[0]).toMatchObject({ path: "non_stream", stripped: true });
  });

  test("有 tool_calls → 不动", async () => {
    const res = await runNonStream({
      content: "先读</arg_value>",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
    });
    const texts = res.content.filter((b) => b.type === "text").map((b: any) => b.text);
    expect(texts).toEqual(["先读</arg_value>"]);
    expect(residueDumps()).toHaveLength(0);
  });
});
