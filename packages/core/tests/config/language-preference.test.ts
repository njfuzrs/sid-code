/**
 * 输出语言偏好（「中文优先」特性）的全链路回归测试。
 *
 * 这个功能此前有三层**结构性**缺陷叠加，且**一条测试都没有**。用户的实际症状是
 * "设了 en 也切不动 / 切了又飘回中文"，根因不在模型：
 *
 *   P0-1 铁律硬拒：`reasoningLanguageDrift` 模型走的强措辞分支漏了"用户显式要求可穿透"
 *        条款（标准分支有），模型于是忠实地把用户"用英文介绍这个项目"的请求硬拒，
 *        还援引系统提示词说"我无权更改"。
 *   P0-2 开关不可见：`/language` 命令早就存在，但提示词里零处提及，模型答不上来。
 *   P0-3 语言压力反向：`en` 模式只翻了 2 处措辞，提示词仍有 54.7% 是汉字——
 *        用中文语境让模型说英文。
 *   P0-4 优先级无裁决：CLAUDE.md 附件自带"覆盖任何默认行为"且位置在后，把 en 压回中文。
 *   P1-3 auto 形同虚设：被当成 zh 的别名，三个取值只有两种行为。
 *   P2-2 internal_en 泄漏：提示词定义了该标签却无任何剥离路径，裸标签渲染进 TUI。
 *
 * 因此本文件的用例都是**语义哨兵**而非文案快照：断言"逃生口在不在""三档行为是否互不相同"
 * "en 模式汉字占比是否够低"这类不变量，而不是比对具体措辞（那样每次改文案都会假红）。
 */

import { describe, test, expect } from "bun:test";
import { buildSystemPrompt, clearPromptCache } from "@sid-code/core/config/system-prompt.ts";
import {
  LANGUAGE_PREFS,
  describeLanguagePref,
  detectSystemLanguage,
  extractInternalEnTags,
  hasInternalEnTags,
  normalizeLanguagePref,
  resolveEffectiveLanguage,
  resolveLanguageFromEnv,
  stripInternalEnTags,
} from "@sid-code/core/config/prompt-lang.ts";

/** 一个声明了 reasoningLanguageDrift 的模型，用于触发「铁律级」措辞分支 */
const DRIFT_MODEL = "deepseek-v4-pro";
/** 未声明该标志的模型，走标准措辞分支 */
const PLAIN_MODEL = "claude-opus-5";

function build(
  opts: {
    language?: "zh" | "en" | "auto";
    model?: string;
    projectRules?: string;
  } = {},
): string {
  clearPromptCache();
  return buildSystemPrompt({
    tools: [],
    workingDir: "/tmp/lang-test",
    gitStatus: false,
    preferredLanguage: opts.language,
    model: opts.model ?? PLAIN_MODEL,
    projectRules: opts.projectRules,
    projectRulesPath: opts.projectRules ? "CLAUDE.md" : undefined,
  });
}

function cjkRatio(text: string): number {
  const cjk = (text.match(/[一-龥]/g) ?? []).length;
  return cjk / Math.max(1, text.length);
}

// ============================================================
// P0-1：语言切换的逃生口——所有分支都必须有
// ============================================================

