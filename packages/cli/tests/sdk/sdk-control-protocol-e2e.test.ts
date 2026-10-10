/**
 * B25 子进程 e2e：SDK 控制协议的 `can_use_tool` 与 `interrupt` 真的走通。
 *
 * 为什么必须起子进程：这两条能力以前在单测里全绿（permission-bridge / structured-io 各自测过），
 * 但生产路径零调用——单测只测了 sid-code 自己那一侧。这里 spawn 真实 bootstrap.ts，
 * 宿主侧用真实 NDJSON 读写 stdin/stdout，LLM 换成本地假 OpenAI 兼容服务，断言：
 *   1. 需要确认的工具（write）发出 `can_use_tool`，带真实 tool_use_id；
 *   2. 宿主回 deny → 文件没写出来，模型收到的 tool_result 是拒绝；
 *   3. 宿主回 allow → 文件写出来了；
 *   4. 宿主发 `interrupt` → 回 control_response success，本轮结束；
 *   5. 其余控制请求（set_model）回 error 而不是静默丢弃。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const BOOTSTRAP = resolve(import.meta.dir, "../../src/entrypoints/bootstrap.ts");

/** 假 LLM 的一次回复：要么调一个工具，要么回文本；hang=true 表示挂住不收尾（测 interrupt） */
type Reply = { tool?: { id: string; name: string; args: unknown }; text?: string; hang?: boolean };

let server: ReturnType<typeof Bun.serve>;
let replies: Reply[] = [];
/** 每次请求的 messages（看模型收到了什么 tool_result） */
let requests: any[] = [];

function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

function chunk(delta: unknown, finish: string | null = null) {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
      const body = await req.json();
      requests.push(body);
      const r = replies.shift() ?? { text: "ok" };
      if (r.hang) {
        // 只吐一个开头 chunk，然后一直不收尾，直到客户端断开
        const stream = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(chunk({ role: "assistant", content: "思考中" }))}\n\n`,
              ),
            );
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      const chunks = r.tool
        ? [
            chunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: r.tool.id,
                  type: "function",
                  function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) },
                },
              ],
            }),
            chunk({}, "tool_calls"),
          ]
        : [chunk({ role: "assistant", content: r.text ?? "ok" }), chunk({}, "stop")];
      return new Response(sse(chunks), { headers: { "content-type": "text/event-stream" } });
    },
  });
});

afterAll(() => {
  server?.stop(true);
});

interface Session {
  send: (msg: unknown) => void;
  /** 等第一条满足条件的 stdout 消息 */
  waitFor: (pred: (m: any) => boolean, ms?: number) => Promise<any>;
  all: any[];
  close: () => Promise<{ code: number; stderr: string }>;
  workDir: string;
}

function startSession(): Session {
  const configDir = mkdtempSync(join(tmpdir(), "sid-b25-cfg-"));
  const workDir = mkdtempSync(join(tmpdir(), "sid-b25-work-"));
  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify({
      model: "fake-model",
      availableModels: [
        {
          name: "fake-model",
          provider: "openai",
          api_key: "sk-test-not-a-real-key",
          base_url: `http://127.0.0.1:${server.port}/v1`,
        },
      ],
      debug_log_file: join(configDir, "debug.log"),
    }),
  );
  const proc = Bun.spawn(
    [
      "bun",
      BOOTSTRAP,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    {
      cwd: workDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SID_CODE_DISABLE_PROJECT_RULES: "1",
        SID_CONFIG_DIR: configDir,
        // 假服务按到达顺序 shift 脚本回复，只能服务主循环。end_turn 后的记忆提取 fork
        // 也打同一个端点，会抢走下一轮的脚本回复（F3 之前它被单飞闸门恒丢，从没发过请求）。
        SID_CODE_AUTO_MEMORY: "0",
        // 本机系统代理会拦 loopback，假服务必须直连
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        http_proxy: "",
        https_proxy: "",
      },
    },
  );
  const all: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const c of proc.stdout as any) {
      buf += decoder.decode(c, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        all.push(m);
        for (const w of [...waiters]) {
          if (w.pred(m)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(m);
          }
        }
      }
    }
  })();
  return {
    all,
    workDir,
    send: (msg) => {
      proc.stdin.write(JSON.stringify(msg) + "\n");
      proc.stdin.flush();
    },
    waitFor: (pred, ms = 30_000) => {
      const hit = all.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const t = setTimeout(
          () =>
            rej(
              new Error(
                `等待超时；已收到: ${all.map((m) => m.type + "/" + (m.subtype ?? m.request?.subtype ?? "")).join(", ")}`,
              ),
            ),
          ms,
        );
        waiters.push({ pred, resolve: (m) => (clearTimeout(t), res(m)) });
      });
    },
    close: async () => {
      proc.stdin.end();
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      rmSync(configDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
      return { code, stderr };
    },
  };
}

const userMsg = (text: string) => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
  session_id: "",
});

function toolResultsSent(): string {
  return JSON.stringify(requests.map((r) => r.messages.filter((m: any) => m.role === "tool")));
}

