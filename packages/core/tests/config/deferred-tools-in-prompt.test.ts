/**
 * 延迟工具不得混入系统提示词的「可直接调用」清单 —— 回归门禁。
 *
 * 事故形态（轨迹 20260817-141456-065fe328）：`enter_worktree` 声明 shouldDefer=true，
 * registry 已把它排除出真实 API tools[]（实测首轮 25 个工具无它），但系统提示词文本仍原样
 * 列出 `- enter_worktree: ...`，与真实工具**同格式无标注**。模型"知道"这个名字却从未见过
 * 它的 schema，生成阶段坍缩成当轮唯一共享 `enter_` 前缀的 `enter_plan_mode` —— 实测误触
 * 5 次、4 份无用 plan 文件、任务卡死到用户手动打断。
 *
 * 本文件锁四件事：
 *  1. 分区与标注（L1 toolList / L2 customGuides / L3 scheduling / L4 MCP）
 *  2. **不剔除**延迟工具（剔除会让模型完全失去"能力存在、需先 tool_search"的线索）
 *  3. **运行时态不进静态前缀**（反向门禁）—— 提示词落在 DYNAMIC_BOUNDARY 之前，
 *     把 activatedTools 之类渲进去就是 prompt cache 前缀击穿
 *  4. coordinator 的 worker 工具清单**刻意不过滤**（判据不同，见对应 test 的注释）
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  buildSystemPrompt,
  clearPromptCache,
  generateCacheKey,
} from "@sid-code/core/config/system-prompt.ts";
import {
  isStaticallyDeferred,
  partitionByDeferral,
  DEFERRED_MARK,
  DEFERRED_MARK_EN,
} from "@sid-code/core/config/deferred-tool-view.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import { setCoordinatorMode } from "@sid-code/core/coordinator/mode.ts";

function makeTool(opts: {
  name: string;
  desc?: string;
  guide?: string;
  shouldDefer?: boolean;
  alwaysLoad?: boolean;
}) {
  return {
    name: () => opts.name,
    description: () => opts.desc ?? `${opts.name} 的一句话说明`,
    inputSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "" }),
    readOnly: () => true,
    ...(opts.guide ? { usageGuide: () => opts.guide! } : {}),
    ...(opts.shouldDefer ? { shouldDefer: true } : {}),
    ...(opts.alwaysLoad ? { alwaysLoad: true } : {}),
  };
}

/** 提示词里"本轮可直接调用"那一段（延迟分区之前的部分） */
function liveRegion(prompt: string): string {
  const marker = "### 未加载的工具";
  const i = prompt.indexOf(marker);
  return i === -1 ? prompt : prompt.slice(0, i);
}

describe("L1 — toolList 分区与标注", () => {
  beforeEach(() => clearPromptCache());

  test("延迟工具落在独立分区、带 [需激活] 标注，不与实时工具混排", () => {
    const prompt = buildSystemPrompt({
      tools: [makeTool({ name: "read" }), makeTool({ name: "enter_worktree", shouldDefer: true })],
    });

    // 实时工具在"可直接调用"区
    expect(liveRegion(prompt)).toContain("- read:");
    // 延迟工具**不在**该区
    expect(liveRegion(prompt)).not.toContain("enter_worktree");
    // 而是在延迟分区里、带标注
    expect(prompt).toContain("### 未加载的工具（需先用 tool_search 激活）");
    expect(prompt).toContain(`- enter_worktree: ${DEFERRED_MARK}`);
    // 警告指针必须紧贴工具清单（模型是在读清单那一刻决定调哪个名字的，
    // 只把警告放在段末等于没写）
    expect(liveRegion(prompt)).toContain("另有 1 个工具**尚未加载**到本轮");
  });

  test("**不剔除**延迟工具：名字仍然出现（否则模型失去能力可发现性）", () => {
    const prompt = buildSystemPrompt({
      tools: [makeTool({ name: "enter_worktree", shouldDefer: true })],
    });
    expect(prompt).toContain("enter_worktree");
  });

  test("无延迟工具时不出现空的延迟分区标题", () => {
    const prompt = buildSystemPrompt({ tools: [makeTool({ name: "read" })] });
    expect(prompt).not.toContain("### 未加载的工具");
  });

  test("分区提示显式点名 enter_worktree / enter_plan_mode 这对前缀碰撞", () => {
    const prompt = buildSystemPrompt({
      tools: [
        makeTool({ name: "enter_plan_mode" }),
        makeTool({ name: "workflow", shouldDefer: true }),
      ],
    });
    expect(prompt).toContain("enter_worktree");
    expect(prompt).toContain("enter_plan_mode");
  });

  test("alwaysLoad 覆盖 shouldDefer：按已加载呈现", () => {
    const prompt = buildSystemPrompt({
      tools: [makeTool({ name: "tool_search", shouldDefer: true, alwaysLoad: true })],
    });
    expect(liveRegion(prompt)).toContain("- tool_search:");
    expect(prompt).not.toContain("### 未加载的工具");
  });

  test("keepLoaded 豁免名单（精确名 + 通配）按已加载呈现", () => {
    const exact = buildSystemPrompt({
      tools: [makeTool({ name: "workflow", shouldDefer: true })],
      toolSearchKeepLoaded: ["workflow"],
    });
    expect(liveRegion(exact)).toContain("- workflow:");

    const wildcard = buildSystemPrompt({
      tools: [makeTool({ name: "mcp__x__y" })],
      toolSearchKeepLoaded: ["mcp__x__*"],
    });
    expect(wildcard).not.toContain("### 未加载的工具");
  });

  test("toolSearch=false（恒关延迟加载）时不标注——那时全量工具真的可调用", () => {
    const prompt = buildSystemPrompt({
      tools: [makeTool({ name: "enter_worktree", shouldDefer: true })],
      toolSearchDisabled: true,
    });
    expect(liveRegion(prompt)).toContain("- enter_worktree:");
    expect(prompt).not.toContain("### 未加载的工具");
  });
});

