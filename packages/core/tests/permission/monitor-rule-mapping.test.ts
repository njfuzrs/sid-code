/**
 * T-M1-19：monitor 的 `command` 按 **bash 的规则口径**判定，但审计要能区分来源。
 *
 * 方案 §5.4.6 的验收有两条，此前一条都没锁：
 *   ① `Bash(...)` 的 deny 规则对 monitor 同样生效（不是"只对 bash 生效"的旁路）；
 *   ② `PermissionDecision` 事件里 `tool` 记 `monitor`、`effectiveTool` 记 `bash`。
 *
 * 为什么需要 `effectiveTool`：只有 `tool` 时，轨迹上「monitor 继承 bash 规则放行」与
 * 「bash 自己被放行」长得一模一样——查「这条 allow 是不是继承来的」查不出来。
 * 两个字段的分工：`tool` = 谁发起的，`effectiveTool` = 按谁的规则算的。
 *
 * 断言口径直接来自 `checker.ts` 的 `bashTelemetryMetadata`（monitor 分支只写这一个
 * 字段，不继承 `bashShape` / `envPrefixVars`——那是 bash 工具自己的统计分母）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PermissionChecker } from "../../src/permission/checker.ts";
import { SandboxManager } from "../../src/permission/sandbox.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { setFlagSettings } from "../../src/config/settings/settings.ts";
import { decisionFactsOf } from "../../src/permission/decision-telemetry.ts";

let sidHome: string;
let prevSidConfigDir: string | undefined;
let cwd: string;

beforeEach(() => {
  sidHome = mkdtempSync(join(tmpdir(), "monitor-rules-"));
  // 存/恢复原值：同批多文件跑在同一进程里，无条件 delete 会抹掉 preload 兜底
  prevSidConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = sidHome;
  cwd = mkdtempSync(join(tmpdir(), "monitor-rules-cwd-"));
});

afterEach(() => {
  setFlagSettings(null);
  if (prevSidConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidConfigDir;
  rmSync(sidHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** 沙箱自动放行关掉：本用例只验规则口径，不掺 Step 7（D5 已单独锁过）。 */
function noAutoAllow(): SandboxManager {
  return { shouldAutoAllowBash: () => false } as unknown as SandboxManager;
}

describe("T-M1-19：monitor 走 bash 规则口径", () => {
  /**
   * ① deny 规则对 monitor 生效。
   * 修前若 `commandRuleRequest` 没把 monitor 的规则视角换成 bash，这条会 allowed=true。
   */
  test("Bash(gh:*) 的 deny 规则同样拦 monitor", async () => {
    setFlagSettings({ permissions: { deny: ["Bash(gh:*)"] } } as any);
    const checker = new PermissionChecker(defaultConfig(), undefined, cwd);
    checker.setSandboxManager(noAutoAllow());
    await checker.initRules();

    const d = await checker.check({ toolName: "monitor", input: { command: "gh pr checks 662" } });
    expect(d.allowed).toBe(false);
    // 规则拒绝是硬拒，不是「弹确认」——与 bash 的 deny 语义一致
    expect(d.needsConfirmation).toBeFalsy();
    expect(d.decisionReason?.type).toBe("rule");
  });

  /** 对照组：同一条命令下 bash 也被同一条规则拦（确认收窄不是只对 monitor 生效）。 */
  test("对照组：同一条 deny 规则下 bash 同样被拒", async () => {
    setFlagSettings({ permissions: { deny: ["Bash(gh:*)"] } } as any);
    const checker = new PermissionChecker(defaultConfig(), undefined, cwd);
    checker.setSandboxManager(noAutoAllow());
    await checker.initRules();

    const d = await checker.check({ toolName: "bash", input: { command: "gh pr checks 662" } });
    expect(d.allowed).toBe(false);
    expect(d.decisionReason?.type).toBe("rule");
  });

  /**
   * ② allow 规则放行时，决策事件的两个字段必须分工明确。
   * 这是 `effectiveTool` 字段的**唯一**主断言：没有它这条改动就等于没做。
   */
  test("allow 规则放行 monitor 时，事件 tool=monitor、effectiveTool=bash", async () => {
    setFlagSettings({ permissions: { allow: ["Bash(gh pr checks:*)"] } } as any);
    const checker = new PermissionChecker(defaultConfig(), undefined, cwd);
    checker.setSandboxManager(noAutoAllow());
    await checker.initRules();

    const d = await checker.check({ toolName: "monitor", input: { command: "gh pr checks 662" } });
    expect(d.allowed).toBe(true);
    expect(d.decisionReason?.type).toBe("rule");
    // 决策 metadata 上有标签
    expect((d.metadata as Record<string, unknown> | undefined)?.effectiveTool).toBe("bash");
    // `decisionFactsOf` 是决策 → `PermissionDecision` 事件的唯一桥梁（7 个调用点全部
    // spread 它的返回值），所以断言它就等价于断言事件字段，且不依赖工具执行链。
    expect(decisionFactsOf(d).effectiveTool).toBe("bash");
    // 不继承 bash 工具自己的统计字段（否则 bash 的确认分布分母被 monitor 污染）
    expect(decisionFactsOf(d).bashShape).toBeUndefined();
    expect(decisionFactsOf(d).envPrefixVars).toBeUndefined();
  });

  /**
   * 对照组：bash 自己的决策**不带** `effectiveTool`。
   * 语义是「缺失 = 与 tool 同口径」；若给 bash 也标 `effectiveTool: "bash"`，
   * 这个字段就退化成恒真，失去了「区分继承」的作用。
   */
  test("对照组：bash 自己的决策不带 effectiveTool", async () => {
    setFlagSettings({ permissions: { allow: ["Bash(gh pr checks:*)"] } } as any);
    const checker = new PermissionChecker(defaultConfig(), undefined, cwd);
    checker.setSandboxManager(noAutoAllow());
    await checker.initRules();

    const d = await checker.check({ toolName: "bash", input: { command: "gh pr checks 662" } });
    expect(d.allowed).toBe(true);
    expect((d.metadata as Record<string, unknown> | undefined)?.effectiveTool).toBeUndefined();
    expect(decisionFactsOf(d).effectiveTool).toBeUndefined();
  });

  /** 非命令语义工具不落这个字段（read 的路径确认与「按谁的规则」无关）。 */
  test("对照：read 的决策不带 effectiveTool", async () => {
    const checker = new PermissionChecker(defaultConfig(), undefined, cwd);
    checker.setSandboxManager(noAutoAllow());
    await checker.initRules();

    const d = await checker.check({ toolName: "read", input: { file_path: join(cwd, "a.txt") } });
    expect((d.metadata as Record<string, unknown> | undefined)?.effectiveTool).toBeUndefined();
  });
});
