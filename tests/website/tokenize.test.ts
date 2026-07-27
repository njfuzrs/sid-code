/**
 * 站内搜索分词器单测（方案 T-2.1 / T-2.2）。
 *
 * 这个分词器的失效模式是**静默的**：配错不报错，只是搜不到东西。
 * 所以除了常规行为，这里刻意加了两类断言：
 *   ① 索引/查询一致性——用「模拟索引 + 查询」的方式验证 9 个真实查询词能命中，
 *      而不只是检查 token 数组长得对（前者才是用户真实关心的结果）。
 *   ② 确定性——同一输入多次调用结果完全一致。索引在 Bun 建、查询在浏览器做，
 *      任何非确定性（如依赖 Intl.Segmenter 的 ICU 版本）都会导致两端 token 错位。
 *
 * 注意：本单测**无法**覆盖「函数体引用了外部标识符」这个坑——单测里 import 是
 * 正常的，但浏览器端 new Function() 还原时外部标识符不存在。那一条只能靠
 * T-2.4（grep dist/index.html）+ T-2.5（真实浏览器搜索）验证。
 */
import { describe, expect, test } from "bun:test";
import { tokenizeCJK } from "../../website/.vitepress/tokenize";

/** 模拟 minisearch 的行为：文档分词入索引，查询分词后要求全部命中 */
function makeIndex(...docs: string[]): Set<string> {
  const set = new Set<string>();
  for (const d of docs) for (const t of tokenizeCJK(d)) set.add(t);
  return set;
}
function hits(index: Set<string>, query: string): boolean {
  const tokens = tokenizeCJK(query);
  return tokens.length > 0 && tokens.every((t) => index.has(t));
}