describe("P0-1 语言逃生口（治漂移的强措辞不得封死用户意愿）", () => {
  /** 逃生口的语义标志：允许切换 + 不得以系统约束为由拒绝 */
  function hasEscapeHatch(prompt: string): boolean {
    return (
      (prompt.includes("允许切换语言") ||
        prompt.includes("Switching languages is always allowed")) &&
      (prompt.includes("绝不以") || prompt.includes("Never refuse"))
    );
  }

  test("reasoningLanguageDrift 模型的铁律分支也有逃生口（这是硬拒事故的直接根因）", () => {
    const prompt = build({ model: DRIFT_MODEL });
    // 先确认真的走到了铁律分支，否则这条用例测的是标准分支，等于没测
    expect(prompt).toContain("最高优先级");
    expect(prompt).toContain("internal_en");
    expect(hasEscapeHatch(prompt)).toBe(true);
  });

  test("强制档 × 两类模型，逃生口全覆盖（不留任何硬拒分支）", () => {
    // 只覆盖**强制**语言的档位（zh / en / 缺省）。auto 档见下一条。
    for (const model of [PLAIN_MODEL, DRIFT_MODEL]) {
      for (const language of [undefined, "zh", "en"] as const) {
        const prompt = build({ language, model });
        expect(hasEscapeHatch(prompt)).toBe(true);
      }
    }
  });

  test("auto 档不需要逃生口，但必须有等效的「显式指定优先」条款", () => {
    // auto 本就没有"被强制的语言"可逃——它的缺省行为就是跟随用户。所以它不该有
    // buildLanguageEscapeHatch 那段（那是给强制档解锁用的），但必须保证同一个
    // 用户诉求（"这轮用英文"）依然能被满足，否则等于换了个形式的硬拒。
    const prompt = build({ language: "auto" });
    expect(hasEscapeHatch(prompt)).toBe(false);
    expect(prompt).toMatch(/显式指定优先/);
  });

  test("不再出现「不可违反」这种不留余地的措辞", () => {
    // 这个词组正是模型援引来拒绝用户的原文。强度可以保留，但不能是"无例外"。
    for (const model of [PLAIN_MODEL, DRIFT_MODEL]) {
      expect(build({ model })).not.toContain("不可违反");
    }
  });

  test("逃生口明确覆盖「写外语内容」是正常任务（而非违规）", () => {
    // 用户当初被拒的第二个请求就是"用英文介绍这个项目"——属于写外语内容。
    const prompt = build({ model: DRIFT_MODEL });
    expect(prompt).toMatch(/正常任务|commit message/);
  });
});

// ============================================================
// P0-2：/language 开关必须对模型可见
// ============================================================

describe("P0-2 /language 命令可见性（模型得知道开关存在）", () => {
  test("每一档提示词都告知 /language 命令", () => {
    for (const language of [undefined, "zh", "en", "auto"] as const) {
      for (const model of [PLAIN_MODEL, DRIFT_MODEL]) {
        expect(build({ language, model })).toContain("/language");
      }
    }
  });

  test("提示词提到 -p 持久化，用户问「怎么永久改」时模型答得出", () => {
    expect(build({ model: DRIFT_MODEL })).toMatch(/-p/);
  });
});

// ============================================================
// P0-3：en 模式必须真的是英文语境
// ============================================================

describe("P0-3 en 模式语言压力方向", () => {
  test("en 模式汉字占比极低（旧实现 54.7%）", () => {
    const ratio = cjkRatio(build({ language: "en" }));
    // 阈值 2%：允许"用中文回答"这类**刻意保留**的中文示例，但不容忍成段中文正文。
    expect(ratio).toBeLessThan(0.02);
  });

  test("zh / auto 档仍是中文语境（不能被 en 改动误伤）", () => {
    expect(cjkRatio(build({ language: "zh" }))).toBeGreaterThan(0.3);
    expect(cjkRatio(build({ language: "auto" }))).toBeGreaterThan(0.3);
    expect(cjkRatio(build())).toBeGreaterThan(0.3);
  });

  test("en 模式的行为规范内容没有丢失（翻译不等于删减）", () => {
    const prompt = build({ language: "en" });
    // 红线编号是语言无关的稳定锚点：11 条必须一条不少
    for (const id of [
      "RL-001",
      "RL-002",
      "RL-003",
      "RL-004",
      "RL-005",
      "RL-006",
      "RL-007",
      "RL-008",
      "RL-009",
      "RL-011",
    ]) {
      expect(prompt).toContain(id);
    }
    // 结构性小节同样要在
    expect(prompt).toContain("<constraints>");
    expect(prompt).toContain("<output-redlines>");
    expect(prompt).toContain("<answer-discipline>");
    expect(prompt).toContain("<context-management>");
  });

  test("en 与 zh 的红线条数一致（防止英文版漏翻某条）", () => {
    const count = (s: string) => (s.match(/RL-\d{3}/g) ?? []).length;
    expect(count(build({ language: "en" }))).toBe(count(build({ language: "zh" })));
  });

  test("en 模式环境段与日期标签也是英文（残留中文标签会削弱语言一致性）", () => {
    const prompt = build({ language: "en" });
    expect(prompt).toContain("Working directory:");
    expect(prompt).not.toContain("## 环境信息");
    expect(prompt).not.toContain("当前日期:");
  });
});