describe("L2 — customGuides 同步分区", () => {
  beforeEach(() => clearPromptCache());

  test("延迟工具的整段使用指南进延迟分区，不留在实时区", () => {
    const guide = "这是 workflow 的完整使用指南正文，用于验证整段挪走。";
    const prompt = buildSystemPrompt({
      tools: [
        makeTool({ name: "read", guide: "read 的指南" }),
        makeTool({ name: "workflow", shouldDefer: true, guide }),
      ],
    });

    expect(liveRegion(prompt)).toContain("### read 工具使用指南");
    // 缺这条时泄漏面从"一行工具名"扩大到近 800 字符的完整教程
    expect(liveRegion(prompt)).not.toContain(guide);
    expect(prompt).toContain(`### workflow 工具使用指南 ${DEFERRED_MARK}`);
    expect(prompt).toContain(guide);
  });
});

describe("L3 — <scheduling-capability> 不再直呼未加载工具", () => {
  beforeEach(() => clearPromptCache());

  const cronTools = [
    makeTool({ name: "cron_create", shouldDefer: true }),
    makeTool({ name: "cron_list", shouldDefer: true }),
    makeTool({ name: "cron_delete", shouldDefer: true }),
    makeTool({ name: "schedule_wakeup", shouldDefer: true }),
  ];

  test("延迟时：出现激活说明，且不再有'主动映射到下列工具'的直呼措辞", () => {
    const prompt = buildSystemPrompt({ tools: cronTools });
    expect(prompt).toContain("<scheduling-capability>");
    expect(prompt).toContain("tool_search");
    expect(prompt).toContain("select:cron_create");
    // 这是本次事故的最强形态：主动命令模型调用一个不在本轮 schema 里的名字
    expect(prompt).not.toContain("主动映射到下列工具，不要只是口头答应");
  });

  test("四个调度工具名都仍然出现（改措辞而非删段，保留能力可发现性）", () => {
    const prompt = buildSystemPrompt({ tools: cronTools });
    for (const n of ["cron_create", "cron_list", "cron_delete", "schedule_wakeup"]) {
      expect(prompt).toContain(n);
    }
  });

  test("不延迟时（toolSearch=false）保留原有的主动映射措辞", () => {
    const prompt = buildSystemPrompt({ tools: cronTools, toolSearchDisabled: true });
    expect(prompt).toContain("主动映射到下列工具，不要只是口头答应");
    expect(prompt).not.toContain("select:cron_create");
  });

  test("en 档同样带激活说明", () => {
    const prompt = buildSystemPrompt({ tools: cronTools, preferredLanguage: "en" });
    expect(prompt).toContain("select:cron_create");
    expect(prompt).not.toContain("map it onto these tools — do not just verbally agree");
  });
});

describe("L4 — MCP 工具清单（默认全延迟）", () => {
  beforeEach(() => clearPromptCache());

  test("MCP 工具（按前缀默认延迟）进延迟分区并带标注", () => {
    const prompt = buildSystemPrompt({
      tools: [
        makeTool({ name: "read" }),
        makeTool({ name: "mcp__tavily__search", guide: "tavily 指南" }),
      ],
    });
    expect(prompt).toContain("<mcp-tools>");
    expect(prompt).toContain(`- mcp__tavily__search: ${DEFERRED_MARK}`);
    expect(prompt).toContain(`### mcp__tavily__search 工具使用指南 ${DEFERRED_MARK}`);
  });

  test("keepLoaded 钉住的 MCP 工具按已加载呈现", () => {
    const prompt = buildSystemPrompt({
      tools: [makeTool({ name: "mcp__tavily__search" })],
      toolSearchKeepLoaded: ["mcp__tavily__search"],
    });
    expect(prompt).toContain("本轮可直接调用");
    expect(prompt).not.toContain(`- mcp__tavily__search: ${DEFERRED_MARK}`);
  });
});

