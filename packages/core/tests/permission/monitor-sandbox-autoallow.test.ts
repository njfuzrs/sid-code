/**
 * FIX-1 / D5：沙箱「自动放行」不得覆盖 monitor（2026-11-09）。
 *
 * 根因：Step 7 的条件是 `isCommandSemanticsRequest(req)`，带 command 的 monitor 也被算作
 * 「命令语义请求」，连带继承了「沙箱保护下自动放行」。但这一步的正当性来自
 * 「命令会被 `sandboxManager.wrapCommand` 包裹后执行」（`tool/bash.ts` 两处），而 monitor
 * 的子进程是裸 spawn（`task/monitor-task.ts`），不在沙箱里——决策日志因此声称了一个
 * 不存在的保护，模型与用户都会以为它受沙箱约束。
 *
 * 测试用**假 sandboxManager**（`shouldAutoAllowBash` 恒 true）而不是真 `SandboxManager`：
 * 后者在非 darwin 上 `isEnabled()` 恒 false，条件永远不成立，用例会在 CI 的 ubuntu 上
 * 退化成一条空断言却仍然全绿。checker 对 sandboxManager 只读 `shouldAutoAllowBash()`
 * 这一个方法（grep 核过，另外只有 trace 字段读一次），鸭子类型足够。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PermissionChecker } from "../../src/permission/checker.ts";
import { SandboxManager } from "../../src/permission/sandbox.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { setFlagSettings } from "../../src/config/settings/settings.ts";

let sidHome: string;
let prevSidConfigDir: string | undefined;
let cwd: string;

beforeEach(() => {
  sidHome = mkdtempSync(join(tmpdir(), "monitor-sbx-"));
  // 存原值再改：bun test 同批多文件跑在同一进程里，无条件 delete 会抹掉 preload 兜底
  prevSidConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = sidHome;
  cwd = mkdtempSync(join(tmpdir(), "monitor-sbx-cwd-"));
});

afterEach(() => {
  setFlagSettings(null);
  if (prevSidConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidConfigDir;
  rmSync(sidHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** Step 7 的判据只有 `shouldAutoAllowBash()` 一个方法，按鸭子类型注入即可。 */
function autoAllowSandbox(): SandboxManager {
  return { shouldAutoAllowBash: () => true } as unknown as SandboxManager;
}

describe("D5：monitor 不享受沙箱自动放行", () => {
  /**
   * 主回归。修前 `allowed === true` 且理由恰是下文断言的那句话；
   * 修后 monitor 落到 Step 14 的 ask，与「沙箱关闭」时同口径。
   */
  test("opt-in 开启时 monitor 是 ask，理由不是「沙箱保护下自动放行」", async () => {
    const checker = new PermissionChecker(defaultConfig(), undefined, cwd);
    checker.setSandboxManager(autoAllowSandbox());

    const d = await checker.check({ toolName: "monitor", input: { command: "gh pr checks 662" } });
    expect(d.allowed).toBe(false);
    expect(d.needsConfirmation).toBe(true);
    // decisionReason 是联合类型，只有部分分支带 reason —— 只断言「不是那句放行理由」
    expect((d.decisionReason as { reason?: string } | undefined)?.reason ?? "").not.toBe(
      "沙箱保护下自动放行",
    );
    // 明确没在 Step 7 被放行（step 是 decision 上的诊断字段）
    expect(d.step).not.toBe("7");
  });

  /**
   * 对照组：bash 的原行为必须原样保留，否则这次收窄就成了「把沙箱自动放行整个关掉」。
   * 命令用与 monitor 完全相同的那条，锁住「同样的命令，bash 走沙箱、monitor 不走」。
   */
  test("同一条件下 bash 仍被沙箱自动放行（原行为不受影响）", async () => {
    const checker = new PermissionChecker(defaultConfig(), undefined, cwd);
    checker.setSandboxManager(autoAllowSandbox());

    const d = await checker.check({ toolName: "bash", input: { command: "gh pr checks 662" } });
    expect(d.allowed).toBe(true);
    expect(d.decisionReason).toEqual({ type: "other", reason: "沙箱保护下自动放行" });
  });

  /**
   * 规则匹配不受影响：monitor 仍按 bash 的规则名匹配（`commandRuleRequest` 那条路径）。
   * 这是 FIX-1 最容易误伤的地方——收窄 Step 7 时若顺手动了
   * `isCommandSemanticsRequest`，这里会红。
   */
  test("有 Bash(gh pr checks:*) allow 规则时 monitor 仍按规则放行", async () => {
    setFlagSettings({ permissions: { allow: ["Bash(gh pr checks:*)"] } } as any);
    const checker = new PermissionChecker(defaultConfig(), undefined, cwd);
    checker.setSandboxManager(autoAllowSandbox());
    await checker.initRules();

    const d = await checker.check({ toolName: "monitor", input: { command: "gh pr checks 662" } });
    expect(d.allowed).toBe(true);
    expect(d.decisionReason?.type).toBe("rule");
  });

  /** 沙箱自动放行关着时，monitor 的判定不变（收窄只影响 opt-in 那一支）。 */
  test("沙箱不放行时 monitor 仍是 ask", async () => {
    const checker = new PermissionChecker(defaultConfig(), undefined, cwd);
    checker.setSandboxManager({
      shouldAutoAllowBash: () => false,
    } as unknown as SandboxManager);

    const d = await checker.check({ toolName: "monitor", input: { command: "gh pr checks 662" } });
    expect(d.allowed).toBe(false);
    expect(d.needsConfirmation).toBe(true);
  });
});

/**
 * 反漂移守卫：读源码文本，断言**每一个**以 `shouldAutoAllowBash()` 为条件的放行分支都
 * 显式比较 `toolName === "bash"`。
 *
 * 断言写在条件表达式上，不写在注释上——注释里写「仅 bash」不产生任何约束
 * （本仓有「注释记成资产」的前科）。注释行在筛选时先排除，防止有人把条件文本
 * 复制进注释让守卫假绿。
 */
describe("反漂移：沙箱自动放行只对 bash 生效", () => {
  test('checker.ts 里每个 shouldAutoAllowBash() 放行条件都显式限定 toolName === "bash"', () => {
    const src = readFileSync(join(import.meta.dir, "../../src/permission/checker.ts"), "utf8");
    const gates = src.split("\n").filter((line) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
      return /\bif\s*\(/.test(t) && t.includes("shouldAutoAllowBash()");
    });
    // 守卫自身也要有靶子：条件被挪走/删掉时这条先红，而不是悄悄变成空断言
    expect(gates.length).toBeGreaterThan(0);
    for (const line of gates) {
      expect(line).toMatch(/toolName\s*===\s*"bash"/);
    }
  });
});
