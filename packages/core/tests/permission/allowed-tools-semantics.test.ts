/**
 * allowed-tools 语义对齐 CC 的回归测试（bugfixes 20261013，T1/T6-T10/T13/T14）。
 *
 * 触发事故：轨迹 20261013-100055-7eeb1160——自定义命令声明 `Read, Glob, Bash(ls*) …`，
 * 被当成工具白名单 + 触发 fork，子代理按大小写敏感精确查表只挂上两个 MCP 工具，
 * 且未注入 checker，读文件一律 fail-closed。修复后：
 * - `allowed-tools` = 免确认 allow 规则（commandScoped 源，优先级最低、deny 压得住）；
 * - 不可信来源（项目级命令 / skill）剥离危险自我授权；
 * - fork 子代理继承主会话 always-allow；
 * - `--allowed-tools` 走规则引擎（认 CC 名与 `Bash(pattern)`）。
 *
 * 落盘隔离同 sub-agent-checker.test.ts：AuditLogger 会 mkdir sidPaths.logs()。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { createSubAgentChecker } from "@sid-code/core/permission/sub-agent-checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import {
  parseAllowedToolsSpec,
  splitToolList,
  ruleToToolName,
} from "@sid-code/core/tool/allowed-tools-spec.ts";
import { CC_TO_INTERNAL_TOOL_NAME } from "@sid-code/core/tool/tool-name-aliases.ts";

let configRoot: string;
let workspace: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-allowed-tools-cfg-"));
  workspace = mkdtempSync(join(tmpdir(), "sid-allowed-tools-ws-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function makeChecker(over: Partial<Config> = {}): PermissionChecker {
  return new PermissionChecker({ ...defaultConfig(), ...over } as Config, undefined, workspace);
}

const bash = (command: string) => ({
  toolName: "bash",
  input: { command },
  description: `bash: ${command}`,
});

describe("T1 parseAllowedToolsSpec：括号感知切分 + 名字归一", () => {
  test("括号内逗号不切，规则原样保留；toolNames 归一到内部名", () => {
    const spec = parseAllowedToolsSpec("Read, Bash(git -C*, x), mcp__a__b")!;
    expect(spec.rules).toEqual(["Read", "Bash(git -C*, x)", "mcp__a__b"]);
    expect(spec.toolNames).toEqual(["read", "bash", "mcp__a__b"]);
  });

  test("空白也是分隔符（CC parseToolListFromCLI 口径），括号内空白保留", () => {
    expect(splitToolList("Read Glob Bash(git log *)")).toEqual(["Read", "Glob", "Bash(git log *)"]);
  });

  test("数组写法每项同样过切分；未声明返回 undefined（与声明为空区分）", () => {
    expect(parseAllowedToolsSpec(["Read", "Bash(a, b)"])!.rules).toEqual(["Read", "Bash(a, b)"]);
    expect(parseAllowedToolsSpec(undefined)).toBeUndefined();
    expect(parseAllowedToolsSpec("")!.rules).toEqual([]);
  });

  test("事故原文 frontmatter 解析出 14 条规则，Read/Glob 归一后可查", () => {
    const raw =
      "Read, Edit, Write, Glob, Grep, Bash(ls*), Bash(find*), Bash(wc*), Bash(grep*), Bash(git -C*), Bash(git diff*), Bash(git log*), mcp__tavily__tavily_search, mcp__tavily__tavily_extract";
    const spec = parseAllowedToolsSpec(raw)!;
    expect(spec.rules).toHaveLength(14);
    expect(spec.toolNames).toEqual([
      "read",
      "edit",
      "write",
      "glob",
      "grep",
      "bash",
      "mcp__tavily__tavily_search",
      "mcp__tavily__tavily_extract",
    ]);
  });
});

describe("T14 反漂移：别名表每个 CC 名都能经 ruleToToolName 归到内部名", () => {
  test("CC 名 / CC 名(pattern) 都归一到同一内部名", () => {
    for (const [cc, internal] of Object.entries(CC_TO_INTERNAL_TOOL_NAME)) {
      expect(ruleToToolName(cc)).toBe(internal);
      expect(ruleToToolName(`${cc}(x)`)).toBe(internal);
    }
  });
});

describe("T6/T7 inline 本轮 allow 规则（commandScoped）", () => {
  test("default 模式：设置后 git status 免确认；清空后恢复 ask", async () => {
    const c = makeChecker();
    expect((await c.check(bash("git status"))).allowed).toBe(false);
    c.setCommandScopedRules(["Bash(git status*)"], true);
    expect((await c.check(bash("git status"))).allowed).toBe(true);
    // 规则只放行声明的那一条，不外溢
    expect((await c.check(bash("git push"))).allowed).toBe(false);
    c.clearCommandScopedRules();
    expect((await c.check(bash("git status"))).allowed).toBe(false);
  });

  test("setCommandScopedRules 整体替换上一批，不累加", async () => {
    const c = makeChecker();
    c.setCommandScopedRules(["Bash(git status*)"], true);
    c.setCommandScopedRules(["Bash(git log*)"], true);
    expect((await c.check(bash("git status"))).allowed).toBe(false);
    expect((await c.check(bash("git log --oneline"))).allowed).toBe(true);
  });

  test("CC 名写法 `Read` 对 read 生效（规则引擎大小写不敏感 + 别名）", async () => {
    const c = makeChecker();
    c.setCommandScopedRules(["Glob"], true);
    const r = await c.check({ toolName: "glob", input: { pattern: "*.md" }, description: "glob" });
    expect(r.allowed).toBe(true);
  });
});

describe("T8 不可信来源过滤", () => {
  test("项目级（trusted=false）声明 Bash(*) / Bash(rm *) / 裸 Bash 被剥离", async () => {
    const c = makeChecker();
    const dropped = c.setCommandScopedRules(
      ["Bash(*)", "Bash(rm -rf *)", "Bash", "Bash(git status*)"],
      false,
    );
    expect(dropped).toEqual(["Bash(*)", "Bash(rm -rf *)", "Bash"]);
    expect((await c.check(bash("ls"))).allowed).toBe(false);
    expect((await c.check(bash("git status"))).allowed).toBe(true);
  });

  test("用户级（trusted=true）同样声明保留", () => {
    const c = makeChecker();
    expect(c.setCommandScopedRules(["Bash(*)", "Bash"], true)).toEqual([]);
  });
});

describe("T9 deny 优先：commandScoped allow 压不过持久 deny", () => {
  test("用户级命令 allow Bash(*) + deny Bash(rm *) → rm 仍被拒", async () => {
    const c = makeChecker();
    c.getRuleLoader().addSessionRule("deny", "Bash(rm *)");
    c.refreshRulesFromLoader();
    c.setCommandScopedRules(["Bash(*)"], true);
    expect((await c.check(bash("rm foo.txt"))).allowed).toBe(false);
    expect((await c.check(bash("echo hi"))).allowed).toBe(true);
  });
});

describe("T10 fork 子代理继承 always-allow", () => {
  const editReq = () => ({
    toolName: "edit",
    input: { file_path: join(workspace, "a.ts"), old_string: "a", new_string: "b" },
    description: "edit",
  });

  test("主会话 always-allow + inheritBypassMode → 子代理 edit 放行", async () => {
    const main = makeChecker({ permissionMode: "always-allow" });
    const sub = createSubAgentChecker(main, workspace, { inheritBypassMode: true });
    expect(sub.getConfig().permissionMode).toBe("always-allow");
    expect((await sub.check(editReq())).allowed).toBe(true);
  });

  test("主会话 default → 子代理仍降为 dontAsk，edit 被拒", async () => {
    const main = makeChecker();
    const sub = createSubAgentChecker(main, workspace, { inheritBypassMode: true });
    expect(sub.getConfig().permissionMode).toBe("dontAsk");
    expect((await sub.check(editReq())).allowed).toBe(false);
  });

  test("不开 inheritBypassMode（sub_agent 等既有路径）行为不变：always-allow 也降为 dontAsk", () => {
    const main = makeChecker({ permissionMode: "always-allow" });
    expect(createSubAgentChecker(main, workspace).getConfig().permissionMode).toBe("dontAsk");
  });

  test("派生 checker 可回到根（fork 入口据此按主会话当前模式重新派生）", () => {
    const main = makeChecker();
    const sub = createSubAgentChecker(main, workspace);
    expect(sub.getRootChecker()).toBe(main);
    expect(main.getRootChecker()).toBe(main);
  });

  test("加在派生实例上的 commandScoped 规则不污染主 checker", async () => {
    const main = makeChecker();
    const sub = createSubAgentChecker(main, workspace, { inheritBypassMode: true });
    sub.setCommandScopedRules(["Bash(git status*)"], true);
    expect((await sub.check(bash("git status"))).allowed).toBe(true);
    expect((await main.check(bash("git status"))).allowed).toBe(false);
  });
});

describe("T13 --allowed-tools 走规则引擎", () => {
  test('`Read,"Bash(git *)"`：read 与 git log 放行，rm 不放行', async () => {
    const c = makeChecker({ allowedTools: splitToolList("Read,Bash(git *)") });
    const read = await c.check({
      toolName: "read",
      input: { file_path: join(workspace, "a.ts") },
      description: "read",
    });
    expect(read.allowed).toBe(true);
    expect((await c.check(bash("git log --oneline"))).allowed).toBe(true);
    expect((await c.check(bash("rm -f a.ts"))).allowed).toBe(false);
  });

  test("旧写法（内部名）照常生效", async () => {
    const c = makeChecker({ allowedTools: ["bash"] });
    expect((await c.check(bash("echo hi"))).allowed).toBe(true);
  });
});