describe("en 档 — 标注与分区同样生效（避免只修中文一条路）", () => {
  beforeEach(() => clearPromptCache());

  test("英文提示词里延迟工具带 [activate first] 且不在可调用清单", () => {
    const prompt = buildSystemPrompt({
      tools: [makeTool({ name: "read" }), makeTool({ name: "enter_worktree", shouldDefer: true })],
      preferredLanguage: "en",
    });
    const marker = "### Not-yet-loaded tools";
    expect(prompt).toContain(marker);
    const live = prompt.slice(0, prompt.indexOf(marker));
    expect(live).toContain("- read:");
    expect(live).not.toContain("enter_worktree");
    expect(prompt).toContain(`- enter_worktree: ${DEFERRED_MARK_EN}`);
  });
});

describe("反向门禁 — 运行时激活态绝不进静态前缀（prompt cache 不变量）", () => {
  beforeEach(() => clearPromptCache());

  test("registry.activateTool 前后，提示词与 generateCacheKey 逐字节相同", () => {
    const registry = new Registry();
    registry.register(makeTool({ name: "read" }) as any);
    registry.register(makeTool({ name: "enter_worktree", shouldDefer: true }) as any);

    const ctx = { tools: registry.all() };
    const before = buildSystemPrompt(ctx);
    const keyBefore = generateCacheKey(ctx);

    // 运行时激活（模型经 tool_search 调出）
    expect(registry.activateTool("enter_worktree")).toBe(true);
    expect(registry.isDeferred("enter_worktree")).toBe(false);

    clearPromptCache(); // 清缓存后重建：确保测的是"渲染逻辑不读运行时态"，不是"命中了缓存"
    const after = buildSystemPrompt({ tools: registry.all() });
    const keyAfter = generateCacheKey({ tools: registry.all() });

    // 激活是运行时态，它的正确载体是动态区的 <available-deferred-tools> per-turn delta，
    // 不是静态前缀。这里一旦不等就是 prompt cache 前缀击穿。
    expect(after).toBe(before);
    expect(keyAfter).toBe(keyBefore);
  });

  test("判据不读 registry.isToolSearchEnabled（它在提示词构建时恒 false）", () => {
    const registry = new Registry();
    registry.register(makeTool({ name: "enter_worktree", shouldDefer: true }) as any);

    const off = buildSystemPrompt({ tools: registry.all() });
    // 生产路径上 toolSearchEnabled 直到 loop.ts 才定档，晚于提示词构建。
    // 若分区判据读了它，下面这次翻转会让输出变化 —— 那正是"生产恒 false、单测恒绿"的陷阱。
    registry.setToolSearchEnabled(true);
    clearPromptCache();
    const on = buildSystemPrompt({ tools: registry.all() });
    expect(on).toBe(off);
    expect(off).toContain("### 未加载的工具");
  });
});

describe("端到端 — 走真实入口 buildInitialSystemPrompt（堵时序陷阱）", () => {
  beforeEach(() => clearPromptCache());

  test("真实入口生成的提示词里，延迟工具带激活标注、不在可调用区", async () => {
    const { buildInitialSystemPrompt } = await import("@sid-code/core/query/init-helpers.ts");
    const tools = [
      makeTool({ name: "read" }),
      makeTool({ name: "workflow", shouldDefer: true, guide: "workflow 指南" }),
      makeTool({ name: "mcp__x__y" }),
    ];

    // 这条用例的价值在于**不自建 registry**：分区判据若误读
    // registry.isToolSearchEnabled()（在 loop.ts:715 才定档，晚于 app.ts:2620 的提示词构建），
    // 生产路径会恒 false → 修复静默变空操作，而自建 registry 的单测照样全绿。
    const prompt = await buildInitialSystemPrompt(
      { toolSearch: true, language: "zh" } as any,
      tools as any,
    );

    const live = liveRegion(prompt);
    expect(live).toContain("- read:");
    expect(live).not.toContain("- workflow:");
    expect(prompt).toContain(`- workflow: ${DEFERRED_MARK}`);
    expect(prompt).toContain(`- mcp__x__y: ${DEFERRED_MARK}`);
  });

  test("config.toolSearch=false 时真实入口不标注（全量工具确实可调用）", async () => {
    const { buildInitialSystemPrompt } = await import("@sid-code/core/query/init-helpers.ts");
    const prompt = await buildInitialSystemPrompt(
      { toolSearch: false, language: "zh" } as any,
      [makeTool({ name: "workflow", shouldDefer: true })] as any,
    );
    expect(prompt).not.toContain("### 未加载的工具");
  });

  test("config.toolSearchKeepLoaded 经真实入口透传（漏传则豁免名单形同白设）", async () => {
    const { buildInitialSystemPrompt } = await import("@sid-code/core/query/init-helpers.ts");
    const prompt = await buildInitialSystemPrompt(
      { toolSearch: true, language: "zh", toolSearchKeepLoaded: ["workflow"] } as any,
      [makeTool({ name: "workflow", shouldDefer: true })] as any,
    );
    expect(liveRegion(prompt)).toContain("- workflow:");
    expect(prompt).not.toContain("### 未加载的工具");
  });
});

