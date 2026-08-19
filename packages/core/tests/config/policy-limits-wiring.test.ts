/**
 * policyLimits 接线（P1 · 企业策略功能开关此前只写不读）
 *
 * ## 这个文件为什么存在
 *
 * `policyLimits` 在 `origin/main` 上是**只被写入、从不被读取**的：
 * `setPolicyLimits()` 有调用点，而 `isPolicyAllowed()` 全仓 **0 个生产调用点**
 *（在 `origin/main` 上对各包 src 目录 git grep，除定义处外零命中）。
 * 企业管理员配了开关却毫无效果，而 `website/team/policy.md` 写着"注入生效"。
 *
 * 这直接决定了它上面的 metric 能不能用：给一个**结构上不可达**的分支埋点，
 * 得到的是一列永久为零的假数据 —— 本仓已有的教训是「函数零调用 ≠ 能力未生效」
 * 的反面：这里恰恰是零调用**就是**能力未生效。所以先接线，再埋点。
 *
 * ## 断言的是行为，不是"有引用"，也不是类型
 *
 * bun **不跑类型检查**，所以本文件里没有一条能守住类型层的改动
 *（`PolicySettings.policyLimits` 补 `reason?: string` 这件事，把它改回去这里照样全绿 ——
 * 实测确认过）。每条断言守的都是运行时行为。
 *
 * 「有没有引用」测不出接线（本仓否决过接线率静态门禁，理由同此）。
 * 所以每条用例都构造真实输入、看真实输出变化，且都配一条**反向对照**：
 * 策略允许时行为必须与接线前一致 —— 否则就是把功能改坏了而不是加了开关。
 *
 * 落盘隔离：`SID_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` 指向 tmpdir，
 * 不读真实机器上的用户级扩展。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExtensionLoader } from "@sid-code/core/extension/loader.ts";
import {
  setPolicyLimits,
  resetPolicyLimits,
  isPolicyAllowed,
  getPolicyDenialReason,
} from "@sid-code/core/config/policy-limits.ts";

let testDir: string;
let prevSidHome: string | undefined;
let prevClaudeHome: string | undefined;

beforeEach(() => {
  testDir = join(tmpdir(), `policy-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  const userHome = join(testDir, "__user_home__");
  prevSidHome = process.env.SID_CONFIG_DIR;
  prevClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = join(userHome, ".sid-code");
  process.env.CLAUDE_CONFIG_DIR = join(userHome, ".claude");
  resetPolicyLimits();
});

afterEach(() => {
  resetPolicyLimits();
  if (prevSidHome === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidHome;
  if (prevClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeHome;
  rmSync(testDir, { recursive: true, force: true });
});

/** 在 project 级写一个扩展文件，返回它所在的 project 目录 */
function writeExtension(surface: "commands" | "agents" | "skills", name: string): string {
  const dir = join(testDir, ".sid-code", surface);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\n---\n正文`);
  return testDir;
}

describe("extensions 开关接到 ExtensionLoader.scan", () => {
  test("策略允许（默认未配置）→ 正常扫到（反向对照，证明没把功能改坏）", async () => {
    const proj = writeExtension("agents", "my-agent");
    const files = await new ExtensionLoader().scan("agents", proj);
    expect(files.map((f) => f.name)).toContain("my-agent");
  });

  test("extensions 被禁 → 扫描结果为空", async () => {
    const proj = writeExtension("agents", "my-agent");
    setPolicyLimits({ extensions: { allowed: false } });
    const files = await new ExtensionLoader().scan("agents", proj);
    expect(files).toEqual([]);
  });

  test("★ commands 面不受 extensions 开关影响（它由 custom_commands 单独管）", async () => {
    // 这条锁的是一个**刻意的例外**：管理员只禁了 extensions，
    // 却连斜杠命令一起没了会是个意外行为。删掉 loader 里那个 `type !== "commands"`
    // 判断，这条就会红。
    const proj = writeExtension("commands", "my-cmd");
    setPolicyLimits({ extensions: { allowed: false } });
    const files = await new ExtensionLoader().scan("commands", proj);
    expect(files.map((f) => f.name)).toContain("my-cmd");
  });
});

describe("isPolicyAllowed 的判定口径", () => {
  test("未配置的 feature = 允许（策略是白名单外默认放行，不是默认禁止）", () => {
    setPolicyLimits({ mcp: { allowed: false } });
    // 只禁了 mcp，别的 feature 不受影响 —— 否则配一条等于关掉一切
    expect(isPolicyAllowed("sub_agent")).toBe(true);
    expect(isPolicyAllowed("custom_commands")).toBe(true);
    expect(isPolicyAllowed("mcp")).toBe(false);
  });

  test("allowed: true 显式允许", () => {
    setPolicyLimits({ mcp: { allowed: true } });
    expect(isPolicyAllowed("mcp")).toBe(true);
  });

  test("resetPolicyLimits 后恢复全放行（测试之间不串味）", () => {
    setPolicyLimits({ mcp: { allowed: false } });
    resetPolicyLimits();
    expect(isPolicyAllowed("mcp")).toBe(true);
  });
});

describe("管理员写的禁用理由能取到（PolicySettings 此前漏了 reason 字段）", () => {
  test("配了 reason → 原样返回，不落通用兜底文案", () => {
    // ⚠️ 这条**不是**类型修复的门禁，说清楚免得误读：`config/policy.ts` 那边补
    // `reason?: string` 是类型对齐（`policy-limits.ts` 一直声明着它），
    // 运行时的值本来就能流通（`PolicyManager.load()` 不做 schema 剥离）。
    // bun 不跑类型检查，把类型改回去这条照样绿 —— 实测确认过。
    // 它锁的是 `getPolicyDenialReason()` 的**取值行为**，那个是真会被改坏的。
    setPolicyLimits({ mcp: { allowed: false, reason: "内网禁止外连 MCP 服务器" } });
    expect(getPolicyDenialReason("mcp")).toBe("内网禁止外连 MCP 服务器");
  });

  test("未配 reason → 有兜底文案（不是 undefined，用户要看得到原因）", () => {
    setPolicyLimits({ mcp: { allowed: false } });
    const reason = getPolicyDenialReason("mcp");
    expect(typeof reason).toBe("string");
    expect(reason!.length).toBeGreaterThan(0);
  });

  test("功能被允许时没有拒绝理由", () => {
    setPolicyLimits({ mcp: { allowed: true } });
    expect(getPolicyDenialReason("mcp")).toBeUndefined();
  });
});
