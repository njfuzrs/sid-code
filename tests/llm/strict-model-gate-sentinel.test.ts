/**
 * 防漂移哨兵：strict（Constrained Decoding）门控不得随模型迭代静默失效
 *
 * ## 事故（会话 20260803-135816-8c8619e7）
 *
 * `ask_user_question` 报「questions.0.question: 期望 string，实际收到 undefined」。
 * 轨迹证据：该次响应 `stop_reason: "tool_use"` / `is_partial: false` /
 * `output_tokens: 873`——**不是截断**（截断只丢尾部，不可能只丢对象里第一个 key
 * 却保住后面 `header` + 3 个完整 options）。下一轮模型自己带着 `question` 重试成功，
 * 说明它知道该字段，这一轮就是漏了。
 *
 * 直接原因是模型漏字段，但 sid-code 有一个缺陷让这次漏发本可被杜绝：
 *
 *   `modelSupportsStrict()` 原实现 = `/claude-(sonnet|opus|haiku)-4/`
 *
 * 它**枚举已知支持的版本号**，于是 Claude 5 系列全部不匹配：`registry.ts:79` 给内置
 * 工具打的 `strict: true` 被 `anthropic.ts` 门控在发线前静默剥掉，**整个 Claude 5
 * 系列失去 Constrained Decoding**，无任何日志。而 strict 正是从协议层杜绝
 * 「required 字段漏发」的机制——开着它，这个错误在物理上不可能发生。
 *
 * 实测轨迹里 1441 轮全是 claude-sonnet-5 / glm-5.2 / gpt-5.6-luna，即 strict 在这套
 * 配置下**从未真正生效过**，缺陷存在期间零信号。
 *
 * ## 这个测试为什么不只测"当前模型名"
 *
 * 只断言 `claude-sonnet-5 === true` 挡不住下一次漂移：Claude 6 发布时同样会掉进坑里。
 * 所以哨兵分两层：
 *
 *   1. **行为层**：断言"未来版本号"（sonnet-6 / opus-10 / 尚不存在的版本）也命中 strict
 *      —— 逼迫实现必须是**排除法**（默认支持，只排已冻结的老版本），枚举法过不了。
 *   2. **源码层**：直接读 anthropic.ts，禁止 `modelSupportsStrict` 体内再出现
 *      「枚举具体新版本号」的写法。行为层能挡住"漏掉未来版本"，但挡不住有人写
 *      `/-(4|5|6)/` 这种"看起来是排除法、实则新枚举"的实现——那会在 Claude 7 复发。
 *
 * 本仓库既有约定：开关类默认值禁止写死模型名单判断，否则必随模型迭代漂移。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { modelSupportsStrict } from "../../src/llm/anthropic.ts";

const ANTHROPIC_SRC = join(import.meta.dir, "../../src/llm/anthropic.ts");

describe("strict 门控防漂移哨兵", () => {
  describe("行为层：当前在用的 Claude 模型必须命中 strict", () => {
    // 这些是 settings.json 里真实配置过的模型名（事故现场就在其中）
    const IN_USE = [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-sonnet-4-6",
      "claude-opus-4-8",
    ];

    for (const model of IN_USE) {
      test(`${model} → strict 启用`, () => {
        expect(
          modelSupportsStrict(model),
          `${model} 失去 strict = 失去 required 字段的协议层保护（事故复发）`,
        ).toBe(true);
      });
    }
  });

  describe("行为层：未来版本号必须默认命中（逼迫排除法实现）", () => {
    // 刻意包含**尚不存在**的版本号。枚举法实现必然在这里红，排除法才能过。
    // 若这些 case 红了，说明有人把判定改回了"枚举已知支持的版本"——正是事故根因。
    const FUTURE = [
      "claude-sonnet-6",
      "claude-opus-6",
      "claude-haiku-6",
      "claude-sonnet-7-2",
      "claude-opus-10",
      "claude-sonnet-42-20990101",
      "claude-fable-5",
      "claude-somethingnew-9",
    ];

    for (const model of FUTURE) {
      test(`${model} → strict 默认启用`, () => {
        expect(
          modelSupportsStrict(model),
          `未来模型 ${model} 默认失去 strict：判定必须是"排除已知不支持"，不是"枚举已知支持"`,
        ).toBe(true);
      });
    }
  });

  describe("行为层：已冻结的老版本与非 Claude 模型不发 strict", () => {
    // Claude 3.x / 2.x / instant / v1 —— strict 自 Claude 4 引入，这些版本号已冻结、
    // 不会再新增，枚举它们不产生漂移。
    const LEGACY = [
      "claude-3-5-sonnet-20241022",
      "claude-3-opus-20240229",
      "claude-3-haiku-20240307",
      "claude-3.5-sonnet",
      "claude-3",
      "claude-2.1",
      "claude-2",
      "claude-instant-1.2",
      "claude-v1",
      "claude-1.3",
    ];

    for (const model of LEGACY) {
      test(`${model} → 不发 strict`, () => {
        expect(modelSupportsStrict(model)).toBe(false);
      });
    }

    // 非 Claude 模型走 Anthropic 兼容端点时，兼容层通常只实现公共子集：
    // 发未知字段的风险不对称（收益是省一次重试，代价可能是整条链路 400）。
    const NON_CLAUDE = ["gpt-5.6-luna", "glm-5.2", "ali-deepseek-v4-pro", "gemini-3-pro", ""];

    for (const model of NON_CLAUDE) {
      test(`非 Claude 模型 ${model || "(空串)"} → 不发 strict`, () => {
        expect(modelSupportsStrict(model)).toBe(false);
      });
    }
  });

  describe("源码层：禁止在门控里重新枚举新版本号", () => {
    /**
     * 抠出 modelSupportsStrict 的**可执行代码**（到下一个顶层 `}` 为止），并剥掉注释。
     *
     * 必须剥注释：注释里正当地会出现版本号与家族名（如「claude-3-opus 也要认边界」
     * 这类说明），把它们算作违例会让哨兵变成"禁止写解释性注释"，纯误报。
     * 判定对象只能是真正参与判断的代码。
     */
    function extractGateBody(): string {
      const src = readFileSync(ANTHROPIC_SRC, "utf8");
      const start = src.indexOf("export function modelSupportsStrict");
      expect(start, "找不到 modelSupportsStrict —— 函数被重命名或不再导出，哨兵失效").toBeGreaterThan(-1);
      const end = src.indexOf("\n}", start);
      expect(end).toBeGreaterThan(start);
      return src
        .slice(start, end)
        .replace(/\/\*[\s\S]*?\*\//g, " ") // 块注释
        .replace(/\/\/[^\n]*/g, " "); // 行注释
    }

    test("函数体不出现 Claude 4 及更新的具体版本号（那是枚举法的特征）", () => {
      const body = extractGateBody();
      // 允许出现 3/2/1/instant（已冻结的排除名单）；
      // 出现 4 及以上的版本号，说明又在枚举"支持哪些新版本"。
      const enumerated = body.match(/claude-(?:[a-z]+-)?(?:[4-9]|\d{2,})/gi) ?? [];
      expect(
        enumerated,
        `门控里出现新版本号 ${JSON.stringify(enumerated)}：`
          + `判定必须是"排除已冻结老版本"，不能枚举支持的新版本——否则下个大版本必复发`,
      ).toEqual([]);
    });

    test("函数体不按具体模型家族名分支（sonnet/opus/haiku 名单会漂移）", () => {
      const body = extractGateBody();
      // 事故实现的另一半特征：/(sonnet|opus|haiku)/ 家族白名单。
      // 新家族（如 fable）发布时会被静默排除。
      const families = body.match(/\b(?:sonnet|opus|haiku|fable)\b/gi) ?? [];
      expect(
        families,
        `门控里出现模型家族名 ${JSON.stringify(families)}：`
          + `新家族发布时会被静默排除（claude-fable-5 就是这么漏的）`,
      ).toEqual([]);
    });
  });

  describe("逃生阀：SID_DISABLE_STRICT_TOOLS 仍在两处调用点生效", () => {
    test("流式与非流式路径都判定环境变量", () => {
      const src = readFileSync(ANTHROPIC_SRC, "utf8");
      // 打开 strict 后若网关不兼容，用户需要一个不改代码的关断手段。
      // 两条路径（流式 sendStream / 非流式 send）必须都带这个判定。
      const hits = src.match(/SID_DISABLE_STRICT_TOOLS/g) ?? [];
      expect(
        hits.length,
        "SID_DISABLE_STRICT_TOOLS 必须在流式 + 非流式两处调用点都生效，否则降级手段有盲区",
      ).toBeGreaterThanOrEqual(2);
    });
  });
});
