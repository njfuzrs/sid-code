/**
 * curated 更新日志文案的契约单测。
 *
 * ── 这些测试**能**保证什么 ──
 *   形态：分组名在受控词表内、长度合规、无 URL、version 与文件名一致、
 *   userFacing 与 sections 自洽、JSON 合法、无 NUL 字节。
 *
 * ── **不能**保证什么（如实记录，免得看到"有测试"就以为全覆盖）──
 *   **内容对不对**。「把内部重构写成了用户特性」「漏掉了一个真实的破坏性变更」
 *   这两类错误一条断言都拦不住 —— 判断一条文案是否忠实于 diff，需要读 diff，
 *   而那正是人工 review 的职责。这不是"补测试就能解决"的缺口，是这个方案的
 *   设计前提：curated 文件必须**入库 + 人工过目**，校验器只是把机械错误挡在
 *   review 之前，好让 review 的注意力用在内容上。
 *
 *   所以本文件最后有一组「遍历已入库文件」的用例 —— 它们是长期防线：
 *   人工编辑 curated JSON 时不会再跑 curate 脚本，那时**只有这些断言**还在看着。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  validateCurated,
  toRenderSections,
  checkCoverage,
  SECTION_META,
  SECTION_TITLES,
  TITLE_TO_KEY,
  MAX_ITEM_LEN,
  MAX_HIGHLIGHT_LEN,
} from "../../scripts/lib/changelog-curated-schema.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const CURATED_DIR = resolve(ROOT, "changelog/curated");

/** 一份合规的最小样本，各用例在它基础上改一个字段来验单条规则 */
function ok(overrides: Record<string, unknown> = {}) {
  return {
    version: "0.1.600",
    highlight: "一句话亮点",
    userFacing: true,
    sections: [{ title: "新功能", items: ["新增了某个能力"] }],
    commits: ["1234abc"],
    discarded: [],
    ...overrides,
  };
}

describe("受控词表", () => {
  test("只有 4 组，且破坏性变更排在最前", () => {
    // 顺序即渲染顺序：破坏性变更是用户升级前最该先看到的一类。
    expect(SECTION_META.map((s) => s.key)).toEqual([
      "breaking",
      "feat",
      "improve",
      "fix",
    ]);
  });

  test("旧的 6 组分类里，docs/other/refactor/perf 都不在词表内", () => {
    // 这不是遗漏：docs+other 实测占 276 条提交的 24%，恰是用户完全不关心的部分；
    // refactor/perf 在用户视角里没有区别，都并入「改进」。
    for (const gone of ["文档", "其他", "重构", "性能"]) {
      expect(TITLE_TO_KEY[gone]).toBeUndefined();
    }
  });

  test("title → key 映射齐全", () => {
    expect(SECTION_TITLES.length).toBe(4);
    for (const t of SECTION_TITLES) {
      expect(typeof TITLE_TO_KEY[t]).toBe("string");
    }
  });
});

describe("validateCurated · 通过的情形", () => {
  test("最小合规样本无错", () => {
    expect(validateCurated(ok())).toEqual([]);
  });

  test("highlight 为 null 合法（没有亮点就写 null，不要编）", () => {
    expect(validateCurated(ok({ highlight: null }))).toEqual([]);
  });

  test("userFacing=false + sections 为空合法（纯内部版本是合法结论）", () => {
    // 这是刻意设计的快速通道：纯内部版本的 review 成本近零。
    expect(
      validateCurated(ok({ userFacing: false, sections: [], highlight: null })),
    ).toEqual([]);
  });

  test("discarded 可缺省（早期 backfill 的文件可能没有）", () => {
    const v = ok();
    delete (v as any).discarded;
    expect(validateCurated(v)).toEqual([]);
  });

  test("四个分组全都用上也合法", () => {
    const sections = SECTION_TITLES.map((t) => ({ title: t, items: ["某条变更"] }));
    expect(validateCurated(ok({ sections }))).toEqual([]);
  });
});

