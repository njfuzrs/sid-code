/**
 * /terminal-setup 命令测试（P2-3）
 *
 * 覆盖：JSONC 解析（含注释）/ VSCode 变体检测 / keybindings 路径派生 /
 * 原生 CSI-u 终端提示 / 未知终端兜底 / VSCode 系注入（临时目录真实写文件 + 幂等）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { platform } from "os";
import { join } from "path";
import terminalSetupCmd from "../../src/command/commands/terminal-setup/index.ts";
import {
  parseJSONC,
  detectVSCodeVariant,
  getVSCodeKeybindingsPath,
  NATIVE_CSIU_TERMINALS,
} from "../../src/command/commands/terminal-setup/terminal-setup.ts";
import type { CommandContext, LocalCommandModule } from "../../src/command/types.ts";

async function loadHandler(): Promise<LocalCommandModule> {
  const mod = await (terminalSetupCmd as any).load();
  return mod as LocalCommandModule;
}

/** 临时替换 process.env 键，返回恢复函数。 */
function withEnv(patch: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  return () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

describe("/terminal-setup — parseJSONC", () => {
  test("解析带行注释的数组", () => {
    const r = parseJSONC(`[
      // 这是注释
      { "key": "ctrl+a", "command": "x" }
    ]`);
    expect(Array.isArray(r)).toBe(true);
    expect((r as any[])[0].key).toBe("ctrl+a");
  });

  test("解析带块注释的数组", () => {
    const r = parseJSONC(`/* 头部说明 */[{ "key": "b", "command": "y" }]`);
    expect((r as any[]).length).toBe(1);
  });

  test("空内容返回空数组", () => {
    expect(parseJSONC("")).toEqual([]);
    expect(parseJSONC("   \n  ")).toEqual([]);
  });
});

describe("/terminal-setup — 变体检测与路径", () => {
  test("默认 VSCode", () => {
    const restore = withEnv({ __CFBundleIdentifier: undefined, CURSOR_TRACE_ID: undefined, WINDSURF_TRACE_ID: undefined, TERM_PROGRAM: "vscode" });
    const v = detectVSCodeVariant();
    expect(v.configDir).toBe("Code");
    restore();
  });

  test("Cursor 变体（env hint）", () => {
    const restore = withEnv({ CURSOR_TRACE_ID: "abc", __CFBundleIdentifier: undefined, WINDSURF_TRACE_ID: undefined });
    const v = detectVSCodeVariant();
    expect(v.label).toBe("Cursor");
    expect(v.configDir).toBe("Cursor");
    restore();
  });

  test("Windsurf 变体（bundle id hint）", () => {
    const restore = withEnv({ __CFBundleIdentifier: "com.exafunction.windsurf", CURSOR_TRACE_ID: undefined, WINDSURF_TRACE_ID: undefined });
    const v = detectVSCodeVariant();
    expect(v.label).toBe("Windsurf");
    restore();
  });

  test("keybindings 路径按平台派生且以 keybindings.json 结尾", () => {
    const p = getVSCodeKeybindingsPath({ label: "VSCode", configDir: "Code" });
    expect(p.endsWith(join("User", "keybindings.json"))).toBe(true);
    expect(p.includes("Code")).toBe(true);
  });
});

describe("/terminal-setup — 命令分支", () => {
  const restores: Array<() => void> = [];
  afterEach(() => { while (restores.length) restores.pop()!(); });

  test("原生 CSI-u 终端提示无需配置", async () => {
    restores.push(withEnv({ TERM_PROGRAM: "iTerm.app" }));
    const mod = await loadHandler();
    const res = await mod.call("", {} as CommandContext);
    expect((res as any).value).toContain("iTerm2");
    expect((res as any).value).toContain("无需");
  });

  test("WezTerm/Ghostty/Kitty/Warp 均识别为原生", () => {
    expect(NATIVE_CSIU_TERMINALS["wezterm"]).toBe("WezTerm");
    expect(NATIVE_CSIU_TERMINALS["ghostty"]).toBe("Ghostty");
    expect(NATIVE_CSIU_TERMINALS["kitty"]).toBe("Kitty");
    expect(NATIVE_CSIU_TERMINALS["warpterminal"]).toBe("Warp");
  });

  test("未知终端给兜底说明", async () => {
    restores.push(withEnv({ TERM_PROGRAM: "SomeRandomTerm", TERM: "xterm" }));
    const mod = await loadHandler();
    const res = await mod.call("", {} as CommandContext);
    expect((res as any).value).toContain("Enter");
  });

  test("VSCode 系：真实写入临时 keybindings + 幂等", async () => {
    // 用 XDG_CONFIG_HOME 把路径导到临时目录（linux 分支）；mac/win 分支各自路径不便重定向，
    // 这里只在 linux/other 平台断言真实写入，其它平台跳过写入断言（仍验证不抛错）。
    const tmp = join(process.env.TMPDIR ?? "/tmp", `sid-termsetup-${Date.now()}`);
    restores.push(withEnv({
      TERM_PROGRAM: "vscode",
      XDG_CONFIG_HOME: tmp,
      __CFBundleIdentifier: undefined,
      CURSOR_TRACE_ID: undefined,
      WINDSURF_TRACE_ID: undefined,
    }));
    const mod = await loadHandler();
    const res1 = await mod.call("", {} as CommandContext);
    const v1 = (res1 as any).value as string;

    if (platform() === "darwin" || platform() === "win32") {
      // 这些平台路径不走 XDG，可能写到真实用户目录——不做破坏性断言，仅验证返回文本合理。
      expect(v1).toMatch(/VSCode|Shift\+Enter|keybindings/);
      return;
    }

    // linux/other：应真实写入临时目录。
    expect(v1).toContain("已为");
    const { existsSync, readFileSync } = require("fs");
    const p = getVSCodeKeybindingsPath({ label: "VSCode", configDir: "Code" });
    expect(p.startsWith(tmp)).toBe(true);
    expect(existsSync(p)).toBe(true);
    const parsed = parseJSONC(readFileSync(p, "utf-8")) as any[];
    expect(parsed.some((b) => b.key === "shift+enter")).toBe(true);

    // 幂等：再跑一次应提示已存在、不重复。
    const res2 = await mod.call("", {} as CommandContext);
    expect((res2 as any).value).toContain("已存在");
    const parsed2 = parseJSONC(readFileSync(p, "utf-8")) as any[];
    expect(parsed2.filter((b) => b.key === "shift+enter").length).toBe(1);
  });
});
