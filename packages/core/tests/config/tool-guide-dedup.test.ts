/**
 * F5-Q5a：已加载工具的使用指南只发一份（tools[].description），不在 system `<tool-guide>` 重复。
 *
 * 背景：toolToDefinition（registry.ts）把 usageGuide 拼进 description，buildToolGuideSection
 * 又把同一段渲染成「### X 工具使用指南」。F3 首调实测 13 段与描述 8-gram 重合 0.85–0.99，
 * 约 2.4K tokens/调用。开关 SID_CODE_TOOL_GUIDE_DEDUP=1 时去掉 system 那份，做双模型 A/B。
 *
 * 本文件锁四件事：
 *  1. 开关关（默认）：行为与修改前完全一致
 *  2. 开关开：已加载工具的指南不在 system，但仍在发给模型的 tools[].description 里
 *  3. 开关开：延迟工具的指南照旧留在延迟分区（它们首轮不在 tools[] 里，删了就彻底看不见）
 *  4. 缓存键区分两臂（开关不在 ctx 里，漏进键会让同进程切换命中另一臂）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  buildSystemPrompt,
  clearPromptCache,
  generateCacheKey,
} from "@sid-code/core/config/system-prompt.ts";
import { DEFERRED_MARK } from "@sid-code/core/config/deferred-tool-view.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";

const ENV = "SID_CODE_TOOL_GUIDE_DEDUP";

function makeTool(opts: { name: string; guide?: string; shouldDefer?: boolean }) {
  return {
    name: () => opts.name,
    description: () => `${opts.name} 的一句话说明`,
    inputSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "" }),
    readOnly: () => true,
    ...(opts.guide ? { usageGuide: () => opts.guide! } : {}),
    ...(opts.shouldDefer ? { shouldDefer: true } : {}),
  };
}

const BASH_GUIDE = "不要用 bash cat 读文件，改用 read";
const WORKFLOW_GUIDE = "workflow 的完整使用指南正文";

function tools() {
  return [
    makeTool({ name: "bash", guide: BASH_GUIDE }),
    makeTool({ name: "workflow", shouldDefer: true, guide: WORKFLOW_GUIDE }),
  ];
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[ENV];
  clearPromptCache();
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
  clearPromptCache();
});

describe("F5-Q5a 工具指南去重", () => {
  test("开关关（默认）：已加载工具指南仍在 system", () => {
    delete process.env[ENV];
    const prompt = buildSystemPrompt({ tools: tools() });
    expect(prompt).toContain("### bash 工具使用指南");
    expect(prompt).toContain(BASH_GUIDE);
  });

  test("开关开：已加载工具指南不在 system，一行摘要还在", () => {
    process.env[ENV] = "1";
    const prompt = buildSystemPrompt({ tools: tools() });
    expect(prompt).not.toContain("### bash 工具使用指南");
    expect(prompt).not.toContain(BASH_GUIDE);
    expect(prompt).toContain("- bash: bash 的一句话说明");
  });

  test("开关开：指南仍在发给模型的 tools[].description 里（只是不再发两遍）", () => {
    process.env[ENV] = "1";
    const registry = new Registry();
    registry.register(makeTool({ name: "bash", guide: BASH_GUIDE }) as any);
    const def = registry.definitions().find((d) => d.name === "bash");
    expect(def?.description).toContain(BASH_GUIDE);
  });

  test("开关开：延迟工具的指南照旧留在延迟分区", () => {
    process.env[ENV] = "1";
    const prompt = buildSystemPrompt({ tools: tools() });
    expect(prompt).toContain(`### workflow 工具使用指南 ${DEFERRED_MARK}`);
    expect(prompt).toContain(WORKFLOW_GUIDE);
  });

  test("英文档同样生效", () => {
    process.env[ENV] = "1";
    const prompt = buildSystemPrompt({ tools: tools(), preferredLanguage: "en" });
    expect(prompt).not.toContain("### bash usage guide");
    expect(prompt).not.toContain(BASH_GUIDE);
  });

  test("缓存键区分两臂，同进程切换开关不串味", () => {
    const ctx = { tools: tools() };
    delete process.env[ENV];
    const off = generateCacheKey(ctx);
    const promptOff = buildSystemPrompt(ctx);
    process.env[ENV] = "1";
    const on = generateCacheKey(ctx);
    const promptOn = buildSystemPrompt(ctx);
    expect(on).not.toBe(off);
    expect(promptOff).toContain(BASH_GUIDE);
    expect(promptOn).not.toContain(BASH_GUIDE);
  });
});
