/**
 * A1（2026-11-03 会话 3b4f9ca7 复盘）：skip 档主会话派生的子代理，
 * 「工作区外的非敏感路径」不应比主会话更严。
 *
 * 缺陷形态：主会话 `--dangerously-skip-permissions` 对工作区外零校验；子代理却因为
 * `always-allow` 的放行在 Step 8，而 Step 4（路径校验）排在它之前，同一位置被拒。
 * 轨迹证据：4 个子代理 33 次拒绝里 10 次 `读取路径在工作区外`、1 次 `/tmp` 写入，
 * 主会话整场 0 次拒绝。
 *
 * 修法边界（每条都有对应断言，缺一条就可能把「放宽」做成「开洞」）：
 *   - 只放开 `outsideWorkingDirs`（工作区外非敏感），sensitiveFile 仍是硬 deny；
 *   - 放行后照常过 Step 6 safetyCheck（`.git/hooks` 仍拦）；
 *   - 非 skip 档（always-allow / default / dontAsk）行为不变；
 *   - 主会话切档后已下发的子代理立即跟随（live config，不是快照）。
 *
 * ⚠ 落盘隔离：PermissionChecker 构造 AuditLogger，后者无条件 mkdirSync(sidPaths.logs())，
 * 必须重定向 SID_CONFIG_DIR；恢复时存/恢复原值而非无条件 delete。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { createSubAgentChecker } from "@sid-code/core/permission/sub-agent-checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";

let configRoot: string;
/** 工作区（子代理 checker 的 workspacePath） */
let workspace: string;
/** 工作区外目录 —— 本文件所有「区外」断言的目标都落在这里 */
let outside: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-subagent-skip-cfg-"));
  // 用 realpath 派生：macOS 上 /var → /private/var，两种写法不同源会让
  // isWithinWorkingDirectories 判在工作区外（见 read-outside-working-dirs.test.ts 头注释）
  const base = mkdtempSync(join(tmpdir(), "sid-subagent-skip-"));
  workspace = join(base, "ws");
  outside = join(base, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "evidence.ts"), "// 工作区外的源码");
  writeFileSync(join(outside, ".env"), "SECRET=1");
  mkdirSync(join(outside, ".ssh"), { recursive: true });
  writeFileSync(join(outside, ".ssh", "id_rsa"), "PRIVATE");
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(join(workspace, ".."), { recursive: true, force: true });
});

/** 造主 checker；返回 cfg 引用供「切档」测试直接改（App 与主 checker 共享同一引用） */
function makeMain(overrides: Partial<Config>): { main: PermissionChecker; cfg: Config } {
  const cfg = { ...defaultConfig(), ...overrides } as Config;
  return { main: new PermissionChecker(cfg, { allow: [], deny: [], ask: [] }, workspace), cfg };
}

const SKIP_MODE = {
  skipPermissions: true,
  permissionMode: "dangerously-skip-permissions",
} as const;

// 必须是函数而不是顶层常量：outside 在 beforeEach 里才赋值，顶层求值会拿到 undefined
const readOutside = () => ({
  toolName: "read",
  input: { file_path: join(outside, "evidence.ts") },
});
const writeOutside = () => ({
  toolName: "write",
  input: { file_path: join(outside, "note.txt"), content: "x" },
});