describe("validateCurated · 该拦住的情形", () => {
  test("顶层不是对象", () => {
    expect(validateCurated(null).length).toBeGreaterThan(0);
    expect(validateCurated([]).length).toBeGreaterThan(0);
    expect(validateCurated("x").length).toBeGreaterThan(0);
  });

  test("version 形态不对", () => {
    expect(validateCurated(ok({ version: "v0.1.600" })).join()).toContain("version");
    expect(validateCurated(ok({ version: "0.1" })).join()).toContain("version");
  });

  test("version 与文件名版本号不一致（错配会让文案挂到错误版本且不报错）", () => {
    const errs = validateCurated(ok({ version: "0.1.599" }), "0.1.600");
    expect(errs.join()).toContain("不一致");
  });

  test("表外分组名被拒（渲染层拿不到配色与顺序）", () => {
    const errs = validateCurated(ok({ sections: [{ title: "文档", items: ["x"] }] }));
    expect(errs.join()).toContain("受控词表");
  });

  test("同名分组重复被拒（该合并成一组）", () => {
    const errs = validateCurated(
      ok({
        sections: [
          { title: "修复", items: ["a"] },
          { title: "修复", items: ["b"] },
        ],
      }),
    );
    expect(errs.join()).toContain("重复");
  });

  test("空 items 被拒（会渲染出一个只有徽章的空壳）", () => {
    const errs = validateCurated(ok({ sections: [{ title: "修复", items: [] }] }));
    expect(errs.join()).toContain("空");
  });

  test("userFacing=true 但 sections 为空 → 自相矛盾", () => {
    const errs = validateCurated(ok({ userFacing: true, sections: [] }));
    expect(errs.join()).toContain("userFacing");
  });

  test("userFacing=false 但 sections 非空 → 自相矛盾", () => {
    const errs = validateCurated(ok({ userFacing: false }));
    expect(errs.join()).toContain("userFacing");
  });

  test("条目超长被拒（用户是扫读的）", () => {
    const long = "长".repeat(MAX_ITEM_LEN + 1);
    const errs = validateCurated(ok({ sections: [{ title: "修复", items: [long] }] }));
    expect(errs.join()).toContain("超长");
  });

  test("highlight 超长被拒（会破坏版本标题排版）", () => {
    const errs = validateCurated(ok({ highlight: "长".repeat(MAX_HIGHLIGHT_LEN + 1) }));
    expect(errs.join()).toContain("超长");
  });

  test("highlight 为空串被拒（没有亮点就写 null）", () => {
    expect(validateCurated(ok({ highlight: "" })).join()).toContain("null");
  });

  test("commits 里不是 hash 形态被拒", () => {
    expect(validateCurated(ok({ commits: ["不是hash"] })).join()).toContain("hash");
    expect(validateCurated(ok({ commits: [123] })).join()).toContain("hash");
  });

  test("一次列出全部错误，而不是只报第一条", () => {
    // agent 产出的文件可能同时有好几处不合规，一次全列出来才好一轮改完
    // （也才好把这些错误回喂给 agent 重试）。
    const errs = validateCurated(
      ok({ version: "bad", highlight: "长".repeat(99), sections: [{ title: "文档", items: [] }] }),
    );
    expect(errs.length).toBeGreaterThan(2);
  });
});

describe("validateCurated · URL 拦截（这份文案会发布到公网）", () => {
  /**
   * 为什么 curated 需要**独立**的 URL 拦截，而不是靠生成期的 stripUrls 兜：
   * agent 读 diff 时会看到内网 gitlab 地址、部署脚本里的 IP、主机名，完全可能
   * 原样抄进文案。提示词里有「不要写 URL」这条规则，但提示词不是保障。
   *
   * 而且两道的**行为不同**：这里是**拒绝**（拦在入库前，让人看见并改掉），
   * 生成期的 stripUrls 是**静默改写**（兜底）。只有后者的话，一条含内网地址的
   * 文案会被悄悄改成「<链接已省略>」然后照常发布 —— 没人会发现文案本来想说什么。
   */
  test("条目里的 URL 被拒", () => {
    const errs = validateCurated(
      ok({ sections: [{ title: "修复", items: ["切到 https://www.example.com 了"] }] }),
    );
    expect(errs.join()).toContain("URL");
  });

  test("内网地址与私网 IP 同样被拒（这才是真正有害的那类）", () => {
    for (const bad of [
      "推到 http://git.internal.example.com/foo.git",
      "代理 http://192.168.1.50/searxng",
      "上传到 http://10.0.0.8:9100/mcp",
    ]) {
      const errs = validateCurated(ok({ sections: [{ title: "修复", items: [bad] }] }));
      expect(errs.join()).toContain("URL");
    }
  });

  test("highlight 里的 URL 被拒", () => {
    expect(validateCurated(ok({ highlight: "见 https://x.com" })).join()).toContain("URL");
  });

  test("报错信息里指出具体是哪个 URL（只说「含 URL」没法改）", () => {
    const errs = validateCurated(
      ok({ sections: [{ title: "修复", items: ["见 https://x.com/a"] }] }),
    );
    expect(errs.join()).toContain("https://x.com/a");
  });
});