// ============================================================
// P0-4：与 CLAUDE.md 的优先级裁决
// ============================================================

describe("P0-4 language 与 CLAUDE.md 语言条款的优先级", () => {
  const ZH_RULES =
    "# 项目规范\n- **语言**：所有回复、代码注释、文档均使用中文\n- **架构**：禁止引入新依赖";

  test("显式设 en + CLAUDE.md 要求中文时，注入裁决段", () => {
    const prompt = build({ language: "en", projectRules: ZH_RULES });
    expect(prompt).toContain("<language-precedence>");
  });

  test("裁决段位置在 CLAUDE.md 之后（LLM 对同维冲突普遍取后者胜）", () => {
    const prompt = build({ language: "en", projectRules: ZH_RULES });
    const claudeMdIdx = prompt.indexOf("均使用中文");
    const precedenceIdx = prompt.indexOf("<language-precedence>");
    expect(claudeMdIdx).toBeGreaterThan(-1);
    expect(precedenceIdx).toBeGreaterThan(claudeMdIdx);
  });

  test("裁决只覆盖语言，明确声明项目规则其它内容照旧生效（不能变成绕过规则的后门）", () => {
    const prompt = build({ language: "en", projectRules: ZH_RULES });
    const section = prompt.slice(prompt.indexOf("<language-precedence>"));
    expect(section).toMatch(/只覆盖|照常/);
    // 架构类约束不受影响——原文仍在
    expect(prompt).toContain("禁止引入新依赖");
  });

  test("未显式设置语言时不注入裁决段（无冲突可裁决，白占 token）", () => {
    expect(build({ projectRules: ZH_RULES })).not.toContain("<language-precedence>");
  });

  test("无项目规则时不注入裁决段（没有冲突方）", () => {
    expect(build({ language: "en" })).not.toContain("<language-precedence>");
  });
});

// ============================================================
// P1-3：auto 是独立一档，不是 zh 的别名
// ============================================================

describe("P1-3 auto 档语义", () => {
  test("auto 与 zh 产出不同提示词（旧实现二者完全相同）", () => {
    expect(build({ language: "auto" })).not.toBe(build({ language: "zh" }));
  });

  test("auto 与「未设置」产出不同提示词（二者语义不同）", () => {
    expect(build({ language: "auto" })).not.toBe(build());
  });

  test("auto 档指示模型跟随用户输入语言", () => {
    const prompt = build({ language: "auto" });
    expect(prompt).toMatch(/跟随用户/);
    // 判断不出时的兜底必须写明，否则模型面对纯代码输入无所适从
    expect(prompt).toMatch(/判断不出|判断不了/);
  });

  test("zh / en / auto 三档产出三种互不相同的提示词", () => {
    const variants = ["zh", "en", "auto"].map((l) => build({ language: l as any }));
    expect(new Set(variants).size).toBe(3);
  });

  test("未设置与 zh 产出相同提示词（缺省即中文优先，这是刻意的向后兼容）", () => {
    // 与上面"auto 与未设置不同"一起构成完整语义：
    //   undefined ≡ zh（缺省档就是中文优先）
    //   auto      ≠ zh（auto 是独立的第三种行为）
    // 旧实现的错误是反过来的：auto ≡ zh，且状态栏把 undefined 显示成 auto。
    expect(build({ language: "zh" })).toBe(build());
  });
});

