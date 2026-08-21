/**
 * catalog-coverage 主口径的回归门禁（2026-08-21）。
 *
 * ## 这道门禁存在的理由
 *
 * `scripts/catalog-coverage.ts` 是「模型元数据体系」那批修复的**唯一主口径载体** ——
 * 覆盖率曲线与投票准确率都靠它复算。而它自己的头部注释就写着 CLAUDE.md 铁律之三：
 * 「分母必须和指标一起写死，换成单个桶或不排除非对话模型，这条曲线会整体平移」。
 *
 * 讽刺的是，在本文件之前它**一个测试都没有**：它警告过的那种漂移，发生在它自己身上时
 * 没有任何东西会报红。而这类漂移的症状不是"报错"，是**脚本照样跑、照样打出一个数字**，
 * 只是那个数字换了含义 —— 跨版本对比因此静默失效，和仓库里
 * 「代理指标奖励把浪费重新贴标签」是同一种病。
 *
 * ## 断言写成什么形态
 *
 * 不锁数字，锁**口径的可区分性**：每条断言都对应一种具体的改坏方式，且构造的 fixture
 * 能让「改坏后」与「改坏前」算出不同的结果。反例是快照式断言 ——
 * 把当天跑出来的 135/113 写进期望值，那只会在上游数据变动时红，
 * 而在分母逻辑被改坏时**恰好还是绿的**（因为它锁的是数字不是逻辑）。
 *
 * 每条断言都做过变异自证（把被测逻辑改坏 → 确认本文件至少 1 条 fail → 改回），
 * 变异表在 `.agents/notes/implemented/testing/2026-08-21-覆盖率主口径立回归门禁.md`。
 *
 * ## 刻意不测什么
 *
 * - **不测真实数字**（覆盖率 82.2% 之类）：那三个上游目录天天变，锁它等于每天红一次，
 *   最后只会被人改期望值糊过去。
 * - **不做端到端联网测试**：慢 + 不确定，且它验的是网络而不是我们的口径逻辑。
 * - **不读本机 `~/.sid-code/gateway-pricing.json`**：分母口径的正确性与本机有几个模型无关，
 *   读真实文件反而让断言随机器变化。所以 `gatewayModels` 被改成可注入 fixture。
 */
import { describe, expect, test } from "bun:test";
import { __parsersForTest } from "@sid-code/core/llm/model-capabilities.ts";
import {
  NON_CHAT_RE,
  RULES,
  TOLERANCE,
  aggregate,
  coverageOf,
  denominators,
  gatewayModels,
  hits,
  scoreRule,
  type GatewayPricingFile,
  type SourceMap,
} from "../../scripts/catalog-coverage.ts";

/** 造一个多桶网关价格文件（只含分母口径关心的那层结构）。 */
function pricing(buckets: Record<string, string[]>): GatewayPricingFile {
  const endpoints: GatewayPricingFile["endpoints"] = {};
  for (const [ep, models] of Object.entries(buckets)) {
    endpoints[ep] = { models: Object.fromEntries(models.map((m) => [m, { input: 1 }])) };
  }
  return { endpoints };
}

/** 造一份源目录（键 → 候选值列表）。 */
function sourceMap(entries: Record<string, Array<Record<string, number>>>): SourceMap {
  return entries as SourceMap;
}

const RULE_MIN = RULES.find(([l]) => l.startsWith("min"))![1];
const RULE_MAX = RULES.find(([l]) => l.startsWith("max"))![1];
const RULE_MODE = RULES.find(([l]) => l.startsWith("众数"))![1];

