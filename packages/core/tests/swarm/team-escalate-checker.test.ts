/**
 * B33：swarm 的 escalate 包装器把 `Checker` 接口当成「只有 check」来包装。
 *
 * 三个被遮住的东西，各自一条回归：
 * 1. 第 4 个入参 `PermissionCheckOptions`（PreToolUse hook 的 allow / ask 决策）——
 *    丢它之后，hook ask 本该拦下的操作被底层直接放行，hook allow 本该放行的转去问 leader。
 * 2. `auditConfirmationOutcome`——leader 裁决是 swarm 侧的确认终局，此前既不转发入口、
 *    也不在裁决后自己记一行，审计里永远没有 `confirm_source=leader`。
 * 3. 出参元数据——修前 leader 分支直接返回 `{allowed, reason}`，`step` / `decisionReason`
 *    全丢，轨迹里看不出「是 leader 阶段做的决定」。
 *
 * 用例全部走真实 `PermissionChecker`（不用 mock），因为坑恰恰在两条真实 checker 的
 * 交互处：入参是否穿透、审计是否落盘。落盘目标一律重定向到 tmpdir。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamManager, type TeamOptions } from "../../src/swarm/team.ts";
import { PermissionChecker } from "../../src/permission/checker.ts";
import { createSubAgentChecker } from "../../src/permission/sub-agent-checker.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { sidPaths } from "../../src/config/paths.ts";
import type { Checker, PermissionCheckOptions } from "../../src/permission/types.ts";

let sidHome: string;
let prevSidConfigDir: string | undefined;
let workspace: string;

beforeEach(() => {
  sidHome = mkdtempSync(join(tmpdir(), "b33-sid-"));
  // 存原值再改：bun test 同批多文件跑在同一进程里，无条件 delete 会抹掉 preload 兜底
  prevSidConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = sidHome;
  workspace = join(sidHome, "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "hi");
});

afterEach(() => {
  if (prevSidConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidConfigDir;
  rmSync(sidHome, { recursive: true, force: true });
});

/** 真实 TeamManager 只为拿到包装器；members 留空，构造本身不启动任何成员。 */
function makeTeam(extra?: Partial<TeamOptions>): TeamManager {
  return new TeamManager({
    teamName: "b33",
    members: [],
    providerRegistry: {} as never,
    toolRegistry: {} as never,
    baseDir: sidHome,
    timeoutMs: 1_000,
    ...extra,
  });
}

/** 访问私有工厂：被测的就是这个包装器的行为，不另外复制一份实现来测。 */
function escalate(team: TeamManager, base: Checker): Checker {
  return (
    team as unknown as { createEscalateChecker(b: Checker, n: string): Checker }
  ).createEscalateChecker(base, "m1");
}

const readReq = () => ({
  toolName: "read",
  input: { file_path: join(workspace, "a.txt") },
  description: "read a.txt",
  toolUseId: "toolu_b33_read",
});

const writeReq = () => ({
  toolName: "write",
  input: { file_path: join(workspace, "b.txt"), content: "x" },
  description: "write b.txt",
  toolUseId: "toolu_b33_write",
});

