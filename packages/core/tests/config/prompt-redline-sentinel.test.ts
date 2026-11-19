/**
 * 提示词红线反漂移哨兵
 *
 * ## 为什么要机械化拦，而不是靠 review
 *
 * 这里拦的两条缺陷都**不会让任何测试变红、也不会让 build 失败**，而且都是「读起来很顺」
 * 的那种错：
 *
 * 1. **RL-001 曾把项目铁律点名禁止的命令当作"可逆操作"推荐给模型。**
 *    `git stash` / `git checkout -- <file>` / `git restore` / `git reset --hard` / `git clean`
 *    会**静默且不可逆地**丢弃未提交改动，没有回收站、没有 reflog 可救。CLAUDE.md 与
 *    CONTRIBUTING.md 两处铁律明确禁止，而 RL-001 的触发场景（"帮我删 X 文件"）恰恰
 *    是最可能生成这些命令的场景 —— 本仓已因此真实丢过数据（2026-07-28）。
 *
 * 2. **标题里的数字天生会漂。** 主段写「七大输出红线」而实际主段 7 条、扩展段 4 条、
 *    编号到 11；「五条扩展红线」实际只有 4 条（RL-008 / RL-009 / RL-011 / G-13，且
 *    RL-010 全仓从不存在）。提示词里一个自相矛盾的数字是模型每轮都要读一遍的噪声，
 *    还会让"红线一共几条"这类自查得到错答案。
 *    所以哨兵不校验"必须是 N 条"，而是校验**标题不带数字** —— 把计数交给条目自己，
 *    这样加删红线不必同步改标题，漂移在结构上就不可能发生。
 *    ⚠️ 覆盖范围必须**同时**含主段与扩展段：早先只拦了「扩展红线」，主段标题漂了整整
 *    一个版本没有任何东西变红 —— 只覆盖一半的哨兵会给人一种"这一块有人守"的错觉。
 *
 * 判据都落在**最终提示词文本**（buildSystemPrompt 的产物）上，不是源码字面量：
 * 中英双档都要过，任何一档漏改都会红。
 */

import { describe, test, expect } from "bun:test";
import { buildSystemPrompt, clearPromptCache } from "../../src/config/system-prompt.ts";

/**
 * 取最终提示词全文。
 *
 * ⚠️ 字段名是 `preferredLanguage` 而不是 `language`——写错不会报错（多余字段被忽略），
 * 只会让 en 档断言**静默跑在中文提示词上**：4 条 en 断言全部拿中文文本去比英文标记，
 * 于是"红了"的原因是脚手架传错参而非被测对象有缺陷。这是本次实际踩到的一次误判，
 * 记在这里防下一个人重犯。
 */
function renderPrompt(language: "zh" | "en" | "auto"): string {
  clearPromptCache();
  return buildSystemPrompt({
    tools: [],
    workingDir: "/tmp/redline-sentinel",
    gitStatus: false,
    preferredLanguage: language,
    model: "claude-opus-5",
  });
}

/**
 * 被禁止的「假可逆」命令推荐形态。
 *
 * 只列**破坏性用法**：`git checkout --` 会丢弃工作区改动，而 `git checkout -b` / `git checkout <branch>`
 * 是无害的切分支，所以判据必须精确到 `--`，否则会在无害用法上误报、逼人把哨兵关掉。
 */
const FORBIDDEN_AS_REVERSIBLE = [
  "git stash",
  "git checkout --",
  "git restore",
  "git reset --hard",
  "git clean",
];