// ============================================================
// prompt-lang 纯函数：归一化 / 解析 / locale 探测
// ============================================================

describe("normalizeLanguagePref 输入容错", () => {
  test.each([
    ["zh", "zh"],
    ["ZH", "zh"],
    ["zh-CN", "zh"],
    ["zh_TW", "zh"],
    ["zh.UTF-8", "zh"],
    ["chinese", "zh"],
    ["cn", "zh"],
    ["en", "en"],
    ["EN", "en"],
    ["en-US", "en"],
    ["en_GB.UTF-8", "en"],
    ["english", "en"],
    ["auto", "auto"],
    ["AUTO", "auto"],
    ["detect", "auto"],
    ["follow", "auto"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeLanguagePref(input)).toBe(expected as any);
  });

  test.each([["unset"], ["default"], ["none"], [""], ["  "], ["jp"], ["fr"], ["日本語"], ["zzz"]])(
    "%s → undefined（无有效偏好）",
    (input) => {
      expect(normalizeLanguagePref(input)).toBeUndefined();
    },
  );

  test("非字符串输入不抛异常", () => {
    for (const v of [undefined, null, 42, {}, [], true]) {
      expect(normalizeLanguagePref(v)).toBeUndefined();
    }
  });

  test("LANGUAGE_PREFS 与实际支持的档位一致（防清单漂移）", () => {
    expect([...LANGUAGE_PREFS].sort()).toEqual(["auto", "en", "zh"]);
    for (const p of LANGUAGE_PREFS) expect(normalizeLanguagePref(p)).toBe(p);
  });
});

describe("resolveEffectiveLanguage 归一化", () => {
  test("zh / en 原样返回", () => {
    expect(resolveEffectiveLanguage("zh")).toBe("zh");
    expect(resolveEffectiveLanguage("en")).toBe("en");
  });

  test("未设置回落 zh（「中文优先」是产品缺省）", () => {
    expect(resolveEffectiveLanguage(undefined)).toBe("zh");
  });

  test("auto 按 locale 解析", () => {
    expect(resolveEffectiveLanguage("auto", { LANG: "en_US.UTF-8" })).toBe("en");
    expect(resolveEffectiveLanguage("auto", { LANG: "zh_CN.UTF-8" })).toBe("zh");
  });

  test("auto 且 locale 不可识别时回落 zh（不确定时不漂到英文）", () => {
    expect(resolveEffectiveLanguage("auto", {})).toBe("zh");
    expect(resolveEffectiveLanguage("auto", { LANG: "fr_FR.UTF-8" })).toBe("zh");
    expect(resolveEffectiveLanguage("auto", { LANG: "C" })).toBe("zh");
  });
});

describe("detectSystemLanguage POSIX 优先级", () => {
  test("LC_ALL > LC_MESSAGES > LANG", () => {
    expect(detectSystemLanguage({ LC_ALL: "en_US", LC_MESSAGES: "zh_CN", LANG: "zh_CN" })).toBe(
      "en",
    );
    expect(detectSystemLanguage({ LC_MESSAGES: "en_US", LANG: "zh_CN" })).toBe("en");
    expect(detectSystemLanguage({ LANG: "en_US" })).toBe("en");
  });

  test("空环境回落 zh", () => {
    expect(detectSystemLanguage({})).toBe("zh");
  });

  test("跳过不可识别的高优先级变量，继续看下一个", () => {
    // LC_ALL=C 无法判定语言，不应就此放弃 LANG 里的有效信息
    expect(detectSystemLanguage({ LC_ALL: "C", LANG: "en_US.UTF-8" })).toBe("en");
  });
});

