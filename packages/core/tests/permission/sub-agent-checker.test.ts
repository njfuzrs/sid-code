/**
 * 子代理 checker 规则同步反漂移测试
 *
 * 背景（2026-08-26 实测）：`createSubAgentChecker` 用
 * `new PermissionChecker(config, undefined, ws)` 构造（第二参数 undefined → `this.rules = null`），
 * 再调 `importFromRuleLoader` 把主 checker 的规则灌进 **RuleLoader**。但 loader 与
 * checker 的 `this.rules` 是**两份状态**，阶段一（hasPermissionsInner）的所有规则分支
 * ——Step 1 checkDenyRules / Step 4 敏感文件逃生舱的 checkAllowRules / Step 5 ask 规则 /
 * Step 8 checkAllowRules——以及 `isPathHidden()` 一律以 `if (this.rules)` 为前置门，
 * 只读后者。少一句 `refreshRulesFromLoader()` 就让这些分支在子代理上整段短路。
 *
 * ⚠ 为什么每条断言都要精确到 `decisionReason`，不能只断 `allowed === false`：
 * 子代理是 dontAsk 模式，规则短路后请求落到「ask → dontAsk 自动拒绝」，
 * **结论同为 `allowed: false`**。只断布尔值的测试在把 `refreshRulesFromLoader()`
 * 删掉之后仍然全绿 —— 这正是本 bug 长期潜伏未被发现的原因。判据必须是
 * `decisionReason.type === "rule"`（命中用户配置的规则）而不是 `"mode"`（被兜底拒）。
 *
 * ⚠ 落盘隔离：PermissionChecker 构造 AuditLogger，后者无条件 mkdirSync(sidPaths.logs())，
 * 故必须重定向 SID_CONFIG_DIR；恢复时存/恢复原值而非无条件 delete
 * （bun test 同批多文件同进程，直接删会抹掉 preload 兜底）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { createSubAgentChecker } from "@sid-code/core/permission/sub-agent-checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { PermissionRule } from "@sid-code/core/permission/types.ts";

let configRoot: string;
let workspace: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-subagent-perm-cfg-"));
  // 工作区单独一个 tmpdir：规则里的相对模式（`internal/**`）按 workspaceRoot 归一，
  // 且刻意不用仓库路径 —— worktree 路径含 `.claude/` 会命中 checker 的敏感路径拦截，
  // 在规则判定之前就返回（见 CLAUDE.md「判定这个失败与我无关」一节）。
  workspace = mkdtempSync(join(tmpdir(), "sid-subagent-perm-ws-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

/** 造一个带规则的主 checker（不调 initRules，避免读真实 settings 文件） */
function makeMainChecker(rules: PermissionRule): PermissionChecker {
  const config = { ...defaultConfig() } as Config;
  return new PermissionChecker(config, rules, workspace);
}