describe("分母：跨端点桶去重（改坏它整条曲线平移）", () => {
  test("同一模型出现在多个桶里只算一次", () => {
    // 三个桶都有 deepseek-v3，另外两个桶各带一个独占模型 → 去重后应是 3 个。
    const models = gatewayModels(
      pricing({
        "gw-a": ["deepseek-v3", "only-a"],
        "gw-b": ["deepseek-v3", "only-b"],
        "gw-c": ["deepseek-v3"],
      }),
    );
    expect(models).toEqual(["deepseek-v3", "only-a", "only-b"]);
    // 不去重的话这里是 5（3 次 deepseek-v3 + 2 个独占）。
    expect(models.length).toBe(3);
  });

  test("第 2/3 个桶的独占模型必须进分母（专抓「只读第一个桶」）", () => {
    // 第一个桶刻意只放 1 个模型：只读首桶 → 分母 1，正确读法 → 分母 3。
    // 这一条与上一条互补：上面那条在「只读首桶」时算出 2（仍 ≠ 3）也能红，
    // 但这里把首桶缩到 1 个，让「只读首桶」的结果与正确结果差得最远，最难侥幸通过。
    const models = gatewayModels(
      pricing({ first: ["m-first"], second: ["m-second"], third: ["m-third"] }),
    );
    expect(models).toEqual(["m-first", "m-second", "m-third"]);
  });

  test("大小写不同的同一模型归一成一个（网关各桶大小写不一致）", () => {
    const models = gatewayModels(
      pricing({ a: ["DeepSeek-V3", "GLM-5.3"], b: ["deepseek-v3", "glm-5.3"] }),
    );
    // 不 toLowerCase 的话这里是 4 个，且键形态与 normalizeCandidates（全小写）对不上，
    // 于是命中判定也会跟着一起错 —— 一个改动同时打坏分子和分母。
    expect(models).toEqual(["deepseek-v3", "glm-5.3"]);
  });

  test("输出已排序且全小写（下游 diff / 跨版本对比依赖稳定顺序）", () => {
    const models = gatewayModels(pricing({ a: ["zeta", "Alpha"], b: ["mid"] }));
    expect(models).toEqual([...models].sort());
    expect(models).toEqual(models.map((m) => m.toLowerCase()));
  });

  test("空文件 / 缺 endpoints / 缺 models 都返回空数组而不是抛错", () => {
    expect(gatewayModels({})).toEqual([]);
    expect(gatewayModels({ endpoints: {} })).toEqual([]);
    expect(gatewayModels({ endpoints: { a: {} } })).toEqual([]);
    expect(gatewayModels({ endpoints: { a: undefined } })).toEqual([]);
  });
});

describe("分母：非对话模型的排除口径", () => {
  // 每一项都是 NON_CHAT_RE 的一个分支，逐条列出来是刻意的：
  // 删掉正则里任一分支，这里的差值断言就会红（分支少一个 → chat 分母多一个）。
  const NON_CHAT = [
    "text-embedding-3-large",
    "bge-m3-embedding",
    "gte-rerank",
    "bge-reranker-v2",
    "doubao-seedream-4-0",
    "doubao-seedance-1-0-pro",
    "cosyvoice-tts",
    "whisper-large-v3",
    "veo-3-fast",
    "gpt-4o-image",
    "hy-image-v2",
    "gpt-4o-realtime-preview",
  ];
  const CHAT = [
    "deepseek-v3",
    "glm-5.3",
    "qwen3.5-plus",
    "claude-sonnet-5",
    "gpt-5.6-luna",
    "doubao-seed-2-1-pro-260628",
    "gemini-3.1-flash-preview",
  ];

  test("两个分母的差恰好等于非对话条目数", () => {
    const { all, chat } = denominators(gatewayModels(pricing({ gw: [...NON_CHAT, ...CHAT] })));
    expect(all.length).toBe(NON_CHAT.length + CHAT.length);
    expect(all.length - chat.length).toBe(NON_CHAT.length);
  });

  test("每个非对话样本都被排除（逐条，删正则分支时能指到是哪一条）", () => {
    const missed = NON_CHAT.filter((m) => !NON_CHAT_RE.test(m));
    expect(missed).toEqual([]);
  });

  test("正常对话模型一个都不许被误杀", () => {
    const killed = CHAT.filter((m) => NON_CHAT_RE.test(m));
    expect(killed).toEqual([]);
  });

  test("排除只影响分母，不改 all 的内容（分母对必须同源）", () => {
    const all = gatewayModels(pricing({ gw: [...NON_CHAT, ...CHAT] }));
    const d = denominators(all);
    expect(d.all).toEqual(all);
    expect(d.chat.every((m) => all.includes(m))).toBe(true);
  });
});

