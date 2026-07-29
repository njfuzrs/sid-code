/**
 * 系统提示词构建测试
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { buildSystemPrompt, clearPromptCache, resolvePromptMaxTokens } from "../../src/config/system-prompt.ts";
/**
 * 创建一个简单的测试工具。返回结构化对象（含 name()/description()/usageGuide()），
 * 不标注具体接口类型——buildSystemPrompt 只按结构消费 name/description/usageGuide，
 * 避免依赖已废弃的 LegacyTool 接口，也不误用不匹配的新版泛型 Tool。
 */
function makeTool(opts: { name: string; desc: string; guide?: string }) {
  return {
    name: () => opts.name,
    description: () => opts.desc,
    inputSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "" }),
    readOnly: () => true,
    ...(opts.guide ? { usageGuide: () => opts.guide! } : {}),
  };
}

describe("buildSystemPrompt", () => {
  // 每个测试前清除缓存，避免测试间干扰
  beforeEach(() => {
    clearPromptCache();
  });

  test("包含身份指令", () => {
    const prompt = buildSystemPrompt({ tools: [] });
    expect(prompt).toContain("sid-code");
    expect(prompt).toContain("AI 编程助手");
  });

  test("包含环境信息", () => {
    const prompt = buildSystemPrompt({ tools: [] });
    expect(prompt).toContain("<environment>");
    expect(prompt).toContain("工作目录");
    expect(prompt).toContain("操作系统");
    expect(prompt).toContain("当前日期");
    expect(prompt).toContain("</environment>");
  });

  test("包含行为约束", () => {
    const prompt = buildSystemPrompt({ tools: [] });
    expect(prompt).toContain("<constraints>");
    expect(prompt).toContain("中文");
    expect(prompt).toContain("</constraints>");
  });

  test("无工具时不包含工具指南", () => {
    const prompt = buildSystemPrompt({ tools: [] });
    expect(prompt).not.toContain("<tool-guide>");
  });

  test("有工具时包含工具列表", () => {
    const tools = [
      makeTool({ name: "read", desc: "读取文件" }),
      makeTool({ name: "write", desc: "写入文件" }),
    ];
    const prompt = buildSystemPrompt({ tools });
    expect(prompt).toContain("<tool-guide>");
    expect(prompt).toContain("read: 读取文件");
    expect(prompt).toContain("write: 写入文件");
    expect(prompt).toContain("</tool-guide>");
  });

  test("工具自带 usageGuide 会被包含", () => {
    const tools = [
      makeTool({ name: "bash", desc: "执行命令", guide: "不要用 bash cat 读文件" }),
    ];
    const prompt = buildSystemPrompt({ tools });
    expect(prompt).toContain("bash 工具使用指南");
    expect(prompt).toContain("不要用 bash cat 读文件");
  });

  test("没有 usageGuide 的工具不会生成额外指南", () => {
    const tools = [
      makeTool({ name: "read", desc: "读取文件" }),
    ];
    const prompt = buildSystemPrompt({ tools });
    expect(prompt).not.toContain("read 工具使用指南");
  });

  test("包含项目规则", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      projectRules: "# 项目规则\n使用 TypeScript",
    });
    expect(prompt).toContain("<system-reminder>");
    expect(prompt).toContain("使用 TypeScript");
    expect(prompt).toContain("覆盖任何默认行为");
  });

  test("包含项目规则来源路径", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      projectRules: "规则内容",
      projectRulesPath: "/project/CLAUDE.md",
    });
    expect(prompt).toContain("Contents of /project/CLAUDE.md");
  });

  test("包含追加提示词", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      appendPrompt: "额外指令",
    });
    expect(prompt).toContain("额外指令");
  });

  test("包含文件提示词", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      filePrompt: "从文件加载的提示词",
    });
    expect(prompt).toContain("从文件加载的提示词");
  });

  // === 新增：动态附件测试 ===

  test("包含 Git 状态附件", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      workingDir: process.cwd(),
      gitStatus: true,
    });
    expect(prompt).toContain("<git-status>");
    expect(prompt).toContain("Current branch:");
    // 防死锁哨兵：git-status 块必须带"启动快照、不会更新"的仲裁锚点（对标 CC）。
    expect(prompt).toContain("snapshot in time");
  });

  test("不请求 Git 状态时不包含", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      gitStatus: false,
    });
    expect(prompt).not.toContain("<git-status>");
  });

  test("包含权限模式附件（非默认模式）", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      permissionMode: "plan",
    });
    expect(prompt).toContain("计划模式已激活");
  });

  test("默认权限模式不注入附件", () => {
    const prompt1 = buildSystemPrompt({ tools: [] });
    const prompt2 = buildSystemPrompt({ tools: [], permissionMode: "default" });
    // 默认模式不注入权限附件
    expect(prompt1).not.toContain("权限模式");
    expect(prompt2).not.toContain("权限模式");
  });

  test("包含诊断信息附件", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      diagnostics: "Error: 类型不匹配 at line 42",
    });
    expect(prompt).toContain("<diagnostics>");
    expect(prompt).toContain("类型不匹配");
  });

  // 「包含 IDE 选中代码附件」用例已删除：IDE 选区/@提及不再进 system prompt
  // （改走 drainIDEContextDelta 消息通道，避免每次点选击穿静态前缀缓存）。

  test("包含 Todo 列表附件", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      todoList: "- [ ] 修复 bug\n- [x] 写测试",
    });
    expect(prompt).toContain("<todo-list>");
    expect(prompt).toContain("修复 bug");
  });

  test("附件按优先级排序", () => {
    const prompt = buildSystemPrompt({
      tools: [],
      projectRules: "RULES_MARKER",
      todoList: "TODO_MARKER",
      appendPrompt: "APPEND_MARKER",
    });
    // CLAUDE.md (priority 10) 应在 Todo (35) 之前，Todo 在 Append (50) 之前
    const rulesIdx = prompt.indexOf("RULES_MARKER");
    const todoIdx = prompt.indexOf("TODO_MARKER");
    const appendIdx = prompt.indexOf("APPEND_MARKER");
    expect(rulesIdx).toBeLessThan(todoIdx);
    expect(todoIdx).toBeLessThan(appendIdx);
  });

  // === 缓存测试 ===

  test("相同上下文使用缓存", () => {
    const ctx = { tools: [], projectRules: "缓存测试规则" };
    const prompt1 = buildSystemPrompt(ctx);
    const prompt2 = buildSystemPrompt(ctx);
    // 内容应该完全相同（来自缓存）
    expect(prompt1).toBe(prompt2);
  });

  test("不同上下文不使用缓存", () => {
    const prompt1 = buildSystemPrompt({ tools: [], projectRules: "规则A" });
    const prompt2 = buildSystemPrompt({ tools: [], projectRules: "规则B" });
    expect(prompt1).not.toBe(prompt2);
    expect(prompt1).toContain("规则A");
    expect(prompt2).toContain("规则B");
  });

  test("clearPromptCache 清除缓存", () => {
    const ctx = { tools: [], projectRules: "清除缓存测试" };
    const prompt1 = buildSystemPrompt(ctx);
    clearPromptCache();
    const prompt2 = buildSystemPrompt(ctx);
    // 内容相同但确实重新构建了（无法直接验证，但至少不报错）
    expect(prompt1).toBe(prompt2);
  });

  // 必删-4：身份指令的"铁律级"语言约束措辞改由能力标志 reasoningLanguageDrift 驱动，
  // 而非 model.includes("deepseek") 字符串匹配。
  describe("身份指令语言约束（必删-4：能力标志驱动，非模型名硬编码）", () => {
    const IRON_LAW = "【不可违反的铁律】";

    test("reasoningLanguageDrift=true 的模型走铁律级措辞", () => {
      // deepseek-v4-pro / deepseek-reasoner 在注册表声明了 reasoningLanguageDrift:true
      const p1 = buildSystemPrompt({ tools: [], model: "deepseek-v4-pro" });
      expect(p1).toContain(IRON_LAW);
      clearPromptCache();
      const p2 = buildSystemPrompt({ tools: [], model: "deepseek-reasoner" });
      expect(p2).toContain(IRON_LAW);
    });

    test("模型名带日期后缀 / 大小写变体仍能命中（catalog 前缀+大小写匹配）", () => {
      const p1 = buildSystemPrompt({ tools: [], model: "deepseek-v4-pro-0711" });
      expect(p1).toContain(IRON_LAW);
      clearPromptCache();
      const p2 = buildSystemPrompt({ tools: [], model: "DeepSeek-V4-Pro" });
      expect(p2).toContain(IRON_LAW);
    });

    test("无漂移倾向的模型（Claude）走标准措辞，不含铁律", () => {
      const p = buildSystemPrompt({ tools: [], model: "claude-sonnet-4-20250514" });
      expect(p).not.toContain(IRON_LAW);
      // 标准措辞仍是合法身份段
      expect(p).toContain("sid-code");
    });

    test("无 model 时不走铁律（缺省 false）", () => {
      const p = buildSystemPrompt({ tools: [] });
      expect(p).not.toContain(IRON_LAW);
    });

    test("英文模式不受 reasoningLanguageDrift 影响（走英文语言规则分支）", () => {
      const p = buildSystemPrompt({ tools: [], model: "deepseek-v4-pro", preferredLanguage: "en" });
      expect(p).not.toContain(IRON_LAW);
    });
  });
});

describe("#11 resolvePromptMaxTokens（系统提示词预算动态化）", () => {
  test("显式 ctx.maxTokens 优先", () => {
    expect(resolvePromptMaxTokens({ tools: [], maxTokens: 12345 })).toBe(12345);
  });

  test("无显式值时按模型 contextWindow 的 90% 推导（1M 窗口不再卡 180K）", () => {
    // deepseek 系 1M 窗口 → 0.9M，远大于历史写死的 180000
    expect(resolvePromptMaxTokens({ tools: [], model: "deepseek-v4-pro" })).toBe(900_000);
    // Claude 200K → 180K（恰好与历史值一致，验证不退步）
    expect(resolvePromptMaxTokens({ tools: [], model: "claude-sonnet-4-20250514" })).toBe(180_000);
  });

  test("availableModels 声明的 contextWindow 是权威源", () => {
    expect(
      resolvePromptMaxTokens({
        tools: [],
        model: "my-custom",
        availableModels: [{ name: "my-custom", contextWindow: 500_000 }],
      }),
    ).toBe(450_000);
  });

  test("无 model 时回退历史安全值 180000", () => {
    expect(resolvePromptMaxTokens({ tools: [] })).toBe(180_000);
  });
});
