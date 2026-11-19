/**
 * 系统提示词两轮 review 复核 —— U1b「提示词其余段」的回归门禁。
 *
 * 覆盖四条纯文案缺陷与一条结构缺陷，中英双档各断言一次（只改中文档会让 en 用户拿到过期规范）：
 *   D-06 回答规范 #3 的「≥2 个候选根因」与 RL-007「不许凑数」冲突 → 加逃生出口（单根因合法、
 *        但必须列出排除依据）。判据是**同一段里三件事都在**：默认多给、单根因合法、不许编造。
 *   D-09 scheduling-capability 把「不需要撤销上一次」与「撤掉剩下的那个」并列读起来矛盾 →
 *        收尾那句补「最后剩下」并把 ID 出处写进句子。
 *   D-14 「避免宽 ASCII 表格」是跨工具的输出规范，却放在 <tool-guide> 里 → 搬到
 *        <answer-discipline> 第 9 条。判据用**标签区间**而不是 toContain：两段都在同一份
 *        提示词里，toContain 对「位置错了」完全不敏感。
 *   D-17 提示词说「bash 必须串行」，而 tool/bash.ts 的 isConcurrencySafe 对只读命令返回 true
 *        → 并行列补只读 bash，串行列收窄为「会改文件的 bash」。断言旧短语消失（这是
 *        「模型完全无从发现规则过时」的根源）。
 *   D-20 team_* 的名单行说「未启用」、速查行照常推荐（guidance 是静态字符串，感知不到开关）
 *        → Tool.isGuidanceVisible 钩子。断言速查段随开关出现/消失，而名单行恒在。
 *
 * 落盘隔离：本文件只构建提示词、不写 ~/.sid-code/，但仍设 SID_CONFIG_DIR 到 tmpdir ——
 * buildSystemPrompt 会经 monitor 等工具的 isEnabled 读 settings（沿 tests/config 既有约定）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildSystemPrompt, clearPromptCache } from "../../src/config/system-prompt.ts";
import { TeamCreateTool } from "../../src/tool/team-create.ts";
import { TeamMessageTool } from "../../src/tool/team-message.ts";

/** 最小工具桩：只提供提示词渲染路径会读到的几个方法。 */
function makeTool(opts: { name: string; shouldDefer?: boolean; guidance?: string }) {
  return {
    name: () => opts.name,
    description: () => `${opts.name} 的一句话说明`,
    inputSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "" }),
    readOnly: () => true,
    ...(opts.guidance ? { guidance: opts.guidance } : {}),
    ...(opts.shouldDefer ? { shouldDefer: true } : {}),
  };
}

/**
 * 取某个 XML 标签之间的内容；标签不存在返回 null。
 *
 * 为什么不用 toContain：提示词里多段共处一个字符串，`prompt.includes("避免宽 ASCII 表格")`
 * 在「这段搬到别处但没删干净」时照样通过。区间判据才能表达「在哪一段里」。
 */
function betweenTags(text: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const i = text.indexOf(open);
  const j = text.indexOf(close, i + open.length);
  return i === -1 || j === -1 ? null : text.slice(i + open.length, j);
}

function build(language?: "zh" | "en" | "auto", extra: Record<string, unknown> = {}): string {
  clearPromptCache();
  return buildSystemPrompt({
    // <tool-guide> 只在有工具时渲染，空工具列表下 D-14 / D-17 的区间断言会拿到 null。
    tools: [makeTool({ name: "read" })],
    workingDir: "/tmp/u1b-test",
    gitStatus: false,
    ...(language ? { preferredLanguage: language } : {}),
    ...extra,
  } as any);
}