describe("toRenderSections · 按受控词表重排", () => {
  test("补上 key", () => {
    const out = toRenderSections([{ title: "修复", items: ["a"] }]);
    expect(out).toEqual([{ key: "fix", title: "修复", items: ["a"] }]);
  });

  test("JSON 里顺序错乱也会被重排（人工编辑很容易把破坏性变更放到最后）", () => {
    // 受控词表的顺序是唯一事实源：破坏性变更放最后就排在最不显眼的位置，
    // 而它恰恰是用户升级前最该先看到的。
    const out = toRenderSections([
      { title: "修复", items: ["a"] },
      { title: "破坏性变更", items: ["b"] },
      { title: "新功能", items: ["c"] },
    ]);
    expect(out.map((s) => s.key)).toEqual(["breaking", "feat", "fix"]);
  });

  test("空 items 的分组被丢掉（不渲染空壳）", () => {
    const out = toRenderSections([
      { title: "修复", items: [] },
      { title: "新功能", items: ["c"] },
    ]);
    expect(out.map((s) => s.key)).toEqual(["feat"]);
  });

  test("不改原数组（生成器会在结果上再 map 一次 stripUrls）", () => {
    const input = [{ title: "修复", items: ["a"] }];
    const out = toRenderSections(input);
    out[0]!.items.push("b");
    expect(input[0]!.items).toEqual(["a"]);
  });
});

describe("checkCoverage · 漏掉一整块功能是完全静默的", () => {
  /**
   * 这道检查存在的唯一理由：**漏掉一整块功能是本方案最可能的失败模式，
   * 而它完全静默** —— 页面看起来很正常，只是少了一个功能的介绍，
   * 没有任何断言、任何构建步骤会发现。
   */
  test("commits + discarded 覆盖全部真实提交 → 不 warn", () => {
    const r = checkCoverage({ commits: ["aaa1111"], discarded: ["bbb2222"] }, [
      "aaa1111",
      "bbb2222",
    ]);
    expect(r.unaccounted).toEqual([]);
    expect(r.warn).toBe(false);
  });

  test("大量提交既没采用也没显式丢弃 → warn", () => {
    const real = ["a1", "b2", "c3", "d4", "e5"].map((s) => s + "000000");
    const r = checkCoverage({ commits: [real[0]!], discarded: [] }, real);
    expect(r.unaccounted.length).toBe(4);
    expect(r.warn).toBe(true);
  });

  test("hash 长度不同也能比对（curated 存 short hash，真实区间可能更长）", () => {
    const r = checkCoverage({ commits: ["abcd123"] }, ["abcd1234567890"]);
    expect(r.unaccounted).toEqual([]);
  });

  test("大小写不敏感", () => {
    const r = checkCoverage({ commits: ["ABCD123"] }, ["abcd123"]);
    expect(r.unaccounted).toEqual([]);
  });

  test("真实区间为空时不 warn（避免 0/0 除零算出 NaN）", () => {
    const r = checkCoverage({ commits: [] }, []);
    expect(r.warn).toBe(false);
    expect(r.ratio).toBe(0);
  });

  test("discarded 缺省时按空数组处理，不抛异常", () => {
    const r = checkCoverage({ commits: ["aaa1111"] }, ["aaa1111", "bbb2222"]);
    expect(r.unaccounted).toEqual(["bbb2222"]);
  });
});

/**
 * ── 已入库文件的长期防线 ──
 *
 * 上面那些用例测的是**校验器**，这一组测的是**仓库里真实的 curated 文件**。
 * 两者不可互相替代：人工编辑 curated JSON（review 时改字、补条目）之后
 * **不会再跑 curate 脚本**，那时只有这些断言还在看着。
 */
