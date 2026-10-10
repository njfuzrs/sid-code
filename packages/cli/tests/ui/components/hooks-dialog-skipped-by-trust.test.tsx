/**
 * /hooks 面板标注被信任门跳过的项目级层（§三.9）。
 *
 * 被摘掉的层不进注册表，getAllHooks() 看不到——不标注的话，用户看到「没有注册任何 Hook」
 * 会以为是格式写错，真正原因是工作区没信任。计数口径与 cli.ts 信任门、`hooks list` 一致。
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import stripAnsi from "strip-ansi";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { HooksDialog, countSkippedByTrust } from "@sid-code/cli/ui/components/HooksDialog.tsx";
import { KeypressProvider } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { ConfigSource } from "@sid-code/core/hook/types.ts";
import type { HookLayer } from "@sid-code/core/config/hook-layers.ts";

const SKIPPED: HookLayer = {
  source: "project",
  file: ".sid-code/settings.json",
  hooks: { PreToolUse: [{ command: "a" }, { command: "b" }], Stop: [{ command: "c" }] },
  untrusted: true,
  skippedByTrust: true,
};
const TRUSTED_USER: HookLayer = {
  source: "user",
  file: "~/.sid-code/settings.json",
  hooks: { Stop: [{ command: "u" }] },
  untrusted: false,
};

function frame(sys: HookSystem, layers?: HookLayer[]): string {
  const { lastFrame } = render(
    <KeypressProvider>
      <HooksDialog onClose={() => {}} hookSystem={sys} hookLayers={layers} />
    </KeypressProvider>,
    { columns: 100 },
  );
  return stripAnsi(lastFrame() ?? "");
}

describe("HooksDialog skippedByTrust 标注", () => {
  test("计数只算被跳过的层", () => {
    expect(countSkippedByTrust([SKIPPED, TRUSTED_USER])).toBe(3);
    expect(countSkippedByTrust([TRUSTED_USER])).toBe(0);
    expect(countSkippedByTrust(undefined)).toBe(0);
  });

  test("空注册表时也显示跳过标注", () => {
    const f = frame(new HookSystem(), [SKIPPED]);
    expect(f).toContain("当前没有注册任何 Hook");
    expect(f).toContain("未信任工作区，已跳过 3 条（项目级）");
  });

  test("有已注册 hook 时列表下方显示标注", () => {
    const sys = new HookSystem();
    sys.initializeFromSources([{ hooks: TRUSTED_USER.hooks, source: ConfigSource.User }]);
    const f = frame(sys, [SKIPPED, TRUSTED_USER]);
    expect(f).toContain("Hooks 管理");
    expect(f).toContain("未信任工作区，已跳过 3 条（项目级）");
  });

  test("没有被跳过的层时不显示", () => {
    const sys = new HookSystem();
    sys.initializeFromSources([{ hooks: TRUSTED_USER.hooks, source: ConfigSource.User }]);
    expect(frame(sys, [TRUSTED_USER])).not.toContain("未信任工作区");
  });
});
