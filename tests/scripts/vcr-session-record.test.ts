import { describe, test, expect } from "bun:test";
import { redact, rawToSessionFixture } from "../../scripts/vcr-session-record.ts";

describe("vcr-session-record 脱敏与转换", () => {
  test("密钥 / Bearer / 内网地址 / home 路径 / 邮箱全部抹掉", () => {
    const s = redact(
      'key sk-abcdef1234567890 "authorization":"Bearer eyJhbGciOi.xyz" http://10.1.2.3:4000/v1 ' +
        "/Users/alice/proj a@corp.com 192.168.0.9",
    );
    expect(s).not.toMatch(/abcdef1234567890|eyJhbGciOi|10\.1\.2\.3|alice|a@corp\.com|192\.168/);
  });

  test("丢弃请求侧与 thinking，保留 text/tool_use 与 usage，按 --sub 标路由", () => {
    const raw = [
      JSON.stringify({ type: "request_sent", index: 1 }),
      JSON.stringify({
        index: 1,
        request: { system: "secret system /Users/bob" },
        response: {
          content: [
            { type: "thinking", thinking: "x", signature: "sig" },
            { type: "tool_use", id: "t1", name: "read", input: { path: "/home/bob/a.ts" } },
          ],
        },
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 },
      }),
      JSON.stringify({
        index: 2,
        response: { content: [{ type: "text", text: "ok" }] },
        usage: {},
      }),
    ].join("\n");
    const fx: any = rawToSessionFixture(raw, {
      family: "anthropic-messages",
      model: "m",
      prompt: "p",
      description: "d",
      sub: new Set([2]),
    });
    expect(JSON.stringify(fx)).not.toMatch(/secret system|signature|bob/);
    expect(fx.turns.map((t: any) => [t.agent, t.response.stop_reason])).toEqual([
      ["main", "tool_use"],
      ["sub", "end_turn"],
    ]);
    expect(fx.turns[0].usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 5,
    });
  });
});
