/**
 * T7（20261018 复审，原方案 §9.5）：把 §2.2 的假上游矩阵固化成 `-p` 进程级 e2e。
 *
 * 为什么要进程级：单测锁的是 applier / 线格式层函数，本测试锁的是「真入口 → 配置解析 →
 * 主循环 → provider → 请求体」整条链路。env `SID_CODE_THINKING` 作为意图来源，
 * 覆盖 Anthropic 与 OpenAI 两协议、三种控制形态。
 *
 * 每个用例一个独立假上游：并发跑时共用一个 server 会让请求串到别的用例上（首版探针踩过）。
 * 显式传 SID_CONFIG_DIR 到临时目录，不触碰真实 ~/.sid-code。
 */

import { describe, test, expect } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const BOOTSTRAP = resolve(import.meta.dir, "../../src/entrypoints/bootstrap.ts");

type Captured = {
  thinking?: { type: string };
  output_config?: unknown;
  reasoning_effort?: unknown;
};

function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function startUpstream(captured: Captured[]) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (!path.endsWith("/messages") && !path.endsWith("/chat/completions")) {
        return new Response("{}", { status: 404 });
      }
      const body = JSON.parse(await req.text());
      captured.push(body);
      if (path.endsWith("/messages")) {
        return new Response(
          sse([
            {
              type: "message_start",
              message: {
                id: "m",
                type: "message",
                role: "assistant",
                model: body.model,
                content: [],
                stop_reason: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          ]),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const chunk = (delta: unknown, finish: string | null = null) => ({
        id: "c",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      return new Response(
        [chunk({ role: "assistant", content: "pong" }), chunk({}, "stop")]
          .map((c) => `data: ${JSON.stringify(c)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
}

async function runPrint(model: string, provider: string, thinking: "off" | "auto") {
  const captured: Captured[] = [];
  const server = startUpstream(captured);
  const configDir = mkdtempSync(join(tmpdir(), "sid-t7-cfg-"));
  const workDir = mkdtempSync(join(tmpdir(), "sid-t7-work-"));
  try {
    const base = `http://127.0.0.1:${server.port}${provider === "anthropic" ? "" : "/v1"}`;
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({
        model,
        availableModels: [
          { name: model, provider, api_key: "sk-test-not-a-real-key", base_url: base },
        ],
        debug_log_file: join(configDir, "debug.log"),
      }),
    );
    const proc = Bun.spawn(["bun", BOOTSTRAP, "-p", "ping"], {
      cwd: workDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SID_CONFIG_DIR: configDir,
        SID_CODE_THINKING: thinking,
        SID_CODE_DISABLE_PROJECT_RULES: "1",
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
    return { code, stdout, stderr, req: captured[0] };
  } finally {
    server.stop(true);
    rmSync(configDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * 期望值来自原方案 §2.2 / §4.5 与修后行为（#325）。`thinking: null` = 请求体不带该字段。
 * `note` = R8：-p 下 off 落在关不掉的模型上，stderr 必须有提示。
 */
const MATRIX: {
  model: string;
  provider: string;
  thinking: "off" | "auto";
  wire: string | null;
  outputConfig: boolean;
  note: boolean;
}[] = [
  // Anthropic：toggle 且「不传 = 思考」→ off 发 disabled 且剥 effort（D1 / R2）
  {
    model: "claude-sonnet-5",
    provider: "anthropic",
    thinking: "off",
    wire: "disabled",
    outputConfig: false,
    note: false,
  },
  {
    model: "claude-sonnet-5",
    provider: "anthropic",
    thinking: "auto",
    wire: "adaptive",
    outputConfig: true,
    note: false,
  },
  // Anthropic：恒思考 → 两态都 adaptive，off 时 stderr 提示（D5 / R8）
  {
    model: "claude-opus-5-5",
    provider: "anthropic",
    thinking: "off",
    wire: "adaptive",
    outputConfig: true,
    note: true,
  },
  {
    model: "claude-opus-5-5",
    provider: "anthropic",
    thinking: "auto",
    wire: "adaptive",
    outputConfig: true,
    note: false,
  },
  // Anthropic：旧模型 / 仅模糊命中的未来小版本 → 不发（防 5.6 若恒思考时 off 全 400）
  {
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    thinking: "off",
    wire: null,
    outputConfig: false,
    note: false,
  },
  {
    model: "claude-opus-5-6",
    provider: "anthropic",
    thinking: "off",
    wire: null,
    outputConfig: false,
    note: false,
  },
  // OpenAI：DeepSeek toggle
  {
    model: "deepseek-v4-pro",
    provider: "openai",
    thinking: "off",
    wire: "disabled",
    outputConfig: false,
    note: false,
  },
  {
    model: "deepseek-v4-pro",
    provider: "openai",
    thinking: "auto",
    wire: "enabled",
    outputConfig: false,
    note: false,
  },
  // OpenAI：GLM-5.3 恒思考 → off 不发 disabled（会 400），stderr 提示
  {
    model: "glm-5.3",
    provider: "openai",
    thinking: "off",
    wire: null,
    outputConfig: false,
    note: true,
  },
  {
    model: "glm-5.3",
    provider: "openai",
    thinking: "auto",
    wire: "enabled",
    outputConfig: false,
    note: false,
  },
  // OpenAI：无开关族 → 不发 thinking，stderr 提示（D6 / R8）
  {
    model: "kimi-k3",
    provider: "openai",
    thinking: "off",
    wire: null,
    outputConfig: false,
    note: true,
  },
];

describe("T7：-p 进程级 实发 thinking 矩阵", () => {
  test.concurrent.each(MATRIX)(
    "$model × $thinking → $wire",
    async ({ model, provider, thinking, wire, outputConfig, note }) => {
      const r = await runPrint(model, provider, thinking);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("pong");
      expect(r.req, "假上游没收到请求").toBeDefined();
      expect(r.req!.thinking?.type ?? null).toBe(wire);
      expect(r.req!.output_config !== undefined).toBe(outputConfig);
      expect(r.stderr.includes("思考开关为 off")).toBe(note);
    },
    60_000,
  );
});
