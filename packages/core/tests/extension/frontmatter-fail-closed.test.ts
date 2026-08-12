/**
 * 审计第 4 条回归测试 — frontmatter 畸形必须 fail-closed，不得静默降级
 *
 * 缺陷：`parseFrontmatter` 找不到闭合 `---` 时整体 fallback 为"当作正文"，于是
 *   ① 原始 YAML（含 allowed-tools / model / tools）被当自然语言指令喂给模型；
 *   ② allowedTools / model / tools 白名单随解析失败一起消失——降级方向**更宽松**：
 *      自定义命令从"fork 子代理受限执行"退化为"inline 注入主对话、无工具限制"，
 *      插件 agent 的 `tools:` 白名单丢失后拿到全部工具。
 * 全程无报错无告警。
 *
 * 关键对照：修复不能一刀切。"文件本来就没有 frontmatter" 是合法的纯 markdown，
 * 必须继续正常加载，否则会误伤大量合法扩展文件（见 loader.test.ts 同名对照用例）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomCommandLoader } from "@sid-code/cli/command/custom.ts";
import { loadAgentsForPlugin } from "@sid-code/cli/plugin/loadPluginAgents.ts";
import { loadCommandsForPlugin } from "@sid-code/cli/plugin/loadPluginCommands.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fm-failclosed-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 缺闭合 `---` 的自定义命令（发现清单第 4 条的原始复现形态） */
const MALFORMED_COMMAND = `---
allowed-tools: Read
model: haiku
description: 只读安全审查
请审查代码
`;

const WELL_FORMED_COMMAND = `---
allowed-tools: Read
description: 只读安全审查
---
请审查代码
`;

const NO_FRONTMATTER_COMMAND = `请审查代码，这里没有 frontmatter
`;

describe("自定义命令：frontmatter 畸形 fail-closed（审计第 4 条）", () => {
  test("缺闭合分隔符 → 不加载该命令（不再以无限制 inline 执行）", async () => {
    const dir = join(root, ".sid-code", "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "audit.md"), MALFORMED_COMMAND);

    const loaded = await new CustomCommandLoader().loadAll(root);
    expect(loaded.find((c) => c.cmd.name() === "audit")).toBeUndefined();
  });

  test("格式正确 → 正常加载且保留 allowed-tools 约束", async () => {
    const dir = join(root, ".sid-code", "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "audit.md"), WELL_FORMED_COMMAND);

    const loaded = await new CustomCommandLoader().loadAll(root);
    const cmd = loaded.find((c) => c.cmd.name() === "audit");
    expect(cmd).toBeDefined();
    expect(cmd!.cmd.description()).toBe("只读安全审查");
  });

  test("本来就没有 frontmatter → 仍正常加载（防一刀切误伤）", async () => {
    const dir = join(root, ".sid-code", "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plain.md"), NO_FRONTMATTER_COMMAND);

    const loaded = await new CustomCommandLoader().loadAll(root);
    expect(loaded.find((c) => c.cmd.name() === "plain")).toBeDefined();
  });
});

describe("插件 Agent / 命令：frontmatter 畸形 fail-closed（审计第 4 条）", () => {
  test("插件 Agent 缺闭合分隔符 → 不加载（否则 tools 白名单丢失，拿到全部工具）", async () => {
    const dir = join(root, "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auditor.md"),
      `---
name: readonly-auditor
tools: [read, grep]
只读审计
`,
    );

    const agents = await loadAgentsForPlugin({ name: "p", agentsPaths: [dir] } as never);
    expect(agents.length).toBe(0);
  });

  test("插件 Agent 格式正确 → 正常加载且 tools 白名单保留", async () => {
    const dir = join(root, "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auditor.md"),
      `---
name: readonly-auditor
description: 只读审计
tools: [read, grep]
---
只读审计
`,
    );

    const agents = await loadAgentsForPlugin({ name: "p", agentsPaths: [dir] } as never);
    expect(agents.length).toBe(1);
    expect(agents[0]!.tools).toEqual(["read", "grep"]);
  });

  test("插件命令缺闭合分隔符 → 不加载（否则 YAML 原文被当指令）", async () => {
    const dir = join(root, "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "audit.md"),
      `---
description: 只读安全审查
请审查代码
`,
    );

    const cmds = await loadCommandsForPlugin({ name: "p", commandsPaths: [dir] } as never);
    expect(cmds.length).toBe(0);
  });
});
