/**
 * F1-D04 子进程 e2e：一轮 prompt 产生多条带文本的 assistant 时，三种输出格式口径一致。
 *
 * 复现自 F3 bench（L3f#1 / L2f#1 / F2#3）：模型先交付完整报告并顺手调一次工具，
 * 再用一句话收尾。修前 `--output-format json` 的 `content` 与 stream-json 的 `result`
 * 只剩那句收尾，text 模式反而完整。
 *
 * 假端点按顺序回两次：① 报告正文 + 一个只读工具调用（ls）；② 收尾句。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const BOOTSTRAP = resolve(import.meta.dir, "../../src/entrypoints/bootstrap.ts");
const REPORT = "核查报告：四项全部完成，细节如下。";
const CLOSING = "清单四项均已完成，无遗留工作。";

let server: ReturnType<typeof Bun.serve>;
/** 按请求顺序取回复；每个用例开始时重置 */
let step = 0;
let workDirForTool = "";

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
      await req.json();
      const n = step++;
      const chunks =
        n === 0
          ? [
              chunk({ role: "assistant", content: REPORT }),
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: "call_ls_1",
                    type: "function",
                    function: {
                      name: "ls",
                      arguments: JSON.stringify({ dir_path: workDirForTool }),
                    },
                  },
                ],
              }),
              chunk({}, "tool_calls"),
            ]
          : [chunk({ role: "assistant", content: CLOSING }), chunk({}, "stop")];
      return new Response(sse(chunks), { headers: { "content-type": "text/event-stream" } });
    },
  });
});

afterAll(() => {
  server?.stop(true);
});

async function runPrint(format: "text" | "json" | "stream-json") {
  step = 0;
  const configDir = mkdtempSync(join(tmpdir(), "sid-d04-cfg-"));
  const workDir = mkdtempSync(join(tmpdir(), "sid-d04-work-"));
  workDirForTool = workDir;
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
  const args = ["bun", BOOTSTRAP, "-p", "核查清单", "--output-format", format];
  if (format === "stream-json") args.push("--verbose");
  const proc = Bun.spawn(args, {
    cwd: workDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SID_CODE_DISABLE_PROJECT_RULES: "1",
      SID_CONFIG_DIR: configDir,
      // 记忆提取 fork 也打同一端点，会抢走脚本回复
      SID_CODE_AUTO_MEMORY: "0",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      http_proxy: "",
      https_proxy: "",
    },
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  rmSync(configDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  return { code, stdout, stderr, requests: step };
}

describe("F1-D04：无头结果取本轮全部 assistant 文本", () => {
  test("json：result 含报告与收尾句，content 第一块是报告", async () => {
    const { code, stdout, stderr, requests } = await runPrint("json");
    expect(code, stderr.slice(-2000)).toBe(0);
    // 两次请求都发生了，否则这条用例测不到「多条 assistant」
    expect(requests).toBe(2);
    const r = JSON.parse(stdout.trim());
    expect(r.result).toBe(`${REPORT}\n\n${CLOSING}`);
    expect(r.content.map((b: any) => b.type)).toEqual(["text", "text"]);
    expect(r.content[0].text).toBe(REPORT);
    expect(r.content[1].text).toBe(CLOSING);
  }, 90_000);

  test("stream-json：result 消息含报告", async () => {
    const { code, stdout, stderr } = await runPrint("stream-json");
    expect(code, stderr.slice(-2000)).toBe(0);
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const result = lines.find((l) => l.type === "result");
    expect(result?.subtype).toBe("success");
    expect(result.result).toBe(`${REPORT}\n\n${CLOSING}`);
  }, 90_000);

  test("text：输出与修前一致（报告和收尾句都在）", async () => {
    const { code, stdout, stderr } = await runPrint("text");
    expect(code, stderr.slice(-2000)).toBe(0);
    expect(stdout).toContain(REPORT);
    expect(stdout).toContain(CLOSING);
    expect(stdout.indexOf(REPORT)).toBeLessThan(stdout.indexOf(CLOSING));
  }, 90_000);
});
