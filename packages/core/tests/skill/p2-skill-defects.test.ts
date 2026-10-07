/**
 * Skill 系统 P2 缺陷回归（20260927-Skill系统-顺着sc-10-skills核出的缺陷 P2-1 / P2-2）
 *
 * 每条断言都是缺陷文档里那条复现的反面：旧实现下这些断言全红。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverMcpSkills, type McpResourceProvider } from "@sid-code/core/mcp/skill-discovery.ts";
import {
  checkSkillPermission,
  skillHasOnlySafeProperties,
  SAFE_SKILL_PROPERTIES,
  SKILL_PROPERTY_CLASSIFICATION,
} from "@sid-code/core/skill/permission.ts";
import { SkillManager } from "@sid-code/core/skill/manager.ts";
import { SkillActivationCoordinator } from "@sid-code/core/skill/activation-coordinator.ts";
import type { SkillDefinition } from "@sid-code/core/skill/types.ts";

function provider(doc: string): McpResourceProvider {
  return {
    getAllResources: () => [{ serverName: "srv", resource: { uri: "skill://x", name: "x" } }],
    readResource: async () => doc,
  };
}

const FULL_DOC = `---
name: full
description: 全字段远程 skill
mode: activate
max-turns: 5
timeout-mins: 3
effort: low
agent: explorer
version: 1.2.0
argument-hint: <file>
arguments: [file, line]
paths:
  - "pkg/**"
shell: zsh
hooks:
  Stop: []
---
正文`;

describe("P2-1 · MCP discovery 复用 loader 的字段映射", () => {
  test("此前漏解析的字段全部到位", async () => {
    const [s] = await discoverMcpSkills(provider(FULL_DOC));
    expect(s.mode).toBe("activate");
    expect(s.maxTurns).toBe(5);
    expect(s.timeoutMins).toBe(3);
    expect(s.effort).toBe("low");
    expect(s.agent).toBe("explorer");
    expect(s.version).toBe("1.2.0");
    expect(s.argumentHint).toBe("<file>");
    expect(s.argumentNames).toEqual(["file", "line"]);
    expect(s.paths).toEqual(["pkg/**"]);
  });

  test("mode: activate 推导出 context: inline（与 P0-4 叠加后不再恒为 delegate）", async () => {
    const [s] = await discoverMcpSkills(
      provider("---\nname: a\ndescription: d\nmode: delegate\n---\nb"),
    );
    expect(s.context).toBe("fork");
    const [s2] = await discoverMcpSkills(provider("---\nname: a\ndescription: d\n---\nb"));
    expect(s2.context).toBe("inline"); // 未声明时保持 MCP 历史默认
  });

  test("安全字段刻意剔除：hooks / shell / skillRoot 恒为空", async () => {
    const [s] = await discoverMcpSkills(provider(FULL_DOC));
    expect(s.hooks).toBeUndefined();
    expect(s.shell).toBeUndefined();
    expect(s.skillRoot).toBeUndefined();
    expect(s.source).toBe("mcp");
    expect(s.loadedFrom).toBe("mcp");
  });

  test("disabled: true 的 MCP skill 被跳过（与 loader 同语义）", async () => {
    const skills = await discoverMcpSkills(
      provider("---\nname: a\ndescription: d\ndisabled: true\n---\nb"),
    );
    expect(skills.length).toBe(0);
  });

  test("带 paths 的迟到 MCP skill 过条件门，不进 listing（防 P0-6 在 MCP 路径重现）", async () => {
    const skills = await discoverMcpSkills(
      provider('---\nname: g\ndescription: d\npaths:\n  - "zzz/**"\n---\nb'),
    );
    const mgr = new SkillManager();
    const c = new SkillActivationCoordinator({
      manager: mgr,
      cwd: "/tmp/p",
      enableDynamicDiscovery: false,
    });
    c.init([]);
    expect(c.gateLateConditionalSkills(skills)).toEqual(["srv:g"]);
    mgr.addPluginSkills(skills);
    c.enqueueListingForNewSkills(skills.map((s) => s.name));
    expect(mgr.isGated("srv:g")).toBe(true);
    expect(mgr.getListableSkills().map((s) => s.name)).not.toContain("srv:g");
    expect(c.drainListingDelta() ?? "").not.toContain("srv:g");

    // 碰到匹配文件后激活
    await c.onToolResults([{ file_path: "/tmp/p/zzz/a.ts" }]);
    expect(mgr.isGated("srv:g")).toBe(false);
    expect(c.drainListingDelta() ?? "").toContain("srv:g");
  });
});

describe("P2-2 · 安全白名单的 fail-safe 方向", () => {
  const base: SkillDefinition = {
    name: "s",
    description: "d",
    prompt: "p",
    source: "user",
    filePath: "/f",
  };

  test("未分类的新属性默认需审批（此前默认放行）", () => {
    const withUnknown = { ...base, futureCapability: "x" } as unknown as SkillDefinition;
    expect(skillHasOnlySafeProperties(withUnknown)).toBe(false);
    expect(checkSkillPermission(withUnknown)).toBe("ask");
  });

  test("空值的未知属性不算提供能力", () => {
    const withEmpty = {
      ...base,
      futureCapability: undefined,
      other: [],
    } as unknown as SkillDefinition;
    expect(skillHasOnlySafeProperties(withEmpty)).toBe(true);
  });

  test("白名单不再是死代码：判定真的依赖它", () => {
    expect(SAFE_SKILL_PROPERTIES.has("paths")).toBe(true);
    expect(skillHasOnlySafeProperties({ ...base, paths: ["a/**"], version: "1" })).toBe(true);
    expect(SAFE_SKILL_PROPERTIES.has("hooks")).toBe(false);
  });

  test("分级表与 types.ts 的 SkillDefinition 字段集合完全一致（CI 不跑 tsc，靠这条兜）", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/skill/types.ts"), "utf-8");
    const body = src.slice(src.indexOf("export interface SkillDefinition {"));
    const block = body.slice(0, body.indexOf("\n}\n"));
    const fields = [...block.matchAll(/^ {2}([a-zA-Z]+)\??:/gm)].map((m) => m[1]).sort();
    expect(fields.length).toBeGreaterThan(20); // 反向自证：确实抽到了字段
    expect(Object.keys(SKILL_PROPERTY_CLASSIFICATION).sort()).toEqual(fields);
  });
});
