/**
 * D4/D5/D6 的防回归门禁
 *
 * 三条缺陷性质不同，测法也不同 —— 每条都注明「红的是哪一条」：
 *
 * - **D4**（子代理诊断注入是裸 `#` 标题）：这段文案是内嵌在 agentic-loop 循环里的字符串，
 *   没有可单独调用的函数，跑一遍真实子代理循环只为断言一句文案不划算。故用**源码静态
 *   扫描**：直接读 `agent/agentic-loop.ts`，断言注入块带围栏、带「非用户输入」、
 *   不以 `#` 开头。这是刻意选的能力边界 —— 它锁的是**文案形态**，不是"注入真的发生了"
 *   （后者由既有的子代理诊断注入路径覆盖）。
 *   ⚠️ 静态扫描的已知风险是"读注释不读代码"，所以下面的断言先剥掉注释行再匹配。
 *
 * - **D5**（零 server 时 lsp 工具仍常驻）：判据被提成纯函数 `lspToolEnabledFor`，
 *   用例穷举它；`isEnabled()` 只用一条"与判据同结论"的一致性断言守接线。
 *   为什么不直接测 `isEnabled()` 的零服务器分支，见该 describe 上方的实测教训。
 *
 * - **D6**（lsp.json 配置错误用户不可见）：`loadLSPConfigs` 返回结构里带 errors，
 *   `getLSPHealthWarning()` 把它并入已有的一次性告警通道 —— 两段都测。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadLSPConfigs } from "@sid-code/core/lsp/config.ts";
import { LSPTool, lspToolEnabledFor } from "@sid-code/core/tool/lsp.ts";
import { resetLSPForTest, getLSPInitState } from "@sid-code/core/lsp/manager.ts";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../src");

// ─────────────────────────────────────────────────────────────────────────────
// D4：子代理 LSP 诊断注入的形态
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 取出 agentic-loop.ts 里 LSP 诊断注入那段的**代码**（剥掉注释行）。
 *
 * 剥注释是必须的：这个文件的注释里就写着 `# LSP 诊断…`（讲述原文案错在哪），
 * 不剥的话「不含 `# LSP 诊断`」这条断言会命中注释而恒红，
 * 而修正它的第一直觉往往是删断言 —— 那就把门禁做成了摆设。
 */
function agenticLoopInjectionCode(): string {
  const raw = readFileSync(join(SRC_ROOT, "agent/agentic-loop.ts"), "utf-8");
  const codeOnly = raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
  // 注入块从 collectDiagnosticText 调用起，到该 try 块结束
  const start = codeOnly.indexOf("collectDiagnosticText(editedFiles)");
  expect(start).toBeGreaterThan(0); // 前提成立：注入点还在（改名/删除时这里先红）
  const end = codeOnly.indexOf("注入 LSP 诊断反馈（子代理）", start);
  expect(end).toBeGreaterThan(start);
  return codeOnly.slice(start, end);
}