// D-06 逃出口的两半措辞（中英各一份）。英文版不是中文的直译，所以不共用正则。
const D06 = {
  zh: {
    heading: /### 3\. .*≥2 个候选根因/,
    escape: /证据已把其余候选排除时，如实给 1 个，并列出你排除掉的候选及排除依据/,
    noPad: /不许为了凑数编造可能性/,
    redline: /RL-007/,
  },
  en: {
    heading: /### 3\. .*two or more candidate root causes/,
    escape:
      /ruled out the other candidates, give the one you have and list the candidates you eliminated/,
    noPad: /Never pad the list with invented possibilities/,
    redline: /RL-007/,
  },
} as const;

describe("D-06 回答规范 #3：默认 ≥2 个候选根因，但有带证据的逃生出口", () => {
  for (const language of ["zh", "en"] as const) {
    test(`${language} 档：#3 同时给出「默认多给」「单根因合法」「不许凑数」三件事`, () => {
      // 缺任何一半都会复现缺陷：只删「至少 2 个」→ RL-007 反锚定约束丢失（2026-09-06 Note
      // 已裁决过这条的价值）；只加逃生口不提 RL-007 → 模型仍可能用"也许有"凑满数量。
      const section = betweenTags(build(language), "answer-discipline");
      expect(section, "<answer-discipline> 段不存在").not.toBeNull();
      const d = D06[language];
      expect(section!, "缺少 #3 的默认判据").toMatch(d.heading);
      expect(section!, "缺少单根因逃生出口").toMatch(d.escape);
      expect(section!, "逃生出口没有与 RL-007 对齐").toMatch(d.noPad);
      expect(section!, "逃生出口应显式引用 RL-007").toMatch(d.redline);
      // 旧的绝对措辞必须消失：它正是与 RL-007 冲突的那一句
      expect(section!, "旧的「硬要求」措辞应已移除").not.toContain("这一条是硬要求");
      expect(section!, "旧的「This one is hard」措辞应已移除").not.toContain("This one is hard");
    });
  }
});

