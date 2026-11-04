/**
 * F5-Q5a：已加载工具的使用指南只发一份（tools[].description），不在 system `<tool-guide>` 重复。
 *
 * 背景：toolToDefinition（registry.ts）把 usageGuide 拼进 description，buildToolGuideSection
 * 原先又把同一段渲染成「### X 工具使用指南」。F3 首调实测 13 段与描述 8-gram 重合 0.85–0.99，
 * 约 3.3K tokens/调用。flash 每臂 5 次 A/B 后改为默认（bench_fix 06a）。
 *
 * 本文件锁三件事：
 *  1. 已加载工具的指南不在 system（中英文档都是），一行摘要还在
 *  2. 指南仍在发给模型的 tools[].description 里——删的是重复，不是指南本身
 *  3. 延迟工具的指南照旧留在延迟分区（它们首轮不在 tools[] 里，删了就彻底看不见）
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { buildSystemPrompt, clearPromptCache } from "@sid-code/core/config/system-prompt.ts";
import { DEFERRED_MARK } from "@sid-code/core/config/deferred-tool-view.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";

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

beforeEach(() => clearPromptCache());

describe("F5-Q5a 工具指南去重", () => {
  test("已加载工具指南不在 system，一行摘要还在", () => {
    const prompt = buildSystemPrompt({ tools: tools() });
    expect(prompt).not.toContain("### bash 工具使用指南");
    expect(prompt).not.toContain(BASH_GUIDE);
    expect(prompt).toContain("- bash: bash 的一句话说明");
  });

  test("指南仍在发给模型的 tools[].description 里（只是不再发两遍）", () => {
    const registry = new Registry();
    registry.register(makeTool({ name: "bash", guide: BASH_GUIDE }) as any);
    const def = registry.definitions().find((d) => d.name === "bash");
    expect(def?.description).toContain(BASH_GUIDE);
  });

  test("延迟工具的指南照旧留在延迟分区", () => {
    const prompt = buildSystemPrompt({ tools: tools() });
    expect(prompt).toContain(`### workflow 工具使用指南 ${DEFERRED_MARK}`);
    expect(prompt).toContain(WORKFLOW_GUIDE);
  });

  test("英文档同样不重复", () => {
    const prompt = buildSystemPrompt({ tools: tools(), preferredLanguage: "en" });
    expect(prompt).not.toContain("### bash usage guide");
    expect(prompt).not.toContain(BASH_GUIDE);
    expect(prompt).toContain(WORKFLOW_GUIDE);
  });
});

/**
 * F5-Q5b（A/B 开关 SID_CODE_Q5BD=1）：延迟工具的完整指南也不进 system，只留名单行；
 * 激活后该工具经 activeDefinitions → toolToDefinition 带着指南进 tools[]（bench_fix 06b §2）。
 */
describe("F5-Q5b 延迟工具指南移出 system（开关）", () => {
  function withQ5bd<T>(fn: () => T): T {
    const prev = process.env.SID_CODE_Q5BD;
    process.env.SID_CODE_Q5BD = "1";
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.SID_CODE_Q5BD;
      else process.env.SID_CODE_Q5BD = prev;
    }
  }

  test("开关开：延迟分区只剩名单行，整段指南不在（中英文档）", () => {
    for (const lang of [undefined, "en"] as const) {
      clearPromptCache();
      const prompt = withQ5bd(() => buildSystemPrompt({ tools: tools(), preferredLanguage: lang }));
      expect(prompt).not.toContain(WORKFLOW_GUIDE);
      expect(prompt).not.toContain("### workflow 工具使用指南");
      expect(prompt).toContain("- workflow:");
    }
  });

  test("开关进缓存键：同进程切换不串臂", () => {
    const off = buildSystemPrompt({ tools: tools() });
    const on = withQ5bd(() => buildSystemPrompt({ tools: tools() }));
    expect(off).toContain(WORKFLOW_GUIDE);
    expect(on).not.toContain(WORKFLOW_GUIDE);
  });

  test("激活后的定义带指南——删的是 system 里那份预告，不是指南本身", () => {
    const registry = new Registry();
    registry.register(
      makeTool({ name: "workflow", shouldDefer: true, guide: WORKFLOW_GUIDE }) as any,
    );
    expect(registry.activeDefinitions().map((d) => d.name)).not.toContain("workflow");
    registry.activateTool("workflow");
    const def = registry.activeDefinitions().find((d) => d.name === "workflow");
    expect(def?.description).toContain(WORKFLOW_GUIDE);
  });
});