describe("tokenizeCJK · CJK bigram 分词", () => {
  describe("真实查询词命中（回归 minisearch 默认分词对中文不可用的问题）", () => {
    // 取自方案 §3.4 的实测文案与查询词表
    const index = makeIndex(
      "sid-code 是一个 AI 编程 CLI 工具，支持多 provider 可插拔与权限门控。",
      "轨迹采集与可观测性，Hook 钩子系统，32 类事件。",
    );

    // 这 9 个词是方案里实测过的：默认分词下「权限」「插拔」命中数为 0
    const QUERIES = [
      "权限",
      "插拔",
      "编程",
      "钩子",
      "可观测",
      "轨迹采集",
      "门控",
      "provider",
      "Hook",
    ];

    for (const q of QUERIES) {
      test(`「${q}」能命中`, () => {
        expect(hits(index, q)).toBe(true);
      });
    }

    test("不相关的词不应命中（防止分词过碎导致什么都能搜到）", () => {
      expect(hits(index, "区块链")).toBe(false);
      expect(hits(index, "kubernetes")).toBe(false);
    });

    /**
     * 回归：AND 语义丢失导致召回爆炸。
     *
     * 上面的 hits() 用 every()（AND 语义）判定，但 minisearch 的
     * searchOptions.combineWith **默认是 OR** —— 只要任一 token 命中就返回整页。
     * bigram 下单字 token 极易撞车：「区块链」的「块/链」、「量子计算」的「子/算」
     * 都能被站内其它词命中，于是根本不存在的词也搜出一堆结果
     * （实测真实浏览器：区块链 32 条、量子计算 20 条，全是噪音）。
     *
     * 这一层单测抓不到（它只测分词，不测 minisearch 的组合策略），
     * 所以这里改为直接断言 config 里显式写了 combineWith: "AND"。
     */
    test("config 必须显式设置 combineWith AND（OR 语义会让无关词也搜出结果）", async () => {
      const cfgSrc = await Bun.file(
        new URL("../../website/.vitepress/config.ts", import.meta.url),
      ).text();
      expect(cfgSrc).toContain('combineWith: "AND"');
    });

    test("OR 语义会让站内不存在的词命中（证明上一条断言不是摆设）", () => {
      const orHits = (q: string) =>
        tokenizeCJK(q).some((t) => index.has(t)); // 模拟 minisearch 默认 OR
      // 「量子计算」站内不存在，但单字「子」被索引里的「钩子」贡献了 ——
      // 这正是真实浏览器里「量子计算」搜出 20 条噪音的机制。
      // AND 下不命中，OR 下命中，差别就在 combineWith。
      expect(hits(index, "量子计算")).toBe(false);
      expect(orHits("量子计算")).toBe(true);
    });
  });

  describe("CJK 段切分规则", () => {
    test("产出全部 1-gram 与全部相邻 2-gram", () => {
      expect(tokenizeCJK("权限门控")).toEqual([
        "权",
        "限",
        "门",
        "控",
        "权限",
        "限门",
        "门控",
      ]);
    });

    test("单个汉字只出 1-gram，无 2-gram", () => {
      expect(tokenizeCJK("读")).toEqual(["读"]);
    });

    test("被非 CJK 隔开的两段互不产生跨段 2-gram", () => {
      const out = tokenizeCJK("权限 门控");
      expect(out).toContain("权限");
      expect(out).toContain("门控");
      // 「限门」跨越了空格，不应出现
      expect(out).not.toContain("限门");
    });

    test("标点作为分隔，不进入 token", () => {
      const out = tokenizeCJK("权限，门控。");
      expect(out).not.toContain("，");
      expect(out).not.toContain("限，");
    });
  });

  describe("非 CJK 段行为与默认分词保持一致", () => {
    test("按非词字符切分并小写化", () => {
      expect(tokenizeCJK("Hello World")).toEqual(["hello", "world"]);
      expect(tokenizeCJK("sid-code --dump-tools")).toEqual([
        "sid",
        "code",
        "dump",
        "tools",
      ]);
    });

    test("下划线与数字保留在同一 token 内", () => {
      expect(tokenizeCJK("MAX_NO_PROGRESS_NAGS2")).toEqual([
        "max_no_progress_nags2",
      ]);
    });

    test("大小写不敏感：查询与索引都会小写化", () => {
      const index = makeIndex("PostToolUseFailure");
      expect(hits(index, "posttoolusefailure")).toBe(true);
      expect(hits(index, "PostToolUseFailure")).toBe(true);
    });
  });

  describe("边界输入", () => {
    test("空串返回空数组", () => {
      expect(tokenizeCJK("")).toEqual([]);
    });

    test("纯符号返回空数组", () => {
      expect(tokenizeCJK("---,。！/ \t\n")).toEqual([]);
    });

    test("纯空白返回空数组", () => {
      expect(tokenizeCJK("   ")).toEqual([]);
    });

    test("中英混排不丢任何一侧", () => {
      const out = tokenizeCJK("用 bun 跑单测");
      expect(out).toContain("bun");
      expect(out).toContain("单测");
      expect(out).toContain("用");
    });

    test("emoji / 代理对不导致抛错或错切", () => {
      expect(() => tokenizeCJK("发布成功 🎉 权限")).not.toThrow();
      expect(tokenizeCJK("发布成功 🎉 权限")).toContain("权限");
    });

    test("日文与韩文同样按 CJK 处理", () => {
      expect(tokenizeCJK("ひらがな")).toContain("ひら");
      expect(tokenizeCJK("한국어")).toContain("한국");
    });
  });

  describe("确定性（索引期在 Bun、查询期在浏览器，两端必须逐字符一致）", () => {
    test("同一输入多次调用结果完全相同", () => {
      const input = "支持多 provider 可插拔与权限门控，Hook 32 类事件";
      const first = tokenizeCJK(input);
      for (let i = 0; i < 5; i++) {
        expect(tokenizeCJK(input)).toEqual(first);
      }
    });

    test("不依赖 Intl.Segmenter（该 API 的切分结果随 ICU 版本漂移）", () => {
      const src = tokenizeCJK.toString();
      expect(src).not.toContain("Segmenter");
      expect(src).not.toContain("Intl");
    });
  });
});
