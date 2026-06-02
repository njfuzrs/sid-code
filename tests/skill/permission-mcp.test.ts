/**
 * Skill 权限控制 + MCP Skill 发现测试（Task 5）
 */

import { describe, test, expect } from "bun:test";
import {
  checkSkillPermission,
  skillHasOnlySafeProperties,
} from "../../src/skill/permission.ts";
import { discoverMcpSkills } from "../../src/mcp/skill-discovery.ts";
import type { SkillDefinition } from "../../src/skill/types.ts";

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "s",
    description: "desc",
    prompt: "body",
    source: "user",
    filePath: "/tmp/s/SKILL.md",
    ...overrides,
  };
}

describe("skillHasOnlySafeProperties", () => {
  test("纯安全属性 → true", () => {
    expect(skillHasOnlySafeProperties(makeSkill())).toBe(true);
  });

  test("带 hooks → false", () => {
    expect(
      skillHasOnlySafeProperties(
        makeSkill({ hooks: { PostToolUse: [] } }),
      ),
    ).toBe(false);
  });

  test("带 allowedTools → false", () => {
    expect(
      skillHasOnlySafeProperties(makeSkill({ allowedTools: ["bash"] })),
    ).toBe(false);
  });

  test("空 allowedTools 数组 → true（无敏感能力）", () => {
    expect(
      skillHasOnlySafeProperties(makeSkill({ allowedTools: [] })),
    ).toBe(true);
  });
});

describe("checkSkillPermission", () => {
  test("deny 规则最高优先级", () => {
    expect(
      checkSkillPermission(makeSkill({ name: "x" }), { deny: ["x"], allow: ["x"] }),
    ).toBe("deny");
  });

  test("allow 规则放行", () => {
    expect(
      checkSkillPermission(makeSkill({ name: "x", hooks: { Stop: [] } }), {
        allow: ["x"],
      }),
    ).toBe("allow");
  });

  test("纯安全属性默认 allow", () => {
    expect(checkSkillPermission(makeSkill())).toBe("allow");
  });

  test("带敏感属性默认 ask", () => {
    expect(
      checkSkillPermission(makeSkill({ allowedTools: ["bash"] })),
    ).toBe("ask");
  });

  test("MCP 来源带敏感属性 → ask", () => {
    expect(
      checkSkillPermission(
        makeSkill({ loadedFrom: "mcp", source: "mcp", allowedTools: ["bash"] }),
      ),
    ).toBe("ask");
  });

  test("通配 * deny", () => {
    expect(checkSkillPermission(makeSkill(), { deny: ["*"] })).toBe("deny");
  });
});

describe("discoverMcpSkills", () => {
  const skillDoc = `---
name: remote-helper
description: 远程辅助 Skill
when-to-use: 需要远程能力时
context: inline
---
执行远程任务: {{args}}`;

  function makeProvider(resources: Array<{ uri: string; name: string }>, body = skillDoc) {
    return {
      getAllResources() {
        return resources.map((r) => ({
          serverName: "srv",
          resource: { uri: r.uri, name: r.name },
        }));
      },
      async readResource(_serverName: string, _uri: string) {
        return body;
      },
    };
  }

  test("发现 skill:// 资源并解析 frontmatter", async () => {
    const skills = await discoverMcpSkills(
      makeProvider([{ uri: "skill://remote-helper", name: "remote-helper" }]),
    );
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe("srv:remote-helper");
    expect(skills[0].source).toBe("mcp");
    expect(skills[0].loadedFrom).toBe("mcp");
    expect(skills[0].description).toBe("远程辅助 Skill");
    expect(skills[0].context).toBe("inline");
  });

  test("忽略非 skill:// 资源", async () => {
    const skills = await discoverMcpSkills(
      makeProvider([
        { uri: "file://readme.md", name: "readme" },
        { uri: "skill://x", name: "x" },
      ]),
    );
    // 只有 skill:// 资源被发现（frontmatter name 优先，故为 remote-helper）
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe("srv:remote-helper");
  });

  test("跳过缺少 description 的资源", async () => {
    const skills = await discoverMcpSkills(
      makeProvider([{ uri: "skill://nodesc", name: "nodesc" }], "---\nname: nodesc\n---\nbody"),
    );
    expect(skills.length).toBe(0);
  });
});