describe("D4：子代理 LSP 诊断注入必须带围栏，不得是裸 markdown 标题", () => {
  /**
   * 事故防回归（2026-07-29「模型分不清谁在说话」的三处裸注入之一）。
   *
   * 子代理这一处比主循环更需要围栏：它走 ctxMgr.addMessage({role:"user"})，
   * 注入的是一条**真正的 user 消息**，形态上与用户输入无法区分。
   */
  test("带 <system-reminder> 围栏 + 「非用户输入」声明", () => {
    const code = agenticLoopInjectionCode();
    expect(code).toContain("<system-reminder>");
    expect(code).toContain("</system-reminder>");
    expect(code).toContain("非用户输入");
  });

  test("不以 `#` markdown 标题开头（与用户 prompt 的 `# Commit:` 混同的直接诱因）", () => {
    const code = agenticLoopInjectionCode();
    expect(code).not.toContain("`# LSP 诊断");
  });

  test("与主循环（query/loop.ts）文案同源：两处围栏与声明一致", () => {
    const sub = agenticLoopInjectionCode();
    const main = readFileSync(join(SRC_ROOT, "query/loop.ts"), "utf-8");
    // 主循环那句是本项目的事故后正确形态，子代理必须与它同口径
    const canonical = "LSP 诊断（来自语言服务器的实时反馈，非用户输入）：";
    expect(main).toContain(canonical);
    expect(sub).toContain(canonical);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D5：零 language server 时 lsp 工具不应常驻上下文
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ 这一组**刻意不直接测 `isEnabled()` 的零服务器分支**，而是测它调用的纯函数判据。
 *
 * 教训来自本次实测：`isEnabled()` 的结论取决于"这台机器装了几个 language server"，
 * 而首版用例写成 `if (state === "success") { expect(...) }`，在本机（PATH 里有 5 个
 * server，且 `initializeLSP` 落地后 count=5）那个分支**从不进入** —— 用例绿着，
 * 一条断言都没跑。把 PATH 清空也不管用：`which` 会回落到系统默认路径，实测仍是 5 个。
 *
 * 所以拆成两半：判据用纯函数穷举（确定），接线用一致性断言守（不依赖机器环境）。
 */
describe("D5：lsp 工具的启用判据需附加「有服务器」", () => {
  beforeEach(() => resetLSPForTest());
  afterEach(() => resetLSPForTest());

  test("not-started（LSP 从未初始化）→ 不启用", () => {
    expect(getLSPInitState()).toBe("not-started");
    expect(lspToolEnabledFor("not-started", 0)).toBe(false);
    expect(new LSPTool().isEnabled()).toBe(false);
  });

  /**
   * D5 的核心用例：manager 里「无配置也算成功」，所以一台没装任何 language server
   * 的机器上 initState 同样是 success。仅凭 initState 放行会让工具每轮白占一份工具定义
   * 的上下文，且模型拿到的是一个**一调用就必然失败**的工具（getServerForFile 未命中）。
   */
  test("success 但零服务器 → 不启用（守 D5）", () => {
    expect(lspToolEnabledFor("success", 0)).toBe(false);
  });

  test("success 且有服务器 → 启用", () => {
    expect(lspToolEnabledFor("success", 1)).toBe(true);
    expect(lspToolEnabledFor("success", 7)).toBe(true);
  });

  /**
   * 放行 pending 是**刻意的**（"早可见"语义，真正的就绪由 execute 的 waitForLSPReady 兜底）。
   * 锁住它，防止修 D5 时顺手把 pending 一起关掉。
   */
  test("pending 一律放行（早可见语义，别改）", () => {
    expect(lspToolEnabledFor("pending", 0)).toBe(true);
    expect(lspToolEnabledFor("pending", 3)).toBe(true);
  });

  test("failed → 不启用", () => {
    expect(lspToolEnabledFor("failed", 0)).toBe(false);
    expect(lspToolEnabledFor("failed", 5)).toBe(false); // 有实例也不放行
  });

  /**
   * 接线：判据必须真的被 `isEnabled()` 用上。
   *
   * ⚠️ 这条**不能**写成"isEnabled() 与 lspToolEnabledFor(真实状态) 同结论" ——
   * 在装了 server 的机器上 `success && 5>0` 恒等于 `success`，把判据整个摘掉那种写法
   * 照样全绿（实测确认过，是本次第二个被抓到的假门禁）。所以这里覆写门控输入的读取点，
   * 确定地构造出只有接了判据才会关闭的状态。
   */
  test("isEnabled() 真的用了判据：success + 零服务器时必须关闭（守接线）", () => {
    class ZeroServerLSPTool extends LSPTool {
      protected override readGateInputs() {
        return { initState: "success", serverCount: 0 };
      }
    }
    expect(new ZeroServerLSPTool().isEnabled()).toBe(false);
  });

  test("isEnabled() 在 success + 有服务器时开启（同一读取点的对照组）", () => {
    class HasServerLSPTool extends LSPTool {
      protected override readGateInputs() {
        return { initState: "success", serverCount: 2 };
      }
    }
    expect(new HasServerLSPTool().isEnabled()).toBe(true);
  });

  test("读取点抛错时降级为不启用（不得把异常抛进工具组装）", () => {
    class ThrowingLSPTool extends LSPTool {
      protected override readGateInputs(): { initState: string; serverCount: number } {
        throw new Error("manager 未加载");
      }
    }
    expect(new ThrowingLSPTool().isEnabled()).toBe(false);
  });

  test("getLSPServerCount 在无实例时返回 0，不抛", () => {
    const { getLSPServerCount } = require("@sid-code/core/lsp/manager.ts");
    expect(getLSPServerCount()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D6：lsp.json 配置错误必须对用户可见
// ─────────────────────────────────────────────────────────────────────────────

describe("D6：lsp.json 配置错误接进用户可见的健康告警通道", () => {
  let workspace: string;
  const originalConfigDir = process.env.SID_CONFIG_DIR;

  beforeEach(() => {
    // 落盘隔离：全局 lsp.json 走 sidPaths.lspConfig()，必须重定向到 tmpdir，
    // 否则会读到（甚至污染）运行者真实的 ~/.sid-code/
    process.env.SID_CONFIG_DIR = mkdtempSync(join(tmpdir(), "sid-lsp-d6-home-"));
    workspace = mkdtempSync(join(tmpdir(), "sid-lsp-d6-ws-"));
    mkdirSync(join(workspace, ".sid-code"), { recursive: true });
    resetLSPForTest();
  });

  afterEach(() => {
    // 存/恢复原值而不是无条件 delete：同批测试跑在同一进程里，
    // 直接删会把 preload 的兜底隔离一起抹掉。
    if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = originalConfigDir;
    rmSync(workspace, { recursive: true, force: true });
    resetLSPForTest();
  });

  test("合法配置 → errors 为空", async () => {
    writeFileSync(
      join(workspace, ".sid-code", "lsp.json"),
      JSON.stringify({ mysrv: { command: "mysrv-bin", extensionToLanguage: { ".foo": "foo" } } }),
    );
    const { configs, errors } = await loadLSPConfigs(workspace);
    expect(errors).toEqual([]);
    expect(configs.mysrv?.command).toBe("mysrv-bin");
  });

  test("JSON 语法错误 → errors 里明说「整个文件都没生效」（守 D6）", async () => {
    // 多一个逗号，正是文档里那个真实场景
    writeFileSync(join(workspace, ".sid-code", "lsp.json"), '{"a":{"command":"x"},}');
    const { errors } = await loadLSPConfigs(workspace);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("lsp.json");
    // 只给 err.message 时用户容易以为"只错了一条"，必须点破实际后果
    expect(errors[0]).toContain("全部 LSP 配置已忽略");
  });

  test("缺 command / extensionToLanguage → 该条被跳过且计入 errors", async () => {
    writeFileSync(
      join(workspace, ".sid-code", "lsp.json"),
      JSON.stringify({
        good: { command: "g", extensionToLanguage: { ".g": "g" } },
        noCommand: { extensionToLanguage: { ".x": "x" } },
        noExt: { command: "y" },
      }),
    );
    const { configs, errors } = await loadLSPConfigs(workspace);
    expect(configs.good).toBeDefined();
    expect(configs.noCommand).toBeUndefined();
    expect(configs.noExt).toBeUndefined();
    expect(errors.length).toBe(2);
    expect(errors.join("\n")).toContain("noCommand");
    expect(errors.join("\n")).toContain("noExt");
  });

  test("配置错误进入 getLSPHealthWarning() —— 即用户首轮就能看到", async () => {
    writeFileSync(join(workspace, ".sid-code", "lsp.json"), "{ not json at all");
    const manager = require("@sid-code/core/lsp/manager.ts");
    manager.initializeLSP(workspace);
    // 等异步 loadLSPConfigs 落地
    for (let i = 0; i < 100 && manager.getLSPConfigErrors().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(manager.getLSPConfigErrors().length).toBeGreaterThan(0);
    const warning = manager.getLSPHealthWarning();
    expect(warning).not.toBeNull();
    expect(warning).toContain("LSP 配置");
  });

  test("resetLSPForTest / shutdown 会清空配置错误（不跨会话残留旧告警）", async () => {
    writeFileSync(join(workspace, ".sid-code", "lsp.json"), "{ broken");
    const manager = require("@sid-code/core/lsp/manager.ts");
    manager.initializeLSP(workspace);
    for (let i = 0; i < 100 && manager.getLSPConfigErrors().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(manager.getLSPConfigErrors().length).toBeGreaterThan(0);
    resetLSPForTest();
    expect(manager.getLSPConfigErrors()).toEqual([]);
    expect(manager.getLSPHealthWarning()).toBeNull();
  });
});
