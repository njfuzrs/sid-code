/**
 * /lsp 命令 + LSP 模式门控（D15 零生产调用 / D16 无形态门控）
 *
 * D15 的性质值得记在测试里：`reinitializeLSP()` **实现完全正确**
 * （关旧实例 → 清 registry → initGeneration++ → 重新初始化），
 * 注释还写着「插件刷新时调用」—— 但生产调用点是 **0**，而本该触发它的
 * `/reload-plugins` 完全不碰 LSP。这是「死接线」的第三种形态：
 * **实现正确 + 注释声明了调用场景 + 零调用方**。
 *
 * 读代码的人不会从注释里发现问题，因为注释描述的是一个**未完成的计划**，
 * 它读起来完全正常。所以这里的门禁判据是**"有没有真实调用方"**，
 * 而不是"函数行为对不对"（后者本来就一直是对的）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { LSPCommand } from "@sid-code/cli/command/lsp.ts";
import type { AppContext } from "@sid-code/cli/command/types.ts";
import { initializeLSP, getLSPInitState, resetLSPForTest } from "@sid-code/core/lsp/manager.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");

/** /lsp 的两个子命令都不读 ctx，给一个最小壳即可 */
function ctx(): AppContext {
  return {} as unknown as AppContext;
}

function readSrc(rel: string): string {
  return readFileSync(join(REPO, rel), "utf-8");
}

/** 剥注释：本仓有过"我写的注释骗过了我写的门禁"的教训 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

afterEach(() => {
  resetLSPForTest();
});

describe("D15 · reinitializeLSP 有真实调用方", () => {
  test("门禁：src 里存在 reinitializeLSP 的生产调用点（不含定义与测试）", () => {
    // 这条断言直接对着 D15 的实证命令：修复前它的结果是 0 行。
    const callers = [
      "packages/cli/src/command/lsp.ts",
      "packages/cli/src/command/plugin.ts",
    ].filter((f) => stripComments(readSrc(f)).includes("reinitializeLSP"));

    expect(callers.length).toBeGreaterThan(0);
    // 专门的入口必须存在 —— 只挂在 /reload-plugins 上等于让用户猜：
    // 触发重载的真实场景是"我刚改了 lsp.json"，不是"我刚装了插件"。
    expect(callers).toContain("packages/cli/src/command/lsp.ts");
  });

  test("/lsp 命令已注册进 builtins", () => {
    const code = stripComments(readSrc("packages/cli/src/command/builtins.ts"));
    expect(code).toContain("LSPCommand");
    expect(code).toContain("registry.register(new LSPCommand())");
  });

  test("/reload-plugins 也会重载 LSP（插件可能带来新语言/文件）", () => {
    const code = stripComments(readSrc("packages/cli/src/command/plugin.ts"));
    expect(code).toContain("reinitializeLSP");
    // 必须先判 initState：未启动时 reinitializeLSP 是空操作，
    // 但打出"LSP 配置已重载"会是假消息。
    expect(code).toContain("getLSPInitState()");
  });
});

describe("/lsp 命令行为", () => {
  test("name/description/子命令齐全", () => {
    const cmd = new LSPCommand();
    expect(cmd.name()).toBe("lsp");
    const subs = cmd.subCommands().map((c) => c.name());
    expect(subs).toEqual(["status", "reload"]);
  });

  test("未启动时 status 解释「为什么没启动」而不是报错", async () => {
    resetLSPForTest();
    expect(getLSPInitState()).toBe("not-started");

    const r = await new LSPCommand().execute("", ctx());
    expect(r.kind).toBe("message");
    const msg = (r as { message: string }).message;
    // 关键：not-started 不是异常。不说清楚会让用户以为 LSP 坏了。
    expect(msg).toContain("未启动");
    expect(msg).toContain("--print");
    expect(msg).toContain("Bridge");
  });

  test("未启动时 reload 明确说明是空操作，而不是假装重载了", async () => {
    resetLSPForTest();
    const reload = new LSPCommand().subCommands().find((c) => c.name() === "reload")!;

    const r = await reload.execute("", ctx());
    const msg = (r as { message: string }).message;
    expect(msg).toContain("无需重载");
    // 用户敲了命令却什么都没发生会很困惑 —— 必须给出原因
    expect(msg).toContain("交互式");
  });

  test("已初始化后 reload 真的走到重新初始化（不是空操作）", async () => {
    // 无 LSP 配置的目录：initializeLSP 会立即落到 success（"无配置也算成功"）
    initializeLSP("/nonexistent-workspace-for-lsp-reload-test");
    await new Promise((r) => setTimeout(r, 50));
    expect(getLSPInitState()).not.toBe("not-started");

    const reload = new LSPCommand().subCommands().find((c) => c.name() === "reload")!;
    const r = await reload.execute("", ctx());
    const msg = (r as { message: string }).message;

    expect(r.kind).toBe("message");
    // 走到了真实重载分支（而非 not-started 的早退分支）
    expect(msg).not.toContain("无需重载");
    expect(msg).toContain("配置来源");
  });

  test("status 在已初始化时报告服务器数量", async () => {
    initializeLSP("/nonexistent-workspace-for-lsp-status-test");
    await new Promise((r) => setTimeout(r, 50));

    const r = await new LSPCommand().execute("", ctx());
    const msg = (r as { message: string }).message;
    expect(msg).toContain("LSP 代码智能状态");
    expect(msg).not.toContain("未启动");
  });
});

describe("D16 · 按运行形态门控 LSP 初始化", () => {
  test("cli.ts 里 initializeLSP 被 print / bridgeUrl 门控", () => {
    const code = stripComments(readSrc("packages/cli/src/cli.ts"));

    // 判据落在"门控变量存在且两种形态都被枚举"，而不是匹配某个具体的 if 写法 ——
    // 后者会在无害重构时误红。
    expect(code).toContain("lspSkipReason");
    expect(code).toMatch(/lspSkipReason\s*=\s*config\.print/);
    expect(code).toContain("cliArgs.bridgeUrl");

    // initializeLSP 必须在门控之后 —— 若有人把调用挪到 if 外面，这条会红。
    const gateIdx = code.indexOf("lspSkipReason");
    const callIdx = code.indexOf("initializeLSP(process.cwd())");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(gateIdx);
  });

  test("LSP 工具仍然注册（门控的是初始化，不是能力）", () => {
    // 门控不该把 LSP 工具从 registry 里摘掉：真被调用时 manager 走降级路径，
    // 而不是"工具不存在"这种更难解释的失败。
    const code = stripComments(readSrc("packages/cli/src/cli.ts"));
    expect(code).not.toContain("if (!config.print) registerLSPTools");
  });
});
