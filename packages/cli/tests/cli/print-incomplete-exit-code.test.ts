/**
 * P0 #3 子进程 e2e（2026-10-27）：`-p --output-format json` 没有正常说完时，退出码与 JSON 必须如实。
 *
 * 复现自 bug2mr P2 无头运行（会话 7b137546，runs.jsonl 记的是 exitCode: 0）：
 * - 首字节超时重试耗尽：修前退 0，JSON 无 error（1/1）
 * - SIGTERM 落在重试退避期：修前退 0（4/4）。queryLoop 在退避期发现 abort 后
 *   `yield done; return` 不抛异常，主路径比信号处理器先走到 exit(0)。
 *
 * 假端点只收连接不回包（黑洞），用 env 把首字节超时压到 1.5s。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const BOOTSTRAP = resolve(import.meta.dir, "../../src/entrypoints/bootstrap.ts");

let server: ReturnType<typeof Bun.serve>;
let requests = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
      requests++;
      // 黑洞：永不回包，直到客户端断开
      return new Promise<Response>((resolveRes) => {
        req.signal.addEventListener("abort", () => resolveRes(new Response("", { status: 499 })));
      });
    },
  });
});

afterAll(() => {
  server?.stop(true);
});

function spawnPrint(env: Record<string, string>) {
  const configDir = mkdtempSync(join(tmpdir(), "sid-p0-3-cfg-"));
  const workDir = mkdtempSync(join(tmpdir(), "sid-p0-3-work-"));
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
  const proc = Bun.spawn(["bun", BOOTSTRAP, "-p", "ping", "--output-format", "json"], {
    cwd: workDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SID_CODE_DISABLE_PROJECT_RULES: "1",
      SID_CONFIG_DIR: configDir,
      SID_CODE_AUTO_MEMORY: "0",
      SID_CODE_RESPONSE_HEADER_TIMEOUT_MS: "1500",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      ...env,
    },
  });
  const cleanup = () => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  };
  return { proc, cleanup };
}

function parseResult(stdout: string): Record<string, any> {
  // 严格解析：stdout 必须只有一个 JSON（顺带守 #7 的 stdout 污染）
  return JSON.parse(stdout.trim());
}

describe("P0 #3：-p 未正常说完时退出码与 JSON 如实", () => {
  test("首字节超时重试耗尽 → 退出码 1，JSON 带 error.reason=timeout_retry_exhausted", async () => {
    const { proc, cleanup } = spawnPrint({
      SID_CODE_MAX_TIMEOUT_RETRIES: "1",
      SID_CODE_RETRY_BACKOFF_BASE_MS: "100",
      SID_CODE_RETRY_BACKOFF_MAX_MS: "200",
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    cleanup();
    expect(code, stderr.slice(-2000)).toBe(1);
    const result = parseResult(stdout);
    expect(result.is_error).toBe(true);
    expect(result.error?.reason).toBe("timeout_retry_exhausted");
    // #8 / #9：结果体带 model / 成本 / 归一化用量（不管成败都要有，调用方靠它记账）
    expect(result.model).toBe("fake-model");
    expect(typeof result.total_cost_usd).toBe("number");
    expect(typeof result.duration_ms).toBe("number");
    expect(typeof result.num_turns).toBe("number");
    expect(result.usage_normalized).toMatchObject({ prompt_total: expect.any(Number) });
  }, 90_000);

  test("SIGTERM 落在重试退避期 → 退出码 143，JSON 带 error", async () => {
    const { proc, cleanup } = spawnPrint({
      SID_CODE_MAX_TIMEOUT_RETRIES: "5",
      // 退避拉长到 60s：首次超时后进程一定停在退避里
      SID_CODE_RETRY_BACKOFF_BASE_MS: "60000",
      SID_CODE_RETRY_BACKOFF_MAX_MS: "60000",
    });
    const before = requests;
    let stderrSoFar = "";
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        stderrSoFar += decoder.decode(value);
      }
    })();
    // 判据只看假端点收到的请求数，不猜 stderr 文案：
    // ① 等第一次请求到达（冷启动在慢 runner 上可达十几秒）；
    const startDeadline = Date.now() + 40_000;
    while (Date.now() < startDeadline && requests - before < 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(requests - before, stderrSoFar.slice(-2000)).toBe(1);
    // ② 再等首字节超时（1.5s）+ 一个检查周期（5s）+ 余量，这时一定已进入 60s 的退避；
    await new Promise((r) => setTimeout(r, 9_000));
    // ③ 仍只有 1 次请求 = 确实停在退避里，而不是在途
    expect(requests - before).toBe(1);
    proc.kill("SIGTERM");
    const code = await proc.exited;
    await pump;
    const stdout = await new Response(proc.stdout).text();
    cleanup();
    expect(code, stderrSoFar.slice(-2000)).toBe(143);
    // 主路径抢先收尾时 stdout 有 JSON，必须标错；信号路径先退时 stdout 可以为空
    if (stdout.trim()) {
      const result = parseResult(stdout);
      expect(result.is_error).toBe(true);
      expect(result.error).toBeDefined();
    }
  }, 90_000);
});