describe("命中判据：必须与运行时同一套归一化", () => {
  // ⚠ 归一化是**两侧**的：写键侧 `expandKeys`（源里 `azure_ai/deepseek-v3` 会同时登记裸名），
  // 查询侧 `normalizeCandidates`（网关名剥前缀/日期后缀后再查）。覆盖率是这两侧合起来的结果，
  // 所以下面既有「走真实 parser 的端到端」也有「查询侧逐规则」两组。

  test("端到端：litellm 的 provider/model 键能被网关裸名命中（写键侧 expandKeys）", () => {
    // litellm 以 `provider/model` 为主键（实测 81.3% 带 `/`），网关暴露的是裸名。
    // 这条曾经是个真实漏采缺陷：数据采到了，查的时候是 null。
    const maps = [
      __parsersForTest.litellm({
        "azure_ai/deepseek-v3": { mode: "chat", max_input_tokens: 128000 },
      }),
    ];
    expect(hits("deepseek-v3", maps)).toBe(true);
  });

  test("查询侧：渠道路由前缀（origin-/ali-/volc- 等）剥掉后命中", () => {
    // 这一条只能靠查询侧的 normalizeCandidates —— 源里没有 `origin-` 这种键。
    // `hits` 改成只比对原样键，这条立刻红。
    const maps = [sourceMap({ "deepseek-v4-pro": [{ contextWindow: 128000 }] })];
    expect(hits("origin-deepseek-v4-pro", maps)).toBe(true);
  });

  test("查询侧：日期/批次后缀剥掉后命中", () => {
    const maps = [sourceMap({ "deepseek-v3": [{ contextWindow: 128000 }] })];
    expect(hits("deepseek-v3-250324", maps)).toBe(true);
  });

  test("查询侧：vendor 路径前缀剥掉后命中", () => {
    const maps = [sourceMap({ "gpt-5.1-chat": [{ contextWindow: 128000 }] })];
    expect(hits("azure/eu/gpt-5.1-chat", maps)).toBe(true);
  });

  test("真查不到就是查不到（判据不能宽松到人人命中，否则覆盖率恒 100%）", () => {
    const maps = [sourceMap({ "deepseek-v3": [{ contextWindow: 128000 }] })];
    expect(hits("some-model-nobody-has", maps)).toBe(false);
  });

  test("多源取并集：任一源命中即命中", () => {
    const a = sourceMap({ "model-a": [{ contextWindow: 1 }] });
    const b = sourceMap({ "model-b": [{ contextWindow: 1 }] });
    expect(hits("model-b", [a, b])).toBe(true);
    expect(hits("model-a", [a, b])).toBe(true);
    expect(hits("model-c", [a, b])).toBe(false);
  });

  test("coverageOf 的两个分子各自对应两个分母（不能混用）", () => {
    const all = gatewayModels(
      pricing({ gw: ["origin-deepseek-v4-pro", "text-embedding-3-large"] }),
    );
    const denom = denominators(all);
    const maps = [
      sourceMap({
        "deepseek-v4-pro": [{ contextWindow: 128000 }],
        "text-embedding-3-large": [{ contextWindow: 8192 }],
      }),
    ];
    // 全量分母 2 全命中；对话分母 1（embedding 被排除）也全命中。
    expect(coverageOf(maps, denom)).toEqual({ all: 2, chat: 1 });
  });
});

describe("投票准确率：三条规则的计分", () => {
  // 手算基准：三个模型，每个都有 3 个候选值（都 ≥2，都进分母）。
  //   m-low   真值 100000：候选 [100000, 100000, 8000]  → min 8000(低估) max 100000(ok) 众数 100000(ok)
  //   m-high  真值  16384：候选 [16384, 16384, 200000]  → min 16384(ok)   max 200000(高估) 众数 16384(ok)
  //   m-spread真值 128000：候选 [128000, 128000, 64000] → min 64000(低估)  max 128000(ok) 众数 128000(ok)
  const agg = {
    "m-low": [100000, 100000, 8000],
    "m-high": [16384, 16384, 200000],
    "m-spread": [128000, 128000, 64000],
  };
  const truth = new Map([
    ["m-low", 100000],
    ["m-high", 16384],
    ["m-spread", 128000],
  ]);

  test("min 规则：2 低估 1 一致", () => {
    expect(scoreRule(RULE_MIN, agg, truth, null)).toEqual({ n: 3, ok: 1, under: 2, over: 0 });
  });

  test("max 规则：2 一致 1 高估", () => {
    expect(scoreRule(RULE_MAX, agg, truth, null)).toEqual({ n: 3, ok: 2, under: 0, over: 1 });
  });

  test("众数规则：3 全一致（这就是 min→众数 那次修复的证明形态）", () => {
    expect(scoreRule(RULE_MODE, agg, truth, null)).toEqual({ n: 3, ok: 3, under: 0, over: 0 });
  });

  test("ok + under + over 恒等于参与计分的行数（分子不许漏项）", () => {
    for (const fn of [RULE_MIN, RULE_MAX, RULE_MODE]) {
      const r = scoreRule(fn, agg, truth, null);
      expect(r.ok + r.under + r.over).toBe(r.n);
    }
  });
});

