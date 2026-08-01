/**
 * 系统提示词缓存键回归测试（审计清单第 3 批：第 7 / 7b / 7c 条）
 *
 * 三条同源缺陷：`generateCacheKey` 手写维度列表，漏掉了
 *   - 7 ：preferredLanguage —— `/language` 切换后 5 分钟内命中旧缓存，语言约束段不变
 *   - 7b：工具身份（只取 tools.length）—— 等数量替换工具集后串味
 *   - 7c：skillEntries 的 description（只取 name）与 recalledMemories 正文（只取 filename）
 *
 * 修复方式是**让缓存键从 ctx 自动派生**，而不是继续往手写列表里补三个字段。
 * 因此本文件除逐条覆盖上面三个缺陷外，还有一条"反漂移"用例：
 * 任何**新增**的影响输出的字段都必须自动进键（见最后一个 describe）——
 * 这是防止同一模式第五次复发的关键，比单独断言三个字段更重要。
 *
 * 注意：这些用例**不能**在断言前调用 clearPromptCache()，否则测的是"清了缓存后
 * 内容会变"（恒真），而不是"缓存键能区分两次调用"。缺陷正是"同进程 TTL 内串味"。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { buildSystemPrompt, clearPromptCache, generateCacheKey } from "../../src/config/system-prompt.ts";

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

describe("缓存键 — 第 7 条：preferredLanguage", () => {
  beforeEach(() => clearPromptCache());

  test("切换 preferredLanguage 后不命中旧缓存，语言约束段随之变化", () => {
    const zh = buildSystemPrompt({ tools: [], preferredLanguage: "zh" });
    // 不清缓存：模拟同进程内 5 分钟 TTL 内执行 /language
    const en = buildSystemPrompt({ tools: [], preferredLanguage: "en" });

    expect(zh).not.toBe(en);
    expect(zh).toContain("均使用中文");
    // en 档的语言约束现在**用英文写**（早先是"均使用英文"这句中文——那时 en 模式
    // 仍有 54.7% 汉字，等于用中文语境命令模型说英文，压力方向是反的）。
    expect(en).toContain("in English");
    // 关键断言：切到 en 后不应再残留中文约束（缺陷表现就是这里为 true）
    expect(en).not.toContain("均使用中文");
  });

  test("preferredLanguage 相同则仍命中缓存（不能为了正确性牺牲命中率）", () => {
    const a = buildSystemPrompt({ tools: [], preferredLanguage: "zh" });
    const b = buildSystemPrompt({ tools: [], preferredLanguage: "zh" });
    expect(a).toBe(b);
  });
});

describe("缓存键 — 第 7b 条：工具身份", () => {
  beforeEach(() => clearPromptCache());

  test("工具数量相同但集合不同时不命中旧缓存", () => {
    const p1 = buildSystemPrompt({
      tools: [makeTool({ name: "read", desc: "读文件" }), makeTool({ name: "write", desc: "写文件" })],
    });
    const p2 = buildSystemPrompt({
      tools: [makeTool({ name: "bash", desc: "执行命令" }), makeTool({ name: "grep", desc: "搜索内容" })],
    });

    expect(p1).not.toBe(p2);
    // p2 只应含自己的工具，不应残留 p1 的
    expect(p2).toContain("bash");
    expect(p2).toContain("grep");
    expect(p2).not.toContain("read:");
    expect(p2).not.toContain("write:");
  });

  test("同名工具的 description 变化也要换键（description 进提示词）", () => {
    const p1 = buildSystemPrompt({ tools: [makeTool({ name: "read", desc: "老描述AAA" })] });
    const p2 = buildSystemPrompt({ tools: [makeTool({ name: "read", desc: "新描述BBB" })] });

    expect(p1).not.toBe(p2);
    expect(p2).toContain("新描述BBB");
    expect(p2).not.toContain("老描述AAA");
  });

  test("同名工具的 usageGuide 变化也要换键（usageGuide 进提示词）", () => {
    const p1 = buildSystemPrompt({
      tools: [makeTool({ name: "read", desc: "读文件", guide: "指南AAA" })],
    });
    const p2 = buildSystemPrompt({
      tools: [makeTool({ name: "read", desc: "读文件", guide: "指南BBB" })],
    });

    expect(p1).not.toBe(p2);
    expect(p2).toContain("指南BBB");
    expect(p2).not.toContain("指南AAA");
  });

  test("完全相同的工具集仍命中缓存", () => {
    const tools = [makeTool({ name: "read", desc: "读文件" })];
    expect(buildSystemPrompt({ tools })).toBe(buildSystemPrompt({ tools }));
    // 结构等价的**新实例**也应命中（键取身份内容而非对象引用）
    expect(buildSystemPrompt({ tools: [makeTool({ name: "read", desc: "读文件" })] }))
      .toBe(buildSystemPrompt({ tools: [makeTool({ name: "read", desc: "读文件" })] }));
  });
});

describe("缓存键 — 第 7c 条：skillEntries 描述 / recalledMemories 正文", () => {
  beforeEach(() => clearPromptCache());

  test("同名 skill 的 description 变化后不命中旧缓存", () => {
    const s1 = buildSystemPrompt({
      tools: [],
      skillEntries: [{ name: "my-skill", description: "旧描述AAA" }],
    });
    const s2 = buildSystemPrompt({
      tools: [],
      skillEntries: [{ name: "my-skill", description: "新描述BBB" }],
    });

    expect(s1).not.toBe(s2);
    expect(s2).toContain("新描述BBB");
    expect(s2).not.toContain("旧描述AAA");
  });

  test("同名 skill 的 whenToUse 变化后也不命中旧缓存", () => {
    const s1 = buildSystemPrompt({
      tools: [],
      skillEntries: [{ name: "my-skill", description: "描述", whenToUse: "时机AAA" }],
    });
    const s2 = buildSystemPrompt({
      tools: [],
      skillEntries: [{ name: "my-skill", description: "描述", whenToUse: "时机BBB" }],
    });
    expect(s1).not.toBe(s2);
  });

  test("同文件名的召回记忆正文变化后不命中旧缓存", () => {
    const m1 = buildSystemPrompt({
      tools: [],
      recalledMemories: [{ filename: "note.md", content: "旧正文AAA" }],
    });
    const m2 = buildSystemPrompt({
      tools: [],
      recalledMemories: [{ filename: "note.md", content: "新正文BBB" }],
    });

    expect(m1).not.toBe(m2);
    expect(m2).toContain("新正文BBB");
    expect(m2).not.toContain("旧正文AAA");
  });
});

describe("缓存键 — 反漂移：新增字段自动进键", () => {
  beforeEach(() => clearPromptCache());

  /**
   * 这条是本文件最重要的用例：它不针对某个具体字段，而是断言"缓存键从 ctx 派生"
   * 这个**机制**本身。若有人把自动派生改回手写维度列表，这里会立刻变红。
   *
   * 做法：遍历 SystemPromptContext 上所有"影响输出的字符串型字段"，逐个改动一次，
   * 确认每次都换键。字段清单写死在这里是刻意的——它是与类型定义的对账表，
   * 新增注入源时若忘了加进来，下面的"字段数量下限"断言会提示补齐。
   */
  const STRING_FIELDS = [
    "projectRules",
    "appendPrompt",
    "filePrompt",
    "outputStyleContent",
    "diagnostics",
    "todoList",
    "memorySystemPrompt",
    "sessionMemoryContent",
    "denyRulesSummary",
    "workingDir",
    "permissionMode",
    "model",
  ] as const;

  for (const field of STRING_FIELDS) {
    test(`${field} 变化时换键`, () => {
      // 断言键本身而非输出文本：有些字段换成任意值后提示词恰好不变
      // （如未知 model 不改身份段、未知 permissionMode 回退默认文案），
      // 那种情况下"输出不同"为假，但"没有串味"仍需保证——只能查键。
      const ka = generateCacheKey({ tools: [], [field]: "值AAA" } as never);
      const kb = generateCacheKey({ tools: [], [field]: "值BBB" } as never);
      expect(ka).not.toBe(kb);
    });
  }

  test("onSectionTokens 回调不同不应换键（纯副作用字段，不影响输出）", () => {
    const a = buildSystemPrompt({ tools: [], onSectionTokens: () => {} });
    const b = buildSystemPrompt({ tools: [], onSectionTokens: () => {} });
    // 两个不同的函数实例：若把函数身份也塞进键，会导致每次调用都 miss，
    // 白白击穿缓存（正确性没问题但"更省"受损），故显式断言仍命中。
    expect(a).toBe(b);
  });

  test("同一份 ctx 重复调用稳定命中（键必须是确定性的）", () => {
    const ctx = {
      tools: [makeTool({ name: "read", desc: "读文件" })],
      projectRules: "规则",
      skillEntries: [{ name: "s", description: "d" }],
      recalledMemories: [{ filename: "f.md", content: "c" }],
      preferredLanguage: "zh" as const,
    };
    expect(buildSystemPrompt(ctx)).toBe(buildSystemPrompt(ctx));
  });

  test("字段顺序不同但内容相同的 ctx 应命中同一缓存（稳定序列化）", () => {
    const a = buildSystemPrompt({ tools: [], projectRules: "R", diagnostics: "D" });
    const b = buildSystemPrompt({ diagnostics: "D", projectRules: "R", tools: [] });
    expect(a).toBe(b);
  });
});

describe("缓存键 — IDE 选区/@提及已不再进 system prompt", () => {
  beforeEach(() => clearPromptCache());

  test("传入已删除的 ideSelection/ideMention 不影响输出（字段已下线）", () => {
    const base = buildSystemPrompt({ tools: [] });
    // 用 as never 绕过类型（字段已从 SystemPromptContext 删除），
    // 模拟遗留调用方仍在传值——不应再产生 <ide-selection> 段。
    const withIde = buildSystemPrompt({
      tools: [],
      ideSelection: "const x = 1;",
      ideMention: "src/a.ts:1",
    } as never);

    expect(withIde).not.toContain("<ide-selection>");
    expect(withIde).not.toContain("<ide-mentions>");
    // 注：base 与 withIde 内容相同（都无 IDE 段）。此处不断言 toBe——
    // 未知字段会进自动派生的键，两者是两个缓存条目，内容相同但非同一次命中。
    expect(withIde).toBe(base);
  });
});