function readAuditRows(): Array<Record<string, unknown>> {
  const path = sidPaths.log("permissions-audit.log");
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("B33 — escalate 包装器透传 PermissionCheckOptions", () => {
  /** 最直接的一条：第 4 个实参必须原样到达底层 checker。 */
  test("options 原样透传到底层 check()", async () => {
    const seen: Array<PermissionCheckOptions | undefined> = [];
    const base: Checker = {
      async check(_req, _tool, _ctx, options) {
        seen.push(options);
        return { allowed: true };
      },
    };
    const options: PermissionCheckOptions = { hookPermissionDecision: "ask", auditSource: "probe" };

    await escalate(makeTeam(), base).check(readReq(), undefined, undefined, options);

    expect(seen).toEqual([options]);
  });

  /**
   * 回归主用例（安全方向）：hook ask 要求强制升级，子代理 checker 在 dontAsk 下
   * 会把它降级为 deny。修前包装器丢掉 options，底层以为无事发生，直接 allow。
   */
  test("hookPermissionDecision=ask 在包装器后仍然拦截（修前被静默放行）", async () => {
    const main = new PermissionChecker(defaultConfig(), undefined, workspace);
    const sub = createSubAgentChecker(main, workspace);
    const wrapped = escalate(makeTeam(), sub);

    const direct = await sub.check(readReq(), undefined, undefined, {
      hookPermissionDecision: "ask",
    });
    const viaWrapper = await wrapped.check(readReq(), undefined, undefined, {
      hookPermissionDecision: "ask",
    });

    expect(direct.allowed).toBe(false);
    expect(direct.step).toBe("hook-ask");
    // 修前这一条是 allowed=true / step=10：hook 的强制升级被整段绕过
    expect(viaWrapper.allowed).toBe(false);
    expect(viaWrapper.step).toBe("hook-ask");
  });

  /**
   * 回归主用例（功能方向）：普通 ask 被 hook allow 放行。
   * 修前包装器丢掉 options → 底层返回 needsConfirmation → 转 leader → 无仲裁者时 deny。
   */
  test("hookPermissionDecision=allow 在包装器后仍然放行（修前被转成 leader 询问并拒绝）", async () => {
    const plain = new PermissionChecker(defaultConfig(), undefined, workspace);
    const wrapped = escalate(makeTeam(), plain);

    const direct = await plain.check(writeReq(), undefined, undefined, {
      hookPermissionDecision: "allow",
    });
    const viaWrapper = await wrapped.check(writeReq(), undefined, undefined, {
      hookPermissionDecision: "allow",
    });

    expect(direct.allowed).toBe(true);
    expect(direct.step).toBe("hook-allow");
    // 修前这一条是 allowed=false（needsConfirmation → permSync 无 arbiter → deny）
    expect(viaWrapper.allowed).toBe(true);
    expect(viaWrapper.step).toBe("hook-allow");
  });
});

describe("B33 — leader 裁决落审计并保留出参元数据", () => {
  /** leader 批准：审计里必须有这一行，且能按 tool_use_id 与轨迹对上。 */
  test("leader 批准写一行 confirm_source=leader 的审计", async () => {
    const plain = new PermissionChecker(defaultConfig(), undefined, workspace);
    const team = makeTeam({ permissionArbiter: async () => "allow" });

    const decision = await escalate(team, plain).check(writeReq());

    expect(decision.allowed).toBe(true);
    expect(decision.step).toBe("leader-allow");
    // leader 已经给出结论，needsConfirmation 必须清掉，否则上层会再走一遍确认/降级
    expect(decision.needsConfirmation ?? false).toBe(false);

    const row = readAuditRows().find((r) => r.tool_use_id === "toolu_b33_write");
    expect(row).toMatchObject({
      tool: "write",
      decision: "allow",
      confirm_source: "leader",
      user_confirmed: false,
    });
  });

  /** leader 拒绝：结论落审计，出参打上 leader 阶段标记，且不再要求上层确认。 */
  test("leader 拒绝写审计并标 leader-deny", async () => {
    const plain = new PermissionChecker(defaultConfig(), undefined, workspace);
    const team = makeTeam({ permissionArbiter: async () => "deny" });

    const decision = await escalate(team, plain).check(writeReq());

    expect(decision.allowed).toBe(false);
    expect(decision.step).toBe("leader-deny");
    expect(decision.needsConfirmation ?? false).toBe(false);

    const row = readAuditRows().find((r) => r.tool_use_id === "toolu_b33_write");
    expect(row).toMatchObject({
      decision: "deny",
      confirm_source: "leader",
    });
  });

  /**
   * 修前 leader 分支直接返回 `{allowed, reason}`，底层的 `decisionReason` / `mode` 全丢，
   * 轨迹里看不出「为什么要问 leader」。用可控 base 锁住这三个字段的保留。
   */
  test("leader 裁决保留底层的 decisionReason / mode，只覆盖结论与 step", async () => {
    const base: Checker = {
      async check() {
        return {
          allowed: false,
          needsConfirmation: true,
          reason: "工具 write 需要用户确认",
          decisionReason: { type: "rule", rule: "Write(*)", behavior: "ask" },
          mode: "default",
        };
      },
    };
    const team = makeTeam({ permissionArbiter: async () => "allow" });

    const decision = await escalate(team, base).check(writeReq());

    expect(decision.allowed).toBe(true);
    expect(decision.step).toBe("leader-allow");
    expect(decision.mode).toBe("default");
    expect(decision.decisionReason).toEqual({ type: "rule", rule: "Write(*)", behavior: "ask" });
    expect(decision.needsConfirmation ?? false).toBe(false);
  });

  /** 包装器不能再把底层的 auditConfirmationOutcome 遮住：上层在确认终局后调的就是它。 */
  test("auditConfirmationOutcome 转发到底层 checker", async () => {
    const seen: unknown[] = [];
    const base = {
      async check() {
        return { allowed: true };
      },
      auditConfirmationOutcome(_req: unknown, outcome: unknown) {
        seen.push(outcome);
      },
    } as unknown as Checker;

    const wrapped = escalate(makeTeam(), base);
    expect(typeof wrapped.auditConfirmationOutcome).toBe("function");

    wrapped.auditConfirmationOutcome!(readReq(), { allowed: true, source: "user" });
    expect(seen).toEqual([{ allowed: true, source: "user" }]);
  });
});