describe("投票准确率：maxOutputTokens 的「不超过窗口」钳制", () => {
  // 这是本文件最要紧的一条。运行时投完票还有一道钳制（输出上限装不进窗口一定是错的），
  // 不带钳制算出来的数字与线上不符 —— 那不是复算，是另算一个指标。
  //
  // 构造：真值 output = 8192，候选里混进一个被源填成 context 值的 200000。
  // 窗口候选众数 = 8192（两票）→ 钳制后 min(200000, 8192) = 8192 → 落 ok。
  // 去掉钳制 → 200000 → 落 over。两条结果可区分，所以这条断言抓得住。
  const outAgg = { "m-x": [8192, 200000, 200000] };
  const winAgg = { "m-x": [8192, 8192, 200000] };
  const truth = new Map([["m-x", 8192]]);

  test("带 windows 参数 → ok；不带 → over（同一批数据，只切钳制）", () => {
    const clamped = scoreRule(RULE_MODE, outAgg, truth, winAgg);
    const unclamped = scoreRule(RULE_MODE, outAgg, truth, null);
    expect(clamped).toEqual({ n: 1, ok: 1, under: 0, over: 0 });
    expect(unclamped).toEqual({ n: 1, ok: 0, under: 0, over: 1 });
  });

  test("窗口投不出值（候选空）时不钳制，而不是钳成 0", () => {
    // voteTokenLimit 空集返回 undefined —— 未知就该是未知，绝不能退化成 0
    // （钳到 0 会让所有条目变成极端低估，指标一夜之间"看起来全错"）。
    const r = scoreRule(RULE_MODE, outAgg, truth, {});
    expect(r).toEqual({ n: 1, ok: 0, under: 0, over: 1 });
  });

  test("钳制不会把本来正确的值往下压（窗口 ≥ 输出时是恒等变换）", () => {
    const out = { "m-y": [8192, 8192] };
    const win = { "m-y": [128000, 128000] };
    expect(scoreRule(RULE_MODE, out, new Map([["m-y", 8192]]), win)).toEqual({
      n: 1,
      ok: 1,
      under: 0,
      over: 0,
    });
  });
});