describe("端到端 — 全部内置延迟工具逐个断言", () => {
  beforeEach(() => clearPromptCache());

  // §0.1 重扫全仓得出的延迟工具名单（enter_worktree / exit_worktree 已 un-defer，故不在此列）
  const DEFERRED_BUILTINS = [
    "bg_task_get",
    "bg_task_list",
    "cron_create",
    "cron_delete",
    "cron_list",
    "notebook_edit",
    "schedule_wakeup",
    "send_message",
    "task_create",
    "task_get",
    "task_list",
    "task_output",
    "task_stop",
    "task_update",
    "team_create",
    "team_message",
    "workflow",
  ];

  test("每个延迟工具都不出现在可直接调用区", () => {
    const tools = [
      makeTool({ name: "read" }),
      ...DEFERRED_BUILTINS.map((name) =>
        makeTool({ name, shouldDefer: true, guide: `${name} 指南` }),
      ),
    ];
    const prompt = buildSystemPrompt({ tools });
    const live = liveRegion(prompt);

    for (const name of DEFERRED_BUILTINS) {
      expect(live).not.toContain(`- ${name}:`);
      expect(live).not.toContain(`### ${name} 工具使用指南`);
      expect(prompt).toContain(`- ${name}: ${DEFERRED_MARK}`);
    }
  });
});

describe("coordinator — worker 工具清单刻意不过滤（判据与 L1–L4 不同）", () => {
  beforeEach(() => {
    clearPromptCache();
    setCoordinatorMode(false);
  });

  test("worker 清单包含延迟工具名且不加激活标注", () => {
    setCoordinatorMode(true);
    try {
      const prompt = buildSystemPrompt({
        tools: [
          makeTool({ name: "sub_agent" }),
          makeTool({ name: "task_create", shouldDefer: true }),
        ],
      });
      // 子代理的工具定义走 registry.definitions()（agent/agentic-loop.ts:425），
      // **不过延迟过滤** —— 延迟工具对 worker 是真实可调用的
      // （BUILTIN_AGENT_ALLOWED_TOOLS.task 里就含 task_create/task_update）。
      // 所以这里标注"需先激活"会给 coordinator 假信息。原方案 L5 要求过滤，核实后驳回。
      const idx = prompt.indexOf("Worker 可以使用以下工具");
      expect(idx).toBeGreaterThan(-1);
      const workerLine = prompt.slice(idx, idx + 400);
      expect(workerLine).toContain("task_create");
      expect(workerLine).not.toContain(DEFERRED_MARK);
    } finally {
      setCoordinatorMode(false);
    }
  });
});

describe("判据单元 — isStaticallyDeferred / partitionByDeferral", () => {
  test("优先级：toolSearchDisabled > alwaysLoad > keepLoaded > shouldDefer > mcp__ 前缀", () => {
    const deferred = makeTool({ name: "workflow", shouldDefer: true });
    expect(isStaticallyDeferred(deferred)).toBe(true);
    expect(isStaticallyDeferred(deferred, { toolSearchDisabled: true })).toBe(false);
    expect(isStaticallyDeferred(deferred, { keepLoaded: ["workflow"] })).toBe(false);
    expect(isStaticallyDeferred(makeTool({ name: "x", shouldDefer: true, alwaysLoad: true }))).toBe(
      false,
    );
    expect(isStaticallyDeferred(makeTool({ name: "mcp__a__b" }))).toBe(true);
    expect(isStaticallyDeferred(makeTool({ name: "read" }))).toBe(false);
  });

  test("partitionByDeferral 保持入参顺序", () => {
    const { live, deferred } = partitionByDeferral([
      makeTool({ name: "a" }),
      makeTool({ name: "b", shouldDefer: true }),
      makeTool({ name: "c" }),
      makeTool({ name: "d", shouldDefer: true }),
    ]);
    expect(live.map((t) => t.name())).toEqual(["a", "c"]);
    expect(deferred.map((t) => t.name())).toEqual(["b", "d"]);
  });
});
