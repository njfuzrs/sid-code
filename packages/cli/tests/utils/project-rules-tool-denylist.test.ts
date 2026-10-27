/**
 * CLAUDE.md `## Disallowed Tools` 必须裁剪工具集，不能只进权限层。
 *
 * 判据落在 registry（schema 是否进上下文），不落在「调用会不会被拒」：
 * skip 模式下权限层在 Step 3 之前早退，只靠权限层的名单什么都不拦（第 4 条把这个前提钉住）。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Registry } from "@sid-code/core/tool/registry.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";
import { applyRuleToolDenylist } from "../../src/utils/project-rules-tool-denylist.ts";

class MockTool implements LegacyTool {
  constructor(private _name: string) {}
  name() {
    return this._name;
  }
  description() {
    return `Mock tool: ${this._name}`;
  }
  inputSchema() {
    return { type: "object", properties: {} };
  }
  async execute(): Promise<LegacyToolResult> {
    return { output: "ok" };
  }
}

function makeRegistry(...names: string[]): Registry {
  const reg = new Registry();
  for (const n of names) reg.register(new MockTool(n));
  return reg;
}

describe("applyRuleToolDenylist（CLAUDE.md 禁用工具裁剪）", () => {
  test("CLAUDE.md 禁用的工具从 registry 移除，schema 不进 definitions()", () => {
    const reg = makeRegistry("read", "web_fetch");
    const { merged, removed } = applyRuleToolDenylist(reg, [], ["web_fetch"]);

    expect(removed).toEqual(["web_fetch"]);
    expect(merged).toEqual(["web_fetch"]);
    expect(reg.get("web_fetch")).toBeUndefined();
    expect(reg.definitions().map((d) => d.name)).toEqual(["read"]);
  });

  test("之后才注册的同名工具（MCP 回填）也进不来", () => {
    const reg = makeRegistry("read");
    applyRuleToolDenylist(reg, [], ["mcp__x__fetch"]);
    reg.register(new MockTool("mcp__x__fetch"));
    expect(reg.get("mcp__x__fetch")).toBeUndefined();
  });

  test("热重载重复合并同一份名单不追加重复项，并保留命令行来源的名单", () => {
    const reg = makeRegistry("read", "bash", "web_fetch");
    const first = applyRuleToolDenylist(reg, ["bash"], ["web_fetch"]);
    const second = applyRuleToolDenylist(reg, first.merged, ["web_fetch"]);
    expect(second.merged).toEqual(["bash", "web_fetch"]);
    // 第二次已无可删，幂等
    expect(second.removed).toEqual([]);
  });

  test("前提：skipPermissions=true 时权限层对禁用名单直接放行（所以必须裁剪）", async () => {
    const checker = new PermissionChecker({
      ...defaultConfig(),
      disallowedTools: ["web_fetch"],
      skipPermissions: true,
    });
    const r = await checker.check({ toolName: "web_fetch", input: {} });
    expect(r.allowed).toBe(true);
  });

  test("接线：app.ts applyProjectRules 走裁剪函数，而不是只追加进 config", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/app.ts"), "utf8");
    const start = src.indexOf("private applyProjectRules(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, start + 2000);
    expect(body).toContain("applyRuleToolDenylist(");
    expect(body).toContain("this.toolRegistry");
    // 旧写法：只把名单拼进 config，不碰 registry
    expect(body).not.toContain("[...this.config.disallowedTools, ...rules.disallowedTools]");
  });
});