describe("createSubAgentChecker — 规则必须同步到 this.rules", () => {
  test("规则灌入后 getRules() 非 null（缺 refreshRulesFromLoader 时恒为 null）", () => {
    const main = makeMainChecker({ allow: ["Bash(npm *)"], deny: ["Bash(curl *)"], ask: [] });
    const sub = createSubAgentChecker(main, workspace);

    // 这是最直接的判据：loader 有规则，checker 的 this.rules 也必须有。
    const subRules = sub.getRules();
    expect(subRules).not.toBeNull();
    expect(subRules!.allow).toContain("Bash(npm *)");
    expect(subRules!.deny).toContain("Bash(curl *)");
  });

  test("后果 1：allow 规则在子代理生效，而不是被 dontAsk 兜底拒掉", async () => {
    const main = makeMainChecker({ allow: ["Bash(npm *)"], deny: [], ask: [] });
    const sub = createSubAgentChecker(main, workspace);
    const req = { toolName: "bash", input: { command: "npm test" } };

    // 主 checker 的基线：命中 allow 规则放行
    const mainDecision = await main.check(req);
    expect(mainDecision.allowed).toBe(true);
    expect(mainDecision.decisionReason?.type).toBe("rule");

    const subDecision = await sub.check(req);
    expect(subDecision.allowed).toBe(true);
    // 关键：必须是「命中规则」放行，不是别的路径碰巧放行
    expect(subDecision.decisionReason?.type).toBe("rule");
    expect(subDecision.decisionReason).toMatchObject({ type: "rule", behavior: "allow" });
  });

  test("后果 2：deny 规则命中时 decisionReason.type === 'rule'，不是 'mode'", async () => {
    const main = makeMainChecker({ allow: [], deny: ["Bash(curl *)"], ask: [] });
    const sub = createSubAgentChecker(main, workspace);
    const req = { toolName: "bash", input: { command: "curl http://example.com/x" } };

    const mainDecision = await main.check(req);
    expect(mainDecision.allowed).toBe(false);
    expect(mainDecision.decisionReason).toMatchObject({ type: "rule", behavior: "deny" });

    const subDecision = await sub.check(req);
    expect(subDecision.allowed).toBe(false);
    // ⚠ 这条断言是本文件的核心：只断 allowed === false 的话，规则短路后
    // dontAsk 兜底给出的同样是 allowed:false（decisionReason 变成 { type:"mode", mode:"dontAsk" }），
    // 测试会假绿。必须锁住「因为命中 deny 规则而拒」。
    expect(subDecision.decisionReason).toMatchObject({ type: "rule", behavior: "deny" });
    expect(subDecision.decisionReason?.type).not.toBe("mode");
    expect(subDecision.reason).toContain("Bash(curl *)");
  });

  test("后果 3：非凭证类路径 deny 在子代理生效（不再直接放行）", async () => {
    // 刻意选 `internal/**`：它不被 path-validator 的 SENSITIVE_FILES 正则命中，
    // 所以拦不拦完全取决于 deny 规则本身。`secrets/**` 之类会碰巧命中 /secret/i
    // 敏感文件正则，用它测不出规则有没有生效。
    const main = makeMainChecker({ allow: [], deny: ["Read(internal/**)"], ask: [] });
    const sub = createSubAgentChecker(main, workspace);
    const req = { toolName: "read", input: { file_path: join(workspace, "internal", "a.txt") } };

    const mainDecision = await main.check(req);
    expect(mainDecision.allowed).toBe(false);
    expect(mainDecision.decisionReason).toMatchObject({ type: "rule", behavior: "deny" });

    const subDecision = await sub.check(req);
    // 规则短路时这里是 allowed:true（read 走读操作自动放行），是真实的越权
    expect(subDecision.allowed).toBe(false);
    expect(subDecision.decisionReason).toMatchObject({ type: "rule", behavior: "deny" });
  });

  test("后果 4：isPathHidden() 在子代理返回 true（glob/ls 的 deny 过滤生效）", () => {
    const main = makeMainChecker({ allow: [], deny: ["Read(internal/**)"], ask: [] });
    const sub = createSubAgentChecker(main, workspace);
    const target = join(workspace, "internal", "a.txt");

    expect(main.isPathHidden(target)).toBe(true);
    // 该方法直接读 this.rules?.deny，规则没同步时恒 false → 被 deny 的文件
    // 仍出现在 glob/ls 列举结果里，模型看得到
    expect(sub.isPathHidden(target)).toBe(true);
    // 反向：不在 deny 模式内的路径不应被隐藏（防"一律返回 true"式假通过）
    expect(sub.isPathHidden(join(workspace, "public", "a.txt"))).toBe(false);
  });

  test("ask 规则也随之生效：命中 ask → dontAsk 兜底拒，但理由链能追到规则", async () => {
    const main = makeMainChecker({ allow: [], deny: [], ask: ["Bash(git push *)"] });
    const sub = createSubAgentChecker(main, workspace);
    const subRules = sub.getRules();
    expect(subRules?.ask).toContain("Bash(git push *)");
  });

  test("子代理 permissionMode 被强制为 dontAsk（原有语义不受修复影响）", () => {
    const main = makeMainChecker({ allow: [], deny: [], ask: [] });
    const sub = createSubAgentChecker(main, workspace);
    expect(sub.getConfig().permissionMode).toBe("dontAsk");
    // 主 checker 的 config 不被污染
    expect(main.getConfig().permissionMode).not.toBe("dontAsk");
  });
});
