/**
 * D12 子进程 e2e：`-p` 在 stdin 管道**不关闭**时，出结果后必须自己退出。
 *
 * 缺陷形态：`readPipedStdin()` 超时后只 `off` 掉监听器，已 `resume()` 的 stdin 仍是
 * 活动句柄，进程一直等到上游关闭 fd 才退（实测 `sleep 120 | sid-code -p` 挂 120s）。
 * CI / 脚本 / SDK 宿主继承一个空管道就是这个形态。
 *
 * ⚠ 计时必须量**子进程自己的 exit 事件**，不能量整条 shell 管道：`time (sleep 8 | x)`
 * 会一直等到 sleep 结束，修没修都显示 8s，是一个必然的假红。所以这里由测试持有
 * stdin 写端且始终不关闭。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const BOOTSTRAP = resolve(import.meta.dir, "../../src/entrypoints/bootstrap.ts");

let server: ReturnType<typeof Bun.serve>;

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
      await req.text();
      const body =
        [chunk({ role: "assistant", content: "pong" }), chunk({}, "stop")]
          .map((c) => `data: ${JSON.stringify(c)}\n\n`)
          .join("") + "data: [DONE]\n\n";
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
});

afterAll(() => {
  server?.stop(true);
});

/**
 * 三种输出格式都要覆盖。实测（2026-10-17）只有 `stream-json` 输出会挂：text / json
 * 两条路径在 `runHeadless` 末尾显式 `process.exit`，而 stream-json 输出走
 * `runHeadlessSDK`，它把 `process.stdin` **再读一次**当 NDJSON 命令通道，等 EOF 才收尾。
 * 只测 text 会在未修代码上也全绿（本测试第一版就是这样）。
 */
const FORMATS: [string, string[]][] = [
  ["text", []],
  ["json", ["--output-format", "json"]],
  ["stream-json", ["--output-format", "stream-json", "--verbose"]],
];

describe("D12：-p 不被未关闭的 stdin 撑住", () => {
  test.each(FORMATS)(
    "%s：stdin 写端保持打开，进程在读超时后数秒内退出",
    async (_name, args) => {
      const configDir = mkdtempSync(join(tmpdir(), "sid-d12-cfg-"));
      const workDir = mkdtempSync(join(tmpdir(), "sid-d12-work-"));
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
      const started = Date.now();
      const proc = Bun.spawn(["bun", BOOTSTRAP, "-p", "ping", ...args], {
        cwd: workDir,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          SID_CODE_DISABLE_PROJECT_RULES: "1",
          SID_CONFIG_DIR: configDir,
          SID_CODE_AUTO_MEMORY: "0",
          // 读超时压到 300ms：被测的是「超时之后放不放手」，不是超时本身
          SID_CODE_STDIN_TIMEOUT_MS: "300",
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          http_proxy: "",
          https_proxy: "",
        },
      });
      // 只写不关：模拟上游生产者一直活着（`sleep 120 | sid-code -p`）
      proc.stdin.write("");
      proc.stdin.flush();

      const HOLD_MS = 30_000;
      const exited = await Promise.race([
        proc.exited.then((code) => ({ code })),
        new Promise<null>((r) => setTimeout(() => r(null), HOLD_MS)),
      ]);
      const elapsed = Date.now() - started;
      const stdout = exited ? await new Response(proc.stdout).text() : "";
      if (!exited) proc.kill();
      try {
        proc.stdin.end();
      } catch {
        /* 已退出 */
      }
      rmSync(configDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });

      expect(exited, `进程在 stdin 打开期间 ${HOLD_MS}ms 未退出`).not.toBeNull();
      expect(exited!.code).toBe(0);
      expect(stdout).toContain("pong");
      // 冷启动 bun + init 在慢 runner 上可达十几秒；判据只需与 HOLD_MS 拉开数量级
      expect(elapsed).toBeLessThan(HOLD_MS);
    },
    60_000,
  );
});
