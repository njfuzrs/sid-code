// 性能探针用的 OpenAI 兼容 mock 端点：按固定速率逐 token 吐 reasoning_content + content。
//
// 用途：复现「flash 类模型 + 大量 thinking」下 TUI 主线程被流式更新打满的场景，
// 不依赖真实网关（结果可重复、零成本、不受网络抖动影响）。
//
// 用法：
//   bun run scripts/perf-mock-sse.ts [port=18765] [tokPerSec=150] [thinkTokens=3000] [textTokens=600]
// 然后让 sid-code 指过来：
//   SID_CODE_LLM_PROVIDER=openai SID_CODE_LLM_BASE_URL=http://127.0.0.1:18765/v1 \
//   SID_CODE_LLM_MODEL=mock-flash OPENAI_API_KEY=x sid-code-dev
//
// 每个 SSE chunk 只带一个 token（≈2 个中文字符），贴近 DeepSeek 系逐 token 推送的真实粒度。

const port = Number(process.argv[2] ?? 18765);
const tokPerSec = Number(process.argv[3] ?? 150);
const thinkTokens = Number(process.argv[4] ?? 3000);
const textTokens = Number(process.argv[5] ?? 600);
const intervalMs = 1000 / tokPerSec;

const PIECES = [
  "我们",
  "需要",
  "分析",
  "这个",
  "问题",
  "，",
  "首先",
  "考虑",
  "边界",
  "条件",
  "。",
  "\n",
];

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "mock",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock-flash",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`);
    if (!url.pathname.endsWith("/chat/completions")) {
      // 模型列表等探测请求：给个最小合法响应，别让客户端报错
      return Response.json({ object: "list", data: [{ id: "mock-flash", object: "model" }] });
    }
    const body = (await req.json().catch(() => ({}))) as { stream?: boolean; tools?: unknown[] };
    // 只有主循环请求带工具列表；记忆提取 / 标题等辅助调用（forked agent）不带。
    // 辅助调用也拿大流的话，profile 会被 forked-agent 的累积开销污染（实测踩过）。
    const isMain = Array.isArray(body.tools) && body.tools.length > 0;
    console.log(`  stream=${!!body.stream} main=${isMain}`);
    if (!body.stream) {
      // 辅助调用（标题生成等）走非流式：直接短答
      return Response.json({
        id: "mock",
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: "性能探针" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    }
    const stream = new ReadableStream({
      async start(ctrl) {
        const enc = new TextEncoder();
        const send = (s: string) => ctrl.enqueue(enc.encode(s));
        send(chunk({ role: "assistant", content: "" }));
        let next = performance.now();
        const tick = async () => {
          next += intervalMs;
          const wait = next - performance.now();
          if (wait > 0) await Bun.sleep(wait);
        };
        const nThink = isMain ? thinkTokens : 0;
        const nText = isMain ? textTokens : 3;
        for (let i = 0; i < nThink; i++) {
          send(chunk({ reasoning_content: PIECES[i % PIECES.length] }));
          await tick();
        }
        for (let i = 0; i < nText; i++) {
          send(chunk({ content: PIECES[i % PIECES.length] }));
          await tick();
        }
        send(chunk({}, "stop"));
        send(
          `data: ${JSON.stringify({
            id: "mock",
            object: "chat.completion.chunk",
            choices: [],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: nThink + nText,
              total_tokens: 1000 + nThink + nText,
            },
          })}\n\n`,
        );
        send("data: [DONE]\n\n");
        ctrl.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});

console.log(
  `mock-sse listening on 127.0.0.1:${port} rate=${tokPerSec}tok/s think=${thinkTokens} text=${textTokens}`,
);