describe("D-09 scheduling-capability：收尾场景补「最后」与 ID 出处", () => {
  const cronTools = [
    makeTool({ name: "cron_create", shouldDefer: true }),
    makeTool({ name: "cron_list", shouldDefer: true }),
    makeTool({ name: "cron_delete", shouldDefer: true }),
    makeTool({ name: "schedule_wakeup", shouldDefer: true }),
  ];

  test("zh 档：「再次调用替换前一个」与「最后剩下那个要靠自己撤」并列时，后者点明是最后那个", () => {
    // 两句各自正确，但缺「最后」时模型读到的是「不需要手动撤销」 vs 「用 cron_delete」的
    // 直接矛盾（D-09 现象表）。断言落在**同一句**里：分开的 toContain 无法表达这个约束。
    const section = betweenTags(
      buildSystemPrompt({ tools: cronTools as any, workingDir: "/tmp/u1b-test", gitStatus: false }),
      "scheduling-capability",
    );
    expect(section).not.toBeNull();
    expect(section!).toMatch(
      /目标达成后停止安排，并用 `cron_delete` 撤掉\*\*最后剩下\*\*的那个唤醒（ID 在 `schedule_wakeup` 的返回值里）/,
    );
    // 替换场景的说明必须还在，否则两句又回到只有一边
    expect(section!).toContain("再次调用会替换前一个");
  });

  test("en 档：同样补 last remaining 与 ID 出处", () => {
    const section = betweenTags(
      buildSystemPrompt({
        tools: cronTools as any,
        workingDir: "/tmp/u1b-test",
        gitStatus: false,
        preferredLanguage: "en",
      }),
      "scheduling-capability",
    );
    expect(section).not.toBeNull();
    expect(section!).toMatch(
      /Stop scheduling once the goal is met, and `cron_delete` the \*\*last remaining\*\* wakeup \(its ID is in `schedule_wakeup`'s return value\)/,
    );
    expect(section!).toContain("replaces the previous one");
  });
});

describe("D-14 输出渲染规范归属 <answer-discipline>，不在 <tool-guide>", () => {
  for (const language of ["zh", "en"] as const) {
    test(`${language} 档：「避免宽 ASCII 表格」只在 <answer-discipline> 内`, () => {
      const prompt = build(language);
      const discipline = betweenTags(prompt, "answer-discipline");
      const toolGuide = betweenTags(prompt, "tool-guide");
      // 前提自证：两段都得真的在，否则 null 参与断言会给出无意义的结论
      expect(discipline, "<answer-discipline> 段不存在").not.toBeNull();
      expect(toolGuide, "<tool-guide> 段不存在").not.toBeNull();

      // 正面：落在输出规范段，且是第 9 条（段落末尾的编号位置也是契约的一部分）
      const heading =
        language === "zh" ? "### 9. 输出渲染：避免宽 ASCII 表格" : "### 9. Output rendering";
      expect(discipline!).toContain(heading);
      // 一个段里出现两次等于漏删其中一处——用出现次数而不是 toContain
      // en 档的规范句与标题共用「avoid wide ASCII tables」（标题小写 a），用不区分大小写判
      const phrase = language === "zh" ? "避免宽 ASCII 表格" : "wide ASCII tables";
      const count = discipline!.toLowerCase().split(phrase.toLowerCase()).length - 1;
      expect(count).toBe(1);

      // 反面：工具指南段里不能再有它（旧位置）
      expect(toolGuide!, "<tool-guide> 里仍残留输出渲染规范").not.toContain(phrase);
      expect(toolGuide!, "<tool-guide> 里仍残留 Output rendering 小节").not.toContain(
        "### Output rendering",
      );
    });
  }

  test("en 档：正文同样在 <answer-discipline>，<tool-guide> 不留 Output rendering", () => {
    const prompt = build("en");
    expect(betweenTags(prompt, "answer-discipline")!).toContain("### 9. Output rendering");
    expect(betweenTags(prompt, "answer-discipline")!).toContain("avoid wide ASCII tables");
    expect(betweenTags(prompt, "tool-guide")!).not.toContain("avoid wide ASCII tables");
  });
});

describe("D-17 并行/串行两列与 isConcurrencySafe 对齐", () => {
  const cases = [
    {
      language: "zh" as const,
      forbidden: ["bash 必须串行", "write/edit/bash 必须串行", "write / edit / bash 必须串行"],
      parallel: /2\. \*\*并行执行只读工具\*\*：.*只读的 bash 命令/,
      serial:
        /3\. \*\*串行执行写入工具\*\*：write \/ edit，以及\*\*会改文件的 bash 命令\*\*必须串行/,
    },
    {
      language: "en" as const,
      forbidden: ["bash`/`edit` must be sequential", "`write`/`edit`/`bash` must be sequential"],
      parallel: /read-only bash commands/,
      serial: /`write` \/ `edit`, and \*\*bash commands that modify files\*\*, must be sequential/,
    },
  ];

  for (const c of cases) {
    test(`${c.language} 档：只读 bash 进并行列，会改文件的 bash 才串行`, () => {
      const toolGuide = betweenTags(build(c.language), "tool-guide")!;
      for (const phrase of c.forbidden) {
        expect(
          toolGuide,
          `旧的「${phrase}」应已移除——它让只读 bash 的并行能力对模型不可见`,
        ).not.toContain(phrase);
      }
      expect(toolGuide).toMatch(c.parallel);
      expect(toolGuide).toMatch(c.serial);
    });
  }

  test("zh 档：串行列不再把 bash 整体算进去（只保留会改文件那一类）", () => {
    // 精确到「bash 与 write/edit 被并列要求串行」这个形态：即使有人把句子换个写法改回去，
    // 只要 bash 又回到无条件的串行列，这条就红。
    const toolGuide = betweenTags(build("zh"), "tool-guide")!;
    expect(toolGuide).not.toMatch(/串行执行写入工具\*\*：write\s*\/\s*edit\s*\/\s*bash/);
  });
});

describe("D-20 team_* 的工具级 guidance 可见性钩子", () => {
  // 两条测试都必须存/恢复，不能无条件 delete：bun test 同批多文件跑在同一进程里，
  // 直接删会把别处设的值抹掉，也会让后续用例看到未定义状态（CONTRIBUTING.md 测试约定 1）。
  let savedTeams: string | undefined;
  let savedConfigDir: string | undefined;
  let tmpConfigDir = "";

  beforeEach(() => {
    clearPromptCache();
    savedTeams = process.env.SID_ENABLE_AGENT_TEAMS;
    savedConfigDir = process.env.SID_CONFIG_DIR;
    tmpConfigDir = mkdtempSync(join(tmpdir(), "u1b-prompt-"));
    process.env.SID_CONFIG_DIR = tmpConfigDir;
  });

  afterEach(() => {
    if (savedTeams === undefined) delete process.env.SID_ENABLE_AGENT_TEAMS;
    else process.env.SID_ENABLE_AGENT_TEAMS = savedTeams;
    if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = savedConfigDir;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    clearPromptCache();
  });

  function buildWithTeamTools(): string {
    // 用真实工具实例而不是桩：要测的正是它们声明的 isGuidanceVisible 实现。
    // 前提：两个工具都 shouldDefer，否则根本不会进延迟分区，断言恒绿。
    const teamCreate = new TeamCreateTool({} as never, {} as never);
    const teamMessage = new TeamMessageTool();
    expect(teamCreate.shouldDefer).toBe(true);
    expect(teamMessage.shouldDefer).toBe(true);
    return buildSystemPrompt({
      tools: [makeTool({ name: "read" }), teamCreate, teamMessage] as any,
      workingDir: "/tmp/u1b-test",
      gitStatus: false,
    });
  }

  test("开关关闭：速查段不推荐 team_*，但名单行仍列 team_create（可发现性）", () => {
    process.env.SID_ENABLE_AGENT_TEAMS = "0";

    const prompt = buildWithTeamTools();
    // 两个工具都被钩子挡掉时速查段**整段为空串**（lines.length === 0）——这是正确行为
    // （不推荐就没得推荐），不是漏渲染。所以判据是"段里没有它们"，段不存在也满足。
    const guidance = betweenTags(prompt, "deferred-tools-guidance") ?? "";
    expect(guidance, "关闭时速查段仍在推荐 team_create").not.toContain("`team_create`");
    expect(guidance, "关闭时速查段仍在推荐 team_message").not.toContain("`team_message`");

    // 名单行必须还在：它告诉模型「这个能力存在但没开」，是 D-20 方案 A 刻意保留的一半
    expect(prompt).toContain("- team_create: ");
    expect(prompt).toContain("- team_message: ");
  });

  test("开关打开：速查段与名单行都出现 team_*", () => {
    process.env.SID_ENABLE_AGENT_TEAMS = "1";

    const prompt = buildWithTeamTools();
    const guidance = betweenTags(prompt, "deferred-tools-guidance");
    expect(guidance, "<deferred-tools-guidance> 段不存在").not.toBeNull();

    expect(guidance!).toContain("`team_create`");
    expect(guidance!).toContain("`team_message`");
    expect(prompt).toContain("- team_create: ");
  });

  test("钩子缺省为可见：没有该钩子的工具不受影响", () => {
    process.env.SID_ENABLE_AGENT_TEAMS = "0";
    clearPromptCache();
    const prompt = buildSystemPrompt({
      tools: [
        makeTool({ name: "read" }),
        makeTool({ name: "workflow", shouldDefer: true, guidance: "workflow 的意图映射。" }),
      ],
      workingDir: "/tmp/u1b-test",
      gitStatus: false,
    } as any);
    // ?? true：绝大多数工具没有开关，钩子只是给受控工具留的出口
    expect(betweenTags(prompt, "deferred-tools-guidance")!).toContain("`workflow`");
  });
});
