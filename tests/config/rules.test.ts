/**
 * CLAUDE.md 规则解析测试
 */

import { describe, test, expect } from "bun:test";
import { parseClaudeMd, mergeProjectRules } from "@sid-code/core/config/rules.ts";
import type { ProjectRules } from "@sid-code/core/config/rules.ts";

describe("parseClaudeMd", () => {
  test("解析 Instructions 段落", () => {
    const content = `# Instructions
请使用 TypeScript 编写代码。
遵循项目编码规范。`;

    const rules = parseClaudeMd(content, "/test/CLAUDE.md");
    expect(rules.instructions).toContain("请使用 TypeScript 编写代码");
    expect(rules.instructions).toContain("遵循项目编码规范");
  });

  test("解析中文标题「指令」", () => {
    const content = `# 指令
使用中文回复。`;

    const rules = parseClaudeMd(content, "/test/CLAUDE.md");
    expect(rules.instructions).toContain("使用中文回复");
  });

  test("解析 Allowed Tools", () => {
    const content = `# Allowed Tools
- Read
- Glob
- Grep`;

    const rules = parseClaudeMd(content, "/test/CLAUDE.md");
    expect(rules.allowedTools).toEqual(["Read", "Glob", "Grep"]);
  });

  test("解析中文标题「允许的工具」", () => {
    const content = `# 允许的工具
- Read
- Bash(npm *)`;

    const rules = parseClaudeMd(content, "/test/CLAUDE.md");
    expect(rules.allowedTools).toEqual(["Read", "Bash(npm *)"]);
  });

  test("解析 Disallowed Tools", () => {
    const content = `# Disallowed Tools
- Bash
- Write`;

    const rules = parseClaudeMd(content, "/test/CLAUDE.md");
    expect(rules.disallowedTools).toEqual(["Bash", "Write"]);
  });

  test("解析 Permission Mode", () => {
    const content = `# Permission Mode
acceptEdits`;

    const rules = parseClaudeMd(content, "/test/CLAUDE.md");
    expect(rules.permissionMode).toBe("acceptEdits");
  });

  test("解析 Model", () => {
    const content = `# Model
sonnet`;

    const rules = parseClaudeMd(content, "/test/CLAUDE.md");
    expect(rules.model).toBe("sonnet");
  });

  test("解析 System Prompt Addition", () => {
    const content = `# System Prompt Addition
你是一个专注于 React 开发的助手。`;

    const rules = parseClaudeMd(content, "/test/CLAUDE.md");
    expect(rules.systemPromptAddition).toContain("React 开发");
  });

  test("解析 Custom Rules", () => {
    const content = `# Custom Rules
- **Rule1**: 不要修改 package-lock.json
- **Rule2**: 测试文件放在 __tests__ 目录`;

    const rules = parseClaudeMd(content, "/test/CLAUDE.md");
    expect(rules.customRules).toHaveLength(2);
    expect(rules.customRules![0]).toContain("package-lock.json");
  });

  test("解析 Memory 键值对", () => {
    const content = `# Memory
- **ProjectType**: TypeScript
- **Framework**: React`;

    const rules = parseClaudeMd(content, "/test/CLAUDE.md");
    expect(rules.memory).toEqual({
      ProjectType: "TypeScript",
      Framework: "React",
    });
  });

  test("解析完整的 CLAUDE.md", () => {
    const content = `# 项目概述
这是一个 TypeScript CLI 工具。

# Instructions
使用 bun 作为包管理器。
不要使用 npm。

# Allowed Tools
- Read
- Grep
- Glob

# Disallowed Tools
- Bash(rm -rf *)

# Permission Mode
acceptEdits

# Model
sonnet

# Custom Rules
- **编码规范**: 使用 2 空格缩进

# Memory
- **PackageManager**: bun`;

    const rules = parseClaudeMd(content, "/project/CLAUDE.md");

    expect(rules.rawContent).toBe(content);
    expect(rules.sourcePath).toBe("/project/CLAUDE.md");
    expect(rules.instructions).toContain("bun 作为包管理器");
    expect(rules.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(rules.disallowedTools).toEqual(["Bash(rm -rf *)"]);
    expect(rules.permissionMode).toBe("acceptEdits");
    expect(rules.model).toBe("sonnet");
    expect(rules.customRules).toHaveLength(1);
    expect(rules.memory?.PackageManager).toBe("bun");
  });

  test("无结构化标题时只保留 rawContent", () => {
    const content = `这是一个简单的项目说明，没有特殊标题。

使用 TypeScript 编写。`;

    const rules = parseClaudeMd(content, "/test/CLAUDE.md");
    expect(rules.rawContent).toBe(content);
    expect(rules.instructions).toBeUndefined();
    expect(rules.allowedTools).toBeUndefined();
  });

  test("多个 Instructions 段落累积", () => {
    const content = `# Instructions
第一条指令。

# 其他内容
无关内容。

# 额外指令 Instructions
第二条指令。`;

    const rules = parseClaudeMd(content, "/test/CLAUDE.md");
    expect(rules.instructions).toContain("第一条指令");
    // 「额外指令 Instructions」标题包含 instruction，也会被识别
    expect(rules.instructions).toContain("第二条指令");
  });
});

describe("mergeProjectRules", () => {
  test("覆盖型字段：项目覆盖全局", () => {
    const global: ProjectRules = {
      rawContent: "global content",
      sourcePath: "~/.claude/CLAUDE.md",
      allowedTools: ["Read"],
      permissionMode: "default",
      model: "haiku",
    };

    const project: ProjectRules = {
      rawContent: "project content",
      sourcePath: "/project/CLAUDE.md",
      allowedTools: ["Read", "Write", "Edit"],
      model: "sonnet",
    };

    const merged = mergeProjectRules(global, project);

    // 覆盖型：项目优先
    expect(merged.allowedTools).toEqual(["Read", "Write", "Edit"]);
    expect(merged.model).toBe("sonnet");
    expect(merged.permissionMode).toBe("default"); // 项目未指定，保留全局
    expect(merged.sourcePath).toBe("/project/CLAUDE.md");
  });

  test("累积型字段：合并而非覆盖", () => {
    const global: ProjectRules = {
      rawContent: "global",
      sourcePath: "~/.claude/CLAUDE.md",
      instructions: "全局指令",
      customRules: ["规则A"],
      memory: { lang: "zh" },
    };

    const project: ProjectRules = {
      rawContent: "project",
      sourcePath: "/project/CLAUDE.md",
      instructions: "项目指令",
      customRules: ["规则B"],
      memory: { framework: "React" },
    };

    const merged = mergeProjectRules(global, project);

    // 累积型：两边都保留
    expect(merged.instructions).toContain("全局指令");
    expect(merged.instructions).toContain("项目指令");
    expect(merged.customRules).toEqual(["规则A", "规则B"]);
    expect(merged.memory).toEqual({ lang: "zh", framework: "React" });
  });

  test("memory 同 key 时项目覆盖全局", () => {
    const global: ProjectRules = {
      rawContent: "global",
      sourcePath: "~/.claude/CLAUDE.md",
      memory: { lang: "en", framework: "Vue" },
    };

    const project: ProjectRules = {
      rawContent: "project",
      sourcePath: "/project/CLAUDE.md",
      memory: { framework: "React" },
    };

    const merged = mergeProjectRules(global, project);
    expect(merged.memory).toEqual({ lang: "en", framework: "React" });
  });

  test("rawContent 拼接", () => {
    const global: ProjectRules = {
      rawContent: "全局内容",
      sourcePath: "~/.claude/CLAUDE.md",
    };

    const project: ProjectRules = {
      rawContent: "项目内容",
      sourcePath: "/project/CLAUDE.md",
    };

    const merged = mergeProjectRules(global, project);
    expect(merged.rawContent).toContain("全局内容");
    expect(merged.rawContent).toContain("项目内容");
  });

  test("一方为空时保留另一方", () => {
    const global: ProjectRules = {
      rawContent: "global",
      sourcePath: "~/.claude/CLAUDE.md",
      allowedTools: ["Read"],
      instructions: "全局指令",
    };

    const empty: ProjectRules = {
      rawContent: "",
      sourcePath: "/project/CLAUDE.md",
    };

    const merged = mergeProjectRules(global, empty);
    expect(merged.allowedTools).toEqual(["Read"]);
    expect(merged.instructions).toContain("全局指令");
  });
});