describe("口径边界：≥2 候选值 与 5% 容差", () => {
  test("只有 1 个候选值的模型不进分母（单值无从投票）", () => {
    const agg = { "m-single": [128000], "m-pair": [128000, 128000] };
    const truth = new Map([
      ["m-single", 128000],
      ["m-pair", 128000],
    ]);
    // n=1 而不是 2 —— 把单值算进来会稀释掉规则之间的差异（三条规则在单值上结果相同）。
    expect(scoreRule(RULE_MODE, agg, truth, null).n).toBe(1);
  });

  test("恰好 2 个候选值就要进分母（阈值是 ≥2，不是 >2）", () => {
    const agg = { "m-pair": [128000, 128000] };
    expect(scoreRule(RULE_MODE, agg, new Map([["m-pair", 128000]]), null).n).toBe(1);
  });

  test("容差常量是 5%", () => {
    expect(TOLERANCE).toBe(0.05);
  });

  test("ok 带宽与 under/over 分界联动同一个容差（分界写死 0.95 时这条红）", () => {
    // 带宽是 |Δ|/t ≤ tolerance，分界必须是同一个 tolerance，否则两者之间会出现一条
    // 「既不在带宽内、又被判到错误一侧」的缝。在默认 0.05 上 `0.95` 与 `1 - TOLERANCE`
    // 完全等价，所以必须换个容差值才能暴露 —— 这也是 tolerance 做成参数的唯一理由。
    //
    // 容差 1%：真值 100000、got 97000 出带宽（0.03 > 0.01），
    // 正确分界 0.99t=99000 → 97000 < 99000 判 under；
    // 分界写死 0.95t=95000 → 97000 > 95000 判 over。两者可区分。
    const truth = new Map([["m", 100000]]);
    expect(scoreRule(RULE_MODE, { m: [97000, 97000] }, truth, null, 0.01)).toEqual({
      n: 1,
      ok: 0,
      under: 1,
      over: 0,
    });
    // 带宽本身也随参数走：同一个 97000 在 5% 容差下就该判 ok。
    expect(scoreRule(RULE_MODE, { m: [97000, 97000] }, truth, null, 0.05).ok).toBe(1);
  });

  test("1M vs 1.048M 这类口径差判 ok（容差为 0 时会误判成高估）", () => {
    // 源之间对同一模型常有 1000000 / 1048576 两种写法，那不是判错。
    const agg = { "m-1m": [1048576, 1048576] };
    const r = scoreRule(RULE_MODE, agg, new Map([["m-1m", 1000000]]), null);
    expect(r).toEqual({ n: 1, ok: 1, under: 0, over: 0 });
  });

  test("容差内的低侧偏差同样判 ok（容差是双侧的）", () => {
    const agg = { "m-lo": [98000, 98000] };
    expect(scoreRule(RULE_MODE, agg, new Map([["m-lo", 100000]]), null)).toEqual({
      n: 1,
      ok: 1,
      under: 0,
      over: 0,
    });
  });

  test("超出容差才判低估 / 高估，且分界与 TOLERANCE 联动", () => {
    const under = scoreRule(RULE_MODE, { m: [50000, 50000] }, new Map([["m", 100000]]), null);
    expect(under).toEqual({ n: 1, ok: 0, under: 1, over: 0 });
    const over = scoreRule(RULE_MODE, { m: [200000, 200000] }, new Map([["m", 100000]]), null);
    expect(over).toEqual({ n: 1, ok: 0, under: 0, over: 1 });
  });
});

describe("aggregate：候选值收集不得在写入侧收敛分布", () => {
  test("同一键在多个源里的值全部保留（收敛分布会直接废掉众数投票）", () => {
    const a = sourceMap({ "deepseek-v3": [{ contextWindow: 128000 }] });
    const b = sourceMap({ "deepseek-v3": [{ contextWindow: 64000 }, { contextWindow: 128000 }] });
    expect(aggregate([a, b], "contextWindow")["deepseek-v3"]).toEqual([128000, 64000, 128000]);
  });

  test("非数字 / 缺字段的条目被跳过，不产出 NaN 或 undefined", () => {
    const m = sourceMap({ k: [{ contextWindow: 128000 }, {}, { maxOutputTokens: 8192 }] });
    expect(aggregate([m], "contextWindow").k).toEqual([128000]);
    expect(aggregate([m], "maxOutputTokens").k).toEqual([8192]);
  });

  test("两个字段各自独立聚合（不能串味）", () => {
    const m = sourceMap({ k: [{ contextWindow: 128000, maxOutputTokens: 8192 }] });
    expect(aggregate([m], "contextWindow").k).toEqual([128000]);
    expect(aggregate([m], "maxOutputTokens").k).toEqual([8192]);
  });
});

describe("接线（反漂移）", () => {
  test("三条规则都在，且顺序是 min / max / 众数（输出表按此排版）", () => {
    expect(RULES.map(([l]) => l)).toEqual(["min（旧·窗口）", "max（旧·输出）", "众数（现）"]);
  });

  test("catalog:coverage 挂在 package.json 上", () => {
    const pkg = Bun.file(new URL("../../package.json", import.meta.url).pathname);
    return pkg.text().then((t) => {
      expect(JSON.parse(t).scripts["catalog:coverage"]).toContain("scripts/catalog-coverage.ts");
    });
  });
});