describe("提示词模板", () => {
  const PROMPT_PATH = resolve(ROOT, "scripts/changelog-curate.prompt.md");

  test("开头的维护者注释必须被剥掉才喂给 agent", () => {
    /**
     * 实测踩到（从 ps 输出里看见的）：文件头那段 HTML 注释是写给维护者的
     * （占位符清单、为什么独立成文件），但它里面的 `{{VERSION}}` `{{COMMIT_LIST}}`
     * **同样会被替换** —— 于是整份提交清单和 schema 示例在提示词里出现了两遍，
     * 一遍在注释里"当占位符说明"，一遍在正文里。既浪费 token，又给 agent
     * 一份自相矛盾的上下文。
     *
     * 这里锁两件事：注释确实存在（否则这条测试失去意义），且剥离逻辑在脚本里。
     */
    const raw = readFileSync(PROMPT_PATH, "utf8");
    expect(raw.trimStart().startsWith("<!--")).toBe(true);
    // 注释里确实含占位符 —— 正是它们会被误替换
    const commentEnd = raw.indexOf("-->");
    expect(raw.slice(0, commentEnd)).toContain("{{VERSION}}");

    const script = readFileSync(resolve(ROOT, "scripts/changelog-curate.ts"), "utf8");
    expect(script).toContain("function loadPromptTemplate");
    // buildPrompt 必须走剥离后的模板，不能直接 readFileSync(PROMPT_PATH)
    expect(script).toContain("const tpl = loadPromptTemplate()");
  });

  test("占位符与脚本注入的键名一一对应（漏一个就会把 {{X}} 原样发给模型）", () => {
    const body = (() => {
      const raw = readFileSync(PROMPT_PATH, "utf8");
      const end = raw.indexOf("-->");
      return raw.slice(end + 3);
    })();
    const script = readFileSync(resolve(ROOT, "scripts/changelog-curate.ts"), "utf8");
    const used = new Set([...body.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]!));
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) {
      // 脚本里的注入写成正则字面量：.replace(/\{\{NAME\}\}/g, ...)
      expect({ placeholder: name, injected: script.includes(`\\{\\{${name}\\}\\}`) }).toEqual({
        placeholder: name,
        injected: true,
      });
    }
  });

  test("词表与长度上限从 schema 注入，不在提示词里手写死", () => {
    // 写两份的后果是提示词教 agent 用一套、校验器按另一套拒绝，而 agent 无从知道错在哪。
    const body = readFileSync(PROMPT_PATH, "utf8");
    expect(body).toContain("{{SECTION_TITLES}}");
    expect(body).toContain("{{MAX_ITEM_LEN}}");
    expect(body).toContain("{{MAX_HIGHLIGHT_LEN}}");
  });

  test("示例内容不取自真实历史（否则示例就成了答案泄漏）", () => {
    /**
     * 实测踩到：第一版示例的 highlight 写的是 v0.1.600 真实发生过的那件事
     * （首字节超时与心跳解耦），结果 agent 为 v0.1.600 生成的 highlight 与示例
     * **逐字相同** —— 无从判断它是真读懂了 diff 还是抄了示例。
     * 示例只该示范形状。
     */
    const script = readFileSync(resolve(ROOT, "scripts/changelog-curate.ts"), "utf8");
    const example = script.slice(
      script.indexOf("const SCHEMA_EXAMPLE"),
      script.indexOf("function buildPrompt"),
    );
    expect(example).toContain("9.9.9"); // 虚构版本号
    expect(example).not.toContain("首字节超时与心跳解耦");
  });
});

describe("已入库的 curated 文件", () => {
  const files = existsSync(CURATED_DIR)
    ? readdirSync(CURATED_DIR).filter((f) => /^v\d+\.\d+\.\d+\.json$/.test(f)).sort()
    : [];

  test("目录存在且有文件（缺了官网会整站显示「无变更说明」）", () => {
    expect(existsSync(CURATED_DIR)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
  });

  test("每个文件都通过 schema 校验", () => {
    for (const f of files) {
      const version = f.replace(/^v/, "").replace(/\.json$/, "");
      const raw = readFileSync(resolve(CURATED_DIR, f), "utf8");
      // 裸 NUL 字节会让 grep 静默漏报整个文件（src/app.ts 曾因此让全仓搜索查不到内容）
      expect(raw.includes("\0")).toBe(false);
      let obj: unknown;
      expect(() => {
        obj = JSON.parse(raw);
      }).not.toThrow();
      const errs = validateCurated(obj, version);
      // 报错时把文件名带上，否则 19 个文件里报红不知道是哪个
      expect({ file: f, errs }).toEqual({ file: f, errs: [] });
    }
  });

  test("每个已打 tag 的版本都有对应文件（官网无降级态，见方案决策 3）", () => {
    const { execFileSync } = require("node:child_process");
    const tags: string[] = execFileSync(
      "git",
      ["tag", "-l", "v*", "--sort=-v:refname"],
      { cwd: ROOT, encoding: "utf8" },
    )
      .split("\n")
      .map((s: string) => s.trim())
      .filter((t: string) => /^v\d+\.\d+\.\d+$/.test(t));

    const have = new Set(files.map((f) => f.replace(/\.json$/, "")));
    const missing = tags.filter((t) => !have.has(t));
    expect(missing).toEqual([]);
  });
});