describe("resolveLanguageFromEnv", () => {
  test("读 SID_LANGUAGE", () => {
    expect(resolveLanguageFromEnv({ SID_LANGUAGE: "en" })).toBe("en");
    expect(resolveLanguageFromEnv({ SID_LANGUAGE: "auto" })).toBe("auto");
  });

  test("兼容 SID_CODE_LANGUAGE，且 SID_LANGUAGE 优先", () => {
    expect(resolveLanguageFromEnv({ SID_CODE_LANGUAGE: "en" })).toBe("en");
    expect(resolveLanguageFromEnv({ SID_LANGUAGE: "zh", SID_CODE_LANGUAGE: "en" })).toBe("zh");
  });

  test("无效值静默忽略（残留 env 不该打断启动）", () => {
    expect(resolveLanguageFromEnv({ SID_LANGUAGE: "jp" })).toBeUndefined();
    expect(resolveLanguageFromEnv({})).toBeUndefined();
  });
});

describe("describeLanguagePref 标签", () => {
  test("未设置显示为缺省中文优先，不显示成 auto", () => {
    // 旧实现把「未设置」回显成 auto，用户以为已在自动模式，实际是强制中文。
    const label = describeLanguagePref(undefined);
    expect(label).toContain("默认");
    expect(label).not.toBe(describeLanguagePref("auto"));
  });

  test("四种状态标签互不相同", () => {
    const labels = [undefined, "zh", "en", "auto"].map((p) => describeLanguagePref(p as any));
    expect(new Set(labels).size).toBe(4);
  });
});

// ============================================================
// P2-2：<internal_en> 标签剥离
// ============================================================

describe("P2-2 internal_en 标签处理", () => {
  test("提取内容为 thinking，正文不留标签", () => {
    const r = extractInternalEnTags(
      "<internal_en>Let me check the file.</internal_en>我先读这个文件。",
    );
    expect(r.thinking).toBe("Let me check the file.");
    expect(r.text).toBe("我先读这个文件。");
    expect(hasInternalEnTags(r.text)).toBe(false);
  });

  test("多块 + 出现在中间位置（与 <think> 不同，不能只取开头一块）", () => {
    const r = extractInternalEnTags(
      "前段。<internal_en>one</internal_en>中段。<internal_en>two</internal_en>后段。",
    );
    expect(r.text).toBe("前段。中段。后段。");
    expect(r.thinking).toContain("one");
    expect(r.thinking).toContain("two");
  });

  test("未闭合标签（模型被 max_tokens 截断）也不泄漏", () => {
    const r = extractInternalEnTags("正文开头。<internal_en>truncated thinking");
    expect(r.text).toBe("正文开头。");
    expect(r.thinking).toBe("truncated thinking");
  });

  test("标签大小写混写同样处理", () => {
    const r = extractInternalEnTags("<INTERNAL_EN>upper</Internal_En>大写标签");
    expect(r.text).toBe("大写标签");
    expect(r.thinking).toBe("upper");
  });

  test("游离闭合标签不泄漏（早期实现只探测开标签，这里漏出过）", () => {
    const r = extractInternalEnTags("</internal_en>只有闭合标签");
    expect(hasInternalEnTags(r.text)).toBe(false);
    expect(r.text).toBe("只有闭合标签");
  });

  test("整段回复都被包裹时 text 为空（交由未答复检测处理，不是静默丢答复）", () => {
    const r = extractInternalEnTags("<internal_en>whole reply was english thinking</internal_en>");
    expect(r.text).toBe("");
    expect(r.thinking).toBe("whole reply was english thinking");
  });

  test("无标签文本原样返回（不误伤正常回复）", () => {
    const plain = "普通回复，包含 <div> 和 </span> 等无关标签。";
    expect(extractInternalEnTags(plain).text).toBe(plain);
    expect(stripInternalEnTags(plain)).toBe(plain);
  });

  test("stripInternalEnTags 作为展示层兜底，连内容一起删", () => {
    expect(stripInternalEnTags("a<internal_en>x</internal_en>b")).toBe("ab");
    expect(stripInternalEnTags("</internal_en>裸标签")).toBe("裸标签");
  });

  test("空字符串与非法输入不抛异常", () => {
    expect(stripInternalEnTags("")).toBe("");
    expect(extractInternalEnTags("")).toEqual({ thinking: "", text: "" });
  });
});
