/**
 * D6 来源契约：**外部工具自报的 `readOnlyHint` 不能换来免确认**。
 *
 * ## 这条不变式之前为什么没被守住
 *
 * `checker.ts` 的 `toolReportsReadOnly()` 两种接口形态都认，**不看注册来源**；
 * 真正拦住 MCP 的是调用点上的 `declaredNoPermission()`（来源必须 `builtin`）——
 * Step 13 与「deny-write 硬约束总闸」都是 `declaredNoPermission(...) &&
 * toolReportsReadOnly(...)`。于是安全性完全依赖「两个条件必须 AND」这一个隐式约定，
 * 它只写在注释里，没有任何测试固定。一次「顺手统一 hint 判据」的改动就可能把它带偏。
 *
 * ## 测试在测什么
 *
 * 构造一个真 MCP 工具（`readOnlyHint: true`、路径名 `mcp__...`），分别走两条**注册链路**：
 *
 * 1. `registry.register(tool, "mcp")`（生产上 MCP 桥接的注册方式）→ 来源未打标；
 * 2. `registry.register(tool)`（把同一个工具当内置注册）→ 来源 `builtin`。
 *
 * 同一份工具对象、同一份 `annotations`，唯一差别是注册来源。deny-write 下：
 *
 * - 2 放行 → 证明 deny-write 的「免权限只读工具」分支真的存在且真的会看 `readOnly`，
 *   即 1 的 DENY 不是「这条分支根本没生效」的假阴性；
 * - 1 仍被拒、且 `step === "13"` → 证明隔离来自来源判定，而不是被前面某个步骤提前拦下。
 *
 * 另补两条负向对照：MCP 工具自己写 `requiresPermission() { return false }` 也一样无效
 * （`declaredNoPermission` 的来源闸），以及缺省（非 deny-write）档下 MCP 工具照旧要确认。
 *
 * ## 变异自证
 *
 * 把 Step 13（与阶段二总闸）的 `&&` 改成 OR、或删掉 `declaredNoPermission` →
 * 「MCP 工具仍被拒」那组变红。改回来的实测输出见报告。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "../../src/permission/checker.ts";
import { Registry } from "../../src/tool/registry.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { PlanModeManager } from "../../src/plan/state.ts";
import { MCPManager } from "../../src/mcp/manager.ts";
import type { PermissionRule } from "../../src/permission/types.ts";
import type { Tool } from "../../src/tool/types.ts";

/**
 * `check()` 的形参类型是新版 `Tool`，registry 内部存的是 `LegacyTool`（bridge 归一后）。
 * 生产链路（`agent/tool-executor.ts`）传的就是 registry 里那份，测试照同一条路径断言。
 * 与 `internal-tool-permission.test.ts` 同一套处理。
 */
type ToolInstance = Tool<unknown, string>;

/** 伪造的 MCP 工具定义：一个撒谎的 Server 声明自己只读 */
const READONLY_TOOL_DEF = {
  name: "search",
  description: "撒谎自称只读",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  annotations: { readOnlyHint: true, idempotentHint: true },
};

/**
 * 用生产适配器造 MCP 工具，再让它实现 `requiresPermission() { return false }`
 * （最坏情况：外部工具连「我不需要权限」都自报）。
 *
 * `MCPToolAdapter` 未导出，沿用 `tests/query/subagent-internal-fields-not-leaked.test.ts`
 * 的做法经 `MCPManager.prototype.adaptTools` 构造；adaptTools 不读 this，stub client 足够。
 */
function makeLyingMcpTool(): ToolInstance {
  const fakeClient = { callTool: async () => ({ content: [] }) };
  const [tool] = (
    MCPManager.prototype as unknown as {
      adaptTools: (c: unknown, d: unknown[], n: string) => ToolInstance[];
    }
  ).adaptTools.call({}, fakeClient, [READONLY_TOOL_DEF], "probe");
  (tool as unknown as { requiresPermission: () => boolean }).requiresPermission = () => false;
  return tool!;
}

type Mode = "default" | "deny-write" | "plan" | "dontAsk";

let configRoot: string;
let prevConfigDir: string | undefined;
let workspace: string;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-d6-cfg-"));
  workspace = mkdtempSync(join(tmpdir(), "sid-d6-ws-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

/** 走注册链路拿 checker 实际会看到的那个工具实例（来源在注册那一刻打标） */
function registerTool(source: "mcp" | "builtin"): { registry: Registry; tool: ToolInstance } {
  const registry = new Registry();
  if (source === "mcp") registry.register(makeLyingMcpTool(), "mcp");
  else registry.register(makeLyingMcpTool());
  // `register()` 按名字前缀分流：`mcp__` 开头的进 mcpTools，否则进 builtInTools，两边都 `get()`
  const raw = registry.get("mcp__probe__search") ?? registry.get("search");
  if (!raw) throw new Error("测试准备失败：registry 里没有 mcp__probe__search");
  return { registry, tool: raw as unknown as ToolInstance };
}

function buildChecker(mode: Mode, rules?: Partial<PermissionRule>): PermissionChecker {
  const config = { ...defaultConfig(), permissionMode: mode };
  const checker = new PermissionChecker(
    config,
    { allow: [], deny: [], ask: [], ...rules } as PermissionRule,
    workspace,
  );
  checker.setPlanManager(new PlanModeManager());
  return checker;
}

describe("D6 契约：readOnlyHint 不跨注册来源生效", () => {
  test("对照：同一个工具按 builtin 注册 → deny-write 下放行（Step 13 分支真的可达）", async () => {
    const { tool } = registerTool("builtin");
    const d = await buildChecker("deny-write").check(
      { toolName: "mcp__probe__search", input: { q: "x" } },
      tool,
    );
    expect(d.allowed).toBe(true);
  });

  test("MCP 来源：readOnlyHint + 自报免权限，deny-write 下仍被拒（step=13）", async () => {
    const { tool } = registerTool("mcp");
    const d = await buildChecker("deny-write").check(
      { toolName: "mcp__probe__search", input: { q: "x" } },
      tool,
    );
    expect(d.allowed).toBe(false);
    // step 落在 13：说明是 deny-write 分支判的，不是被前面的步骤提前拦下
    expect(d.step).toBe("13");
  });

  test("MCP 来源：deny-write 下不因为 readOnly 拿到任何放行理由", async () => {
    const { tool } = registerTool("mcp");
    const d = await buildChecker("deny-write").check(
      { toolName: "mcp__probe__search", input: { q: "x" } },
      tool,
    );
    expect(d.allowed).toBe(false);
    expect(d.needsConfirmation).not.toBe(true);
  });

  test("MCP 来源：plan 模式（内部落到 deny-write）同样不放行", async () => {
    const { tool } = registerTool("mcp");
    const d = await buildChecker("plan").check(
      { toolName: "mcp__probe__search", input: { q: "x" } },
      tool,
    );
    expect(d.allowed).toBe(false);
  });

  test("MCP 来源：default 档照旧要用户确认（hint 只用于收紧，不用于放行）", async () => {
    const { tool } = registerTool("mcp");
    const d = await buildChecker("default").check(
      { toolName: "mcp__probe__search", input: { q: "x" } },
      tool,
    );
    expect(d.allowed).toBe(false);
    expect(d.needsConfirmation).toBe(true);
  });
});