describe("A1 — skip 档子代理读/写工作区外的非敏感路径", () => {
  test("read 工作区外普通文件 → 放行，且 decisionReason.via 标出这条口子", async () => {
    const { main } = makeMain(SKIP_MODE);
    const sub = createSubAgentChecker(main, workspace, { inheritBypassMode: true });
    const decision = await sub.check(readOutside());
    expect(decision.allowed).toBe(true);
    // 埋点是本条的验收核心之一：混进普通 always-allow 就再也统计不到它被用了多少次
    expect(decision.decisionReason).toMatchObject({
      type: "mode",
      mode: "always-allow",
      via: "skip-inherit-outside-workdir",
    });
  });

  test("write 工作区外普通文件 → 放行（主会话 skip 档本来就允许写区外）", async () => {
    const { main } = makeMain(SKIP_MODE);
    const sub = createSubAgentChecker(main, workspace, { inheritBypassMode: true });
    expect((await sub.check(writeOutside())).allowed).toBe(true);
  });

  test("敏感文件不受影响：工作区外的 .env / .ssh/id_rsa 仍硬 deny", async () => {
    const { main } = makeMain(SKIP_MODE);
    const sub = createSubAgentChecker(main, workspace, { inheritBypassMode: true });
    for (const target of [join(outside, ".env"), join(outside, ".ssh", "id_rsa")]) {
      const decision = await sub.check({ toolName: "read", input: { file_path: target } });
      expect(decision.allowed).toBe(false);
      // 敏感文件走的是 pathValidator 的硬 deny 分支（不带 outsideWorkingDirs），
      // 所以不该沾上 skip 继承的埋点
      expect(decision.decisionReason?.type).toBe("pathValidation");
    }
  });

  test("safetyCheck 仍然生效：写工作区外的 .git/hooks/pre-commit 仍被拦", async () => {
    const { main } = makeMain(SKIP_MODE);
    const sub = createSubAgentChecker(main, workspace, { inheritBypassMode: true });
    const hooks = join(outside, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    const decision = await sub.check({
      toolName: "write",
      input: { file_path: join(hooks, "pre-commit"), content: "#!/bin/sh\n" },
    });
    expect(decision.allowed).toBe(false);
    // Step 6 排在 Step 8 之前，放行必须止步于此
    expect(decision.decisionReason?.type).toBe("safetyCheck");
  });
});

describe("A1 — 非 skip 档行为不变（放宽只对 skip 派生实例生效）", () => {
  test("always-allow 主会话：子代理读工作区外仍 deny，且不带 skip 埋点", async () => {
    const { main } = makeMain({ permissionMode: "always-allow" });
    const sub = createSubAgentChecker(main, workspace, { inheritBypassMode: true });
    const decision = await sub.check(readOutside());
    expect(decision.allowed).toBe(false);
    expect((decision.decisionReason as { via?: string } | undefined)?.via).not.toBe(
      "skip-inherit-outside-workdir",
    );
  });

  test("default 主会话：子代理降为 dontAsk，读工作区外仍 deny", async () => {
    const { main } = makeMain({ permissionMode: "default" });
    const sub = createSubAgentChecker(main, workspace, { inheritBypassMode: true });
    expect(sub.getConfig().permissionMode).toBe("dontAsk");
    expect((await sub.check(readOutside())).allowed).toBe(false);
  });

  test("skip 档但未开启 inheritBypassMode：维持 dontAsk，读工作区外仍 deny", async () => {
    const { main } = makeMain(SKIP_MODE);
    const sub = createSubAgentChecker(main, workspace);
    expect(sub.getConfig().inheritedFromSkip).toBe(false);
    expect((await sub.check(readOutside())).allowed).toBe(false);
  });
});

describe("A1 — 主会话切档后子代理立即跟随（live config 的既有保证）", () => {
  test("skip → default：已下发的子代理恢复拦截工作区外读取", async () => {
    const { main, cfg } = makeMain(SKIP_MODE);
    const sub = createSubAgentChecker(main, workspace, { inheritBypassMode: true });
    expect((await sub.check(readOutside())).allowed).toBe(true);

    // 对齐 app.ts cyclePermissionMode / applyEnterprisePolicyInSession 的三连改
    cfg.skipPermissions = false;
    cfg.yesMode = false;
    cfg.permissionMode = "default";

    // 新字段必须与 permissionMode 一样是「现算」而不是派生时刻的快照，
    // 否则用户以为收回了授权，后台子代理仍在读工作区外文件。
    expect(sub.getConfig().inheritedFromSkip).toBe(false);
    const decision = await sub.check(readOutside());
    expect(decision.allowed).toBe(false);
  });

  test("default → skip：升档同样即时生效", async () => {
    const { main, cfg } = makeMain({ permissionMode: "default" });
    const sub = createSubAgentChecker(main, workspace, { inheritBypassMode: true });
    expect((await sub.check(readOutside())).allowed).toBe(false);

    cfg.skipPermissions = true;
    cfg.permissionMode = "dangerously-skip-permissions";
    expect(sub.getConfig().inheritedFromSkip).toBe(true);
    expect((await sub.check(readOutside())).allowed).toBe(true);
  });
});

describe("A1 — inheritedFromSkip 是只读计算字段，反射路径与 get 一致", () => {
  test("get / 描述符 / 展开三处取值相同，且写不穿主 config", () => {
    const { main, cfg } = makeMain(SKIP_MODE);
    const sub = createSubAgentChecker(main, workspace, { inheritBypassMode: true });
    const view = sub.getConfig() as Config;

    expect(view.inheritedFromSkip).toBe(true);
    expect(Object.getOwnPropertyDescriptor(view, "inheritedFromSkip")?.value).toBe(true);
    // deriveWithPermissionMode 走 `{...config}`，展开后必须还是计算值
    expect({ ...view }.inheritedFromSkip).toBe(true);

    expect(() => {
      view.inheritedFromSkip = false;
    }).toThrow(TypeError);
    // 主 config 上根本没有这个字段（它只属于子代理 live 视图）
    expect(cfg.inheritedFromSkip).toBeUndefined();
  });
});
