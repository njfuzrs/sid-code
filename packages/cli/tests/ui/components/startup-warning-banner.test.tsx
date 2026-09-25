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
import { render } from "@sid-code/tui-renderer/_vendor/testing.tsx";
import { Notifications } from "@sid-code/cli/ui/components/Notifications.tsx";
import { UIStateProvider } from "@sid-code/cli/ui/contexts/UIStateContext.tsx";
import { StreamingProvider, StreamingState } from "@sid-code/cli/ui/contexts/StreamingContext.tsx";
import { KeypressProvider } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
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