describe("提示词红线反漂移哨兵", () => {
  describe("RL-001 不得把不可逆命令当作「可逆操作」推荐", () => {
    for (const language of ["zh", "en"] as const) {
      test(`${language} 档：破坏性 git 命令只出现在禁止语境里`, () => {
        const text = renderPrompt(language);
        // 前提自证：RL-001 确实在提示词里（否则下面的断言会因为"整段不在"而空过）
        expect(text).toContain("RL-001");

        for (const cmd of FORBIDDEN_AS_REVERSIBLE) {
          const idx = text.indexOf(cmd);
          if (idx === -1) continue; // 没提到就没有误导风险
          // 提到了 → 必须落在「同样禁止 / equally forbidden」这句话所在的段里。
          // 取该命令附近的窗口做判据，避免"文档另一处合法提及"被误伤。
          const window = text.slice(Math.max(0, idx - 600), idx + 600);
          const isForbiddenContext =
            window.includes("同样禁止") || window.includes("equally forbidden");
          expect(
            isForbiddenContext,
            `提示词里出现 \`${cmd}\` 但不在「同样禁止」语境中 —— ` +
              `它会静默丢弃未提交改动，不得作为可逆操作推荐（见 CLAUDE.md 铁律）`,
          ).toBe(true);
        }
      });

      test(`${language} 档：RL-001 显式点名这些命令同样禁止`, () => {
        const text = renderPrompt(language);
        const marker = language === "en" ? "equally forbidden" : "同样禁止";
        expect(text).toContain(marker);
        // 五个命令都要被点名，漏一个就等于给模型留了一条"这个没说不行"的口子
        for (const cmd of FORBIDDEN_AS_REVERSIBLE) {
          expect(text, `RL-001 应显式点名 \`${cmd}\``).toContain(cmd);
        }
      });
    }
  });

  describe("红线小标题不得内联条目数（数字会漂）", () => {
    for (const language of ["zh", "en"] as const) {
      // 主段与扩展段共用同一条判据。主段此前完全没被哨兵覆盖（只拦了「扩展红线」），
      // 而它恰恰漂过：标题写「七大输出红线」，实际主段 7 条 + 扩展 4 条、编号到 11。
      // 所以这里按「标题名 × 档位」逐个断言，而不是只断言扩展段。
      const headings = [
        {
          zh: "## 输出红线",
          en: "## Output redlines",
          bad: [
            /##\s*[一二三四五六七八九十\d]+\s*大?输出红线/,
            /##\s*(?:Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+)\s+output\s+redlines/i,
          ],
        },
        {
          zh: "## 扩展红线",
          en: "## Extended redlines",
          bad: [
            /##\s*[一二三四五六七八九十\d]+\s*条扩展红线/,
            /##\s*(?:Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+)\s+extended\s+redlines/i,
          ],
        },
      ];

      for (const h of headings) {
        test(`${language} 档：${h[language]} 标题不带计数词`, () => {
          const text = renderPrompt(language);
          for (const re of h.bad) {
            expect(
              re.test(text),
              `${h[language]} 标题内联了条目数（${re}）—— 加删红线时会漂成自相矛盾的数字，` +
                `标题应写「输出红线 / Output redlines」「扩展红线 / Extended redlines」，把计数交给条目自己`,
            ).toBe(false);
          }
          // 正面断言：标题本身还在（防止上面那条被"整段删掉"空过）
          expect(text).toContain(h[language]);
        });
      }
    }
  });

  test("RL-010 不存在，不得为凑数发明一条", () => {
    // 历史上标题写「五条」而条目只有 4 条，RL-010 全仓零命中。
    // 正确修法是改标题，不是发明一条红线来对齐数字。
    for (const language of ["zh", "en"] as const) {
      const text = renderPrompt(language);
      expect(text).not.toContain("RL-010");
    }
  });

  test("G-13 的命名保留，但条目里要说明它不是 RL 序号", () => {
    // G-13 是外部编号规则「Level 1 建议等人审」的引用，改编号会断掉
    // daemon/headless-executor.ts 与 Note 的可追溯性；但同一段里 1..10 都是 RL-xxx，
    // 11 突然叫 G-13，模型会以为缺了一条红线。所以保留名字、补一句括注。
    const zh = renderPrompt("zh");
    expect(zh).toContain("G-13");
    expect(zh).toMatch(/G-13[^\n]*（[^）]*不是\s*RL\s*序号/);
    const en = renderPrompt("en");
    expect(en).toContain("G-13");
    expect(en).toMatch(/G-13[^\n]*\([^)]*not an RL number/i);
  });

  test("最终提示词不引用不存在的变量名（RL-004 曾写 max_steps）", () => {
    // max_steps 只存在于提示词自己与评测 yaml 的框架字段里，不是任何 CLI 参数或配置项
    // （真机制是 --max-turns，且交互模式下是 Infinity）。红线教模型遵守一个不存在的上限，
    // 后果是模型把它当硬约束、或去"查 max_steps"——两者都是行为空洞。
    // 红线写行为（"要有终止条件"），不写变量名；变量改名时也不会再漂。
    for (const language of ["zh", "en"] as const) {
      const text = renderPrompt(language);
      expect(text, `${language} 档提示词引用了不存在的变量名 max_steps`).not.toContain("max_steps");
    }
    // 前提自证：RL-004 本身还在（防止"整条删掉"让上面那条空过）
    for (const language of ["zh", "en"] as const) {
      expect(renderPrompt(language)).toContain("RL-004");
    }
  });
});