describe("B25 SDK 控制协议（子进程 e2e）", () => {
  test("can_use_tool：deny 不写文件、allow 写文件；set_model 回 error", async () => {
    requests = [];
    replies = [
      {
        tool: { id: "call_deny_1", name: "write", args: { file_path: "denied.txt", content: "x" } },
      },
      { text: "好的，不写了" },
      {
        tool: {
          id: "call_allow_1",
          name: "write",
          args: { file_path: "allowed.txt", content: "hello" },
        },
      },
      { text: "写好了" },
    ];
    const s = startSession();
    try {
      // 未实现的控制请求：必须回 error，不能静默丢弃
      s.send({
        type: "control_request",
        request_id: "r-set-model",
        request: { subtype: "set_model", model: "x" },
      });
      const setModelResp = await s.waitFor(
        (m) => m.type === "control_response" && m.response?.request_id === "r-set-model",
      );
      expect(setModelResp.response.subtype).toBe("error");

      // 第一轮：宿主 deny
      s.send(userMsg("写 denied.txt"));
      const req1 = await s.waitFor(
        (m) => m.type === "control_request" && m.request?.subtype === "can_use_tool",
      );
      expect(req1.request.tool_name).toBe("write");
      expect(req1.request.tool_use_id).toBe("call_deny_1");
      s.send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: req1.request_id,
          response: { behavior: "deny", tool_use_id: "call_deny_1" },
        },
      });
      await s.waitFor((m) => m.type === "result");
      expect(existsSync(join(s.workDir, "denied.txt"))).toBe(false);
      // 模型收到的是拒绝，不是成功
      expect(toolResultsSent()).toContain("call_deny_1");
      expect(toolResultsSent()).toMatch(/拒绝|denied|deny/i);

      // 第二轮：宿主 allow
      s.send(userMsg("写 allowed.txt"));
      const req2 = await s.waitFor(
        (m) =>
          m.type === "control_request" &&
          m.request?.subtype === "can_use_tool" &&
          m.request.tool_use_id === "call_allow_1",
      );
      s.send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: req2.request_id,
          response: { behavior: "allow", tool_use_id: "call_allow_1" },
        },
      });
      await s.waitFor((m) => m.type === "result" && m !== s.all.find((x) => x.type === "result"));
      expect(readFileSync(join(s.workDir, "allowed.txt"), "utf-8")).toBe("hello");
    } finally {
      const { code, stderr } = await s.close();
      if (code !== 0) console.error(stderr);
      expect(code).toBe(0);
    }
  }, 90_000);

  test("can_use_tool：宿主不答就关 stdin → fail-closed，不写文件", async () => {
    requests = [];
    replies = [
      { tool: { id: "call_eof_1", name: "write", args: { file_path: "eof.txt", content: "x" } } },
      { text: "被拒了" },
    ];
    const s = startSession();
    const workDir = s.workDir;
    s.send(userMsg("写 eof.txt"));
    await s.waitFor((m) => m.type === "control_request" && m.request?.subtype === "can_use_tool");
    expect(existsSync(join(workDir, "eof.txt"))).toBe(false);
    // 直接关 stdin，不回 control_response：必须很快按 deny 收尾，而不是挂到 60s 超时
    const started = Date.now();
    const closing = s.close();
    const { code } = await closing;
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(code).toBe(0);
    expect(toolResultsSent()).toContain("call_eof_1");
  }, 90_000);

  test("interrupt：回 success，本轮结束，下一轮还能正常跑", async () => {
    requests = [];
    replies = [{ hang: true }, { text: "第二轮正常" }];
    const s = startSession();
    try {
      s.send(userMsg("讲个很长的故事"));
      // 等假服务确实收到请求（模型正在「生成」）
      for (let i = 0; i < 200 && requests.length === 0; i++) await Bun.sleep(50);
      expect(requests.length).toBe(1);
      s.send({ type: "control_request", request_id: "r-int", request: { subtype: "interrupt" } });
      const resp = await s.waitFor(
        (m) => m.type === "control_response" && m.response?.request_id === "r-int",
      );
      expect(resp.response.subtype).toBe("success");
      // 本轮结束：interrupt 之后很快出一条 result，且期间没有发生重试。
      // ⚠️ 两条都要断言：不接 interrupt 时，挂住的流约 16s 后会被流心跳超时杀掉并重试，
      // 重试吃掉下一个回复也能产出 result——只等 result 会在变异下照样全绿（实测过）。
      const interruptedAt = Date.now();
      const r1 = await s.waitFor((m) => m.type === "result", 20_000);
      expect(Date.now() - interruptedAt).toBeLessThan(5_000);
      expect(requests.length).toBe(1);
      expect(r1.result).not.toBe("第二轮正常");

      // 会话没死：下一轮正常
      s.send(userMsg("再来"));
      await s.waitFor((m) => m.type === "result" && m.result === "第二轮正常", 20_000);
    } finally {
      await s.close();
    }
  }, 90_000);
});
