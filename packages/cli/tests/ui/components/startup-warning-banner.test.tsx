/**
 * 启动警告横幅渲染。
 *
 * 回归：per-model base_url 覆盖 env 的提示此前走 getLogger().warn，而 loadConfig
 * 时 logger 还是 enabled=false 的兜底实例，WARN 只写 stderr，TUI 进 alternate
 * buffer 后被清掉。现在它进 _validationDiagnostics，由本横幅渲染。
 *
 * 文案直接取 loadConfig 的产出，而不是在测试里手写一份：横幅按列硬切，
 * 手写的短句过得了、真实的长 URL 会被从 `https://` 中间切开。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { render, renderSync } from "@sid-code/cli/ui/render-port/testing.ts";
import { Notifications } from "@sid-code/cli/ui/components/Notifications.tsx";
import { UIStateProvider } from "@sid-code/cli/ui/contexts/UIStateContext.tsx";
import { StreamingProvider, StreamingState } from "@sid-code/cli/ui/contexts/StreamingContext.tsx";
import {
  KeypressProvider,
  KeypressPriority,
  useKeypress,
  ESC_TIMEOUT,
  type Key,
} from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { loadConfig } from "@sid-code/core/config/config.ts";

function renderBanner(warnings: { id: string; message: string }[]) {
  return render(
    <KeypressProvider>
      <UIStateProvider>
        <StreamingProvider
          streamingState={StreamingState.Idle}
          streamingText=""
          streamingThinking=""
          toolName={null}
          toolInput={undefined}
          isToolExecuting={false}
          lastToolResult={null}
          statusMessage=""
        >
          <Notifications startupWarnings={warnings} />
        </StreamingProvider>
      </UIStateProvider>
    </KeypressProvider>,
  );
}

describe("启动警告横幅", () => {
  test("baseURL 覆盖提示的两个地址各自成行，不被从中间切开", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sid-cfg-"));
    const saved = {
      SID_CONFIG_DIR: process.env.SID_CONFIG_DIR,
      SID_CODE_LLM_BASE_URL: process.env.SID_CODE_LLM_BASE_URL,
    };
    try {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({
          model: "my-model",
          availableModels: [
            {
              name: "my-model",
              provider: "openai",
              base_url: "https://model.example/v1",
            },
          ],
        }),
      );
      process.env.SID_CONFIG_DIR = dir;
      process.env.SID_CODE_LLM_BASE_URL = "https://env.example/v1";
      const cfg = await loadConfig({});
      const warning = cfg._validationDiagnostics?.warnings.find((w) => w.path === "baseURL");
      expect(warning).toBeDefined();

      const { lastFrame } = renderBanner([{ id: "baseURL", message: warning!.message }]);
      const frame = lastFrame() ?? "";
      const lines = frame.split("\n").map((l) => l.trim());
      // 两个 URL 必须各自落在一行里，而不是被硬切成 `https` / `://...` 两截
      expect(lines.some((l) => l.includes("https://env.example/v1"))).toBe(true);
      expect(lines.some((l) => l.includes("https://model.example/v1"))).toBe(true);
      expect(frame).toContain("请删除该模型的 base_url");
      expect(frame).toContain("按任意键关闭");
    } finally {
      if (saved.SID_CONFIG_DIR === undefined) delete process.env.SID_CONFIG_DIR;
      else process.env.SID_CONFIG_DIR = saved.SID_CONFIG_DIR;
      if (saved.SID_CODE_LLM_BASE_URL === undefined) delete process.env.SID_CODE_LLM_BASE_URL;
      else process.env.SID_CODE_LLM_BASE_URL = saved.SID_CODE_LLM_BASE_URL;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("没有警告时不渲染", () => {
    const { lastFrame } = renderBanner([]);
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});

// ── 关闭警告的那一键不能被吞掉（排查报告 #5） ──
// 经真实 KeypressProvider 解析链驱动，stdin harness 沿用 keypress-empty-paste.test.tsx。

function mountWithProbe() {
  const got: Key[] = [];
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
  };
  stdout.columns = 80;
  stdout.rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = false;
  stdout.on("data", () => {});

  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const stdinAny = stdin as unknown as Record<string, unknown>;
  stdinAny.isTTY = true;
  stdinAny.setRawMode = () => stdin;
  stdinAny.setEncoding = () => stdin;
  stdinAny.ref = () => stdin;
  stdinAny.unref = () => stdin;

  // 代表 InputArea：Normal 优先级，排在 Notifications（Critical）之后
  function Probe() {
    useKeypress(KeypressPriority.Normal, (key) => {
      got.push(key);
      return true;
    });
    return null;
  }

  const instance = renderSync(
    <KeypressProvider>
      <UIStateProvider>
        <StreamingProvider
          streamingState={StreamingState.Idle}
          streamingText=""
          streamingThinking=""
          toolName={null}
          toolInput={undefined}
          isToolExecuting={false}
          lastToolResult={null}
          statusMessage=""
        >
          <Notifications startupWarnings={[{ id: "w", message: "配置警告" }]} />
          <Probe />
        </StreamingProvider>
      </UIStateProvider>
    </KeypressProvider>,
    { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
  );

  return {
    got,
    send: async (seq: string) => {
      stdin.emit("data", seq);
      await new Promise((r) => setTimeout(r, ESC_TIMEOUT * 2));
    },
    unmount: () => instance.unmount(),
  };
}

describe("启动警告关闭键", () => {
  test("可插入字符关闭警告后继续传给输入框", async () => {
    const m = mountWithProbe();
    await m.send("z");
    expect(m.got.map((k) => k.sequence)).toEqual(["z"]);
    m.unmount();
  });

  test("Esc 只关警告，不传给输入框；之后的键照常到达", async () => {
    const m = mountWithProbe();
    await m.send("\x1b");
    expect(m.got.length).toBe(0);
    await m.send("q");
    expect(m.got.map((k) => k.sequence)).toEqual(["q"]);
    m.unmount();
  });
});
