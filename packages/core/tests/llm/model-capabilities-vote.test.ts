/**
 * 多源窗口投票（众数规则）+ 采集写键对称性 + models.dev 解析 —— 单测。
 *
 * 这一组用例锁的是**同一条链路上的四个独立失败点**，它们此前各自都在静默产生错数字
 * （数字来自 2026-08-20 实测，复现见 `bun run scripts/catalog-coverage.ts`）：
 *   1. 窗口投票取 min → 系统性低估（77 个有真值的多候选模型上 min 只对 42.9%，
 *      错的 44 个全是低估，最坏 deepseek-v4-flash 被压到 32768，真值 1M）；
 *   2. 输出上限取 max → 加源后系统性高估（三源下只对 31.1%，47 个高估）；
 *   3. parseLitellm 只写全名键 → litellm 74.8% 的带前缀键裸名查不到（17 个网关模型漏采）；
 *   4. 数据源漏 glm-5.3 一类国内模型 → catalog miss 后回落到模糊匹配去猜。
 *
 * 三者的共同点是**都不报错**：数据看起来采到了，查询看起来成功了，只是数字是错的。
 * 所以这些用例的价值不在覆盖率，在于把「错值」钉成会红的断言。
 *
 * 全部不触网：外部源解析用 fixture，投票用直接构造的候选组。
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  voteTokenLimit,
  lookupCapability,
  __resetCapabilityCacheForTest,
  __sanitizeEntryForTest,
  __parsersForTest,
  __voteEntriesForTest,
  __applyCatalogEntryForTest,
  type ModelCapabilityEntry,
} from "@sid-code/core/llm/model-capabilities.ts";
import {
  expandKeys,
  normalizeCandidates,
  stripDateSuffix,
} from "@sid-code/core/llm/model-name-normalize.ts";

beforeEach(() => {
  __resetCapabilityCacheForTest({});
});

/** 把 parse 结果里某个键的窗口候选摊平，方便断言「都进了投票」。 */
function windowsAt(parsed: Record<string, ModelCapabilityEntry[]>, key: string): number[] {
  return (parsed[key] ?? [])
    .map((e) => e.contextWindow)
    .filter((v): v is number => v !== undefined);
}

/** 构造投票候选（source 只影响诊断字段，不影响选值）。 */
function cands(...windows: number[]) {
  return windows.map((w, i) => ({ entry: { contextWindow: w }, source: `src${i}` }));
}

describe("voteTokenLimit — 众数规则（曾经是 min，方向反了）", () => {
  test("众数胜出，不取 min —— 核心回归锁", () => {
    // 第一方与正规托管报同一个真值形成尖峰，阉割部署各家数值分散构不成众数。
    expect(voteTokenLimit([1_000_000, 1_000_000, 262_144, 200_000])).toBe(1_000_000);
  });

  test("deepseek-v4-flash 真实形态：锁 30.5 倍低估不复现", () => {
    // 2026-08-20 实测该模型在三源下有 69 个候选值，min=32768 而真值 1M（30.5 倍低估）。
    // 这里只保留分布形态（一个离群小值 + 一堆真值），不复刻全部 69 个数字。
    // 这条断言就是那次低估的坟墓 —— 改回 min 它必红。
    const values = [32_768, ...Array.from({ length: 10 }, () => 1_000_000)];
    expect(voteTokenLimit(values)).toBe(1_000_000);
  });

  test("⚠ 众数小于 max 时也必须选众数 —— 这条是区分 mode 与 max 的唯一判据", () => {
    // 前几条断言里众数恰好也是最大值，所以「无脑取 max」同样能通过它们。
    // 没有这一条，把整个投票函数改成 `Math.max(...)` 也全绿 —— 那就等于换了个方向的
    // 系统性偏差（高估所有多源模型），而门禁完全看不见。实测形态：deepseek-chat 的
    // 众数是 131072，各源最大值更高；gpt-5.2 众数 272000。
    expect(voteTokenLimit([128_000, 128_000, 128_000, 1_000_000])).toBe(128_000);
    expect(voteTokenLimit([272_000, 272_000, 409_600])).toBe(272_000);
  });

  test("无众数（全不相同）→ 取 max，宁可高估", () => {
    // 高估吃一次 400 后 learnFromError 自愈（一次性、有信号）；
    // 低估零信号、每轮多烧 token（永久性）。这个不对称是刻意的。
    expect(voteTokenLimit([200_000, 1_000_000])).toBe(1_000_000);
  });

  test("众数平局 → 取大（同上，宁可高估）", () => {
    expect(voteTokenLimit([262_144, 262_144, 1_000_000, 1_000_000])).toBe(1_000_000);
  });

  test("单值直接返回", () => {
    expect(voteTokenLimit([500_000])).toBe(500_000);
  });

  test("空集 → undefined，绝不产出 0 或 NaN", () => {
    // 0/NaN 会让 token-estimator 的预算计算彻底失真且不报错；未知就该是未知。
    expect(voteTokenLimit([])).toBeUndefined();
  });

  test("非法值（Infinity / NaN / 负数 / 非整）先被剔除，不参与投票", () => {
    // 第三方数据不可信：一个 Infinity 混进来，取 max 时会直接吃掉整个投票结果。
    expect(voteTokenLimit([Infinity, 128_000, 128_000])).toBe(128_000);
    expect(voteTokenLimit([NaN, -1, 3.14, 200_000])).toBe(200_000);
    expect(voteTokenLimit([Infinity, NaN])).toBeUndefined();
  });
});

describe("voteEntries — 钳制、诊断字段与 effort 取值", () => {
  test("maxOutputTokens 也走众数，不取 max —— 加源后 max 变成净退步", () => {
    // ⚠ 这条是加了第三个源才暴露的：有些源把 output 字段填成了 context 值
    // （gpt-4.1 真值 128K，某些源报 1047576）。两个源时取 max 只偶尔踩到；
    // 加到 30+ provider 后取 max 几乎必然捞到那条错的。
    // 实测（真值 = 内置注册表，5% 容差）：三源 max 31.3% 正确 / 三源众数 69.9% 正确。
    const got = __voteEntriesForTest([
      { entry: { contextWindow: 1_000_000, maxOutputTokens: 131_072 }, source: "a" },
      { entry: { contextWindow: 1_000_000, maxOutputTokens: 131_072 }, source: "b" },
      // 这一条把 output 填成了 context —— 取 max 会选它，众数不会。
      { entry: { contextWindow: 1_000_000, maxOutputTokens: 1_000_000 }, source: "c" },
    ]);
    expect(got?.maxOutputTokens).toBe(131_072);
  });

  test("众数选出的 maxOutputTokens 仍要钳制到不超过 contextWindow", () => {
    // 众数本身也可能选中一个 output > context 的值（该错值在多个源上重复时）。
    // 大于窗口的输出上限一定错：输出装不进窗口，下发出去就是一次必然的 400。
    const got = __voteEntriesForTest([
      { entry: { contextWindow: 200_000, maxOutputTokens: 1_000_000 }, source: "a" },
      { entry: { contextWindow: 200_000, maxOutputTokens: 1_000_000 }, source: "b" },
    ]);
    expect(got?.contextWindow).toBe(200_000);
    expect(got?.maxOutputTokens).toBe(200_000);
  });

  test("窗口未知时不钳制 maxOutputTokens（无从钳制，不能凭空砍）", () => {
    const got = __voteEntriesForTest([{ entry: { maxOutputTokens: 131_072 }, source: "a" }]);
    expect(got?.maxOutputTokens).toBe(131_072);
    expect(got?.contextWindow).toBeUndefined();
  });

  test("多个候选值时写投票分布，便于复算「这个窗口是怎么投出来的」", () => {
    const got = __voteEntriesForTest(cands(1_000_000, 1_000_000, 200_000));
    expect(got?.contextWindow).toBe(1_000_000);
    expect(got?.contextWindowVotes).toEqual({ "1000000": 2, "200000": 1 });
    expect(got?.voteSources?.length).toBe(3);
  });

  test("只有单一候选值时不写分布（复算价值为零，却要在数千条目上各占一份）", () => {
    const got = __voteEntriesForTest(cands(1_000_000, 1_000_000));
    expect(got?.contextWindow).toBe(1_000_000);
    expect(got?.contextWindowVotes).toBeUndefined();
    expect(got?.voteSources).toBeUndefined();
  });

  test("effort 档位取第一个报了该字段的源，不做投票", () => {
    // effort 是**集合**不是标量，各源观测口径不同（网关字段级并集 vs 模型级真值），
    // 投票会拼出一个没有任何源真正声明过的档位集合。
    const got = __voteEntriesForTest([
      { entry: { contextWindow: 1_000 }, source: "a" },
      { entry: { effortValues: ["low", "high"], supportsReasoning: true }, source: "b" },
      { entry: { effortValues: ["none", "max"] }, source: "c" },
    ]);
    expect(got?.effortValues).toEqual(["low", "high"]);
    expect(got?.supportsReasoning).toBe(true);
  });

  test("全部候选都没有可用能力字段 → 返回 null（不写一条空壳进缓存）", () => {
    expect(__voteEntriesForTest([{ entry: { contextWindow: NaN }, source: "a" }])).toBeNull();
    expect(__voteEntriesForTest([])).toBeNull();
  });
});

describe("expandKeys ↔ normalizeCandidates — 写键与查键必须互为镜像", () => {
  test("不变式：expandKeys 产出的每个键都能被 normalizeCandidates 查到", () => {
    // 这条不变式一旦破，症状就是「存进去了但查不到」—— 即 litellm 漏采 74.8% 数据的那个形态，
    // 而它**不会有任何报错**。所以必须机械地枚举，不能靠 review 眼看。
    const samples = [
      "deepseek-v3",
      "azure_ai/deepseek-v3",
      "azure/eu/gpt-5.1-chat",
      "deepinfra/Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "zai-org/glm-5.3",
      "glm-5.3",
      "doubao-seed-1-8-251228",
      "volcengine/doubao-seed-2-0-pro-260215",
      "qwen3.6-plus-2026-04-02",
      "ali-deepseek-v4-pro",
      "MiniMax/MiniMax-M2.5",
    ];
    for (const s of samples) {
      const written = expandKeys(s);
      const queryable = new Set(normalizeCandidates(s));
      for (const key of written) {
        expect(queryable.has(key), `expandKeys("${s}") 产出的 "${key}" 查不到`).toBe(true);
      }
    }
  });

  test("expandKeys：多层路径取最后一段，而不是第一段", () => {
    expect(expandKeys("azure/eu/gpt-5.1-chat")).toEqual(["azure/eu/gpt-5.1-chat", "gpt-5.1-chat"]);
  });

  test("expandKeys：无 '/' 时只有一个键，不产生重复", () => {
    expect(expandKeys("deepseek-v3")).toEqual(["deepseek-v3"]);
  });

  test("normalizeCandidates 顺序由精确到宽松，日期剥离排最后", () => {
    const got = normalizeCandidates("ali-deepseek-v3-250324");
    expect(got[0]).toBe("ali-deepseek-v3-250324");
    expect(got.indexOf("deepseek-v3-250324")).toBeLessThan(got.indexOf("deepseek-v3"));
  });
});

describe("日期后缀归一化 —— 15 个真实缺口里 7 个只差这一条规则", () => {
  test("7 个实测缺口全部能剥到目录里的基础名", () => {
    const cases: Array<[string, string]> = [
      ["deepseek-r1-250528", "deepseek-r1"],
      ["deepseek-v3-1-250821", "deepseek-v3-1"],
      ["deepseek-v3-250324", "deepseek-v3"],
      ["deepseek-v4-flash-202605", "deepseek-v4-flash"],
      ["deepseek-v4-pro-202606", "deepseek-v4-pro"],
      ["doubao-seed-1-8-251228", "doubao-seed-1-8"],
      ["qwen3.6-plus-2026-04-02", "qwen3.6-plus"],
    ];
    for (const [input, expected] of cases) {
      expect(stripDateSuffix(input), input).toBe(expected);
    }
  });

  test("YYYYMMDD 形态：claude-3-5-haiku-20241022 → claude-3-5-haiku（这是期望行为）", () => {
    // 剥离后的基础名确实在目录里，属于「剥对了」。
    expect(stripDateSuffix("claude-3-5-haiku-20241022")).toBe("claude-3-5-haiku");
  });

  test("⚠ 纯数字尾段的长度窗口只有 6 和 8，其余长度一律不剥", () => {
    // 直接锁规则本身，而不是只靠「碰巧找得到的真实模型名」当反例：
    // 实测把长度放宽成 {2,8} 时，下面那组真实反例**全部仍然通过**（它们的尾段都只有 1 位数字），
    // 门禁看不见这个放宽。而放宽的后果是把 `xxx-4-32` 这类版本/尺寸段当日期剥掉，
    // 把不同档位的模型糊成一个 —— 正是这条规则唯一的真风险。
    for (const len of [1, 2, 3, 4, 5, 7, 9, 10]) {
      const name = `some-model-${"1".repeat(len)}`;
      expect(stripDateSuffix(name), `${len} 位数字尾段不该被剥`).toBe(name);
    }
    for (const len of [6, 8]) {
      const name = `some-model-${"1".repeat(len)}`;
      expect(stripDateSuffix(name), `${len} 位数字尾段应被剥`).toBe("some-model");
    }
  });

  test("⚠ 反例：绝不剥版本号 —— 这条正则唯一的真风险", () => {
    // 放宽长度限制就会把这些当日期剥掉，把不同档位的模型糊成一个。
    for (const name of [
      "minimax-m2.5",
      "gpt-4.1",
      "glm-5.3",
      "deepseek-v3-1",
      "kimi-k2.6",
      "claude-sonnet-4-6",
      "doubao-seed-1-6", // 4 位以内的数字段一律不动
      "qwen3-coder-30b-a3b-instruct",
    ]) {
      expect(stripDateSuffix(name), name).toBe(name);
    }
  });

  test("端到端：网关裸名带日期后缀 → 命中目录里的基础名", () => {
    __resetCapabilityCacheForTest({ "deepseek-v3": { contextWindow: 128_000 } });
    expect(lookupCapability("deepseek-v3-250324")?.contextWindow).toBe(128_000);
    // 叠加渠道前缀也要能命中（两条规则组合，不是二选一）
    expect(lookupCapability("ali-deepseek-v3-250324")?.contextWindow).toBe(128_000);
  });

  test("端到端：日期剥离让位于更精确的命中", () => {
    // 同时存在带日期与不带日期的条目时，必须优先用带日期那条（它更精确）。
    __resetCapabilityCacheForTest({
      "deepseek-v3": { contextWindow: 128_000 },
      "deepseek-v3-250324": { contextWindow: 64_000 },
    });
    expect(lookupCapability("deepseek-v3-250324")?.contextWindow).toBe(64_000);
  });
});

describe("parseLitellm — 写键对称（17 个网关模型的漏采现场）", () => {
  test("带 provider 前缀的键必须同时登记裸名 —— 核心回归锁", () => {
    // litellm 以 provider/model 为主键（实测 81.3% 的键带 '/'，其中 74.8% 的裸名不存在），
    // 而企业网关暴露的是裸名。只写全名键 = 把这部分数据存成永远查不到的形态。
    const parsed = __parsersForTest.litellm({
      "azure_ai/deepseek-v3": { max_input_tokens: 128_000, mode: "chat" },
    });
    expect(windowsAt(parsed, "deepseek-v3")).toEqual([128_000]);
    expect(windowsAt(parsed, "azure_ai/deepseek-v3")).toEqual([128_000]);
  });

  test("多层路径取最后一段（azure/eu/gpt-5.1-chat → gpt-5.1-chat）", () => {
    const parsed = __parsersForTest.litellm({
      "azure/eu/gpt-5.1-chat": { max_input_tokens: 272_000, mode: "chat" },
    });
    expect(windowsAt(parsed, "gpt-5.1-chat")).toEqual([272_000]);
  });

  test("⚠ 同裸名多 provider：两个值都要进投票，不得在 parse 内收敛", () => {
    // azure_ai/deepseek-v3 与 deepinfra/.../DeepSeek-V3 是两个部署、两个真实值。
    // 用「先到先得」等于在写键这一层把分布收敛成任选一个，众数投票就拿不到分布了。
    const parsed = __parsersForTest.litellm({
      "azure_ai/deepseek-v3": { max_input_tokens: 128_000, mode: "chat" },
      "deepinfra/deepseek-ai/deepseek-v3": { max_input_tokens: 64_000, mode: "chat" },
    });
    expect(windowsAt(parsed, "deepseek-v3").sort((a, b) => a - b)).toEqual([64_000, 128_000]);
    // 且投票结果不能是 min
    expect(voteTokenLimit(windowsAt(parsed, "deepseek-v3"))).toBe(128_000);
  });

  test("裸名与全名同时存在时不互相覆盖（幂等）", () => {
    const parsed = __parsersForTest.litellm({
      "deepseek-v3": { max_input_tokens: 128_000, mode: "chat" },
      "azure_ai/deepseek-v3": { max_input_tokens: 128_000, mode: "chat" },
    });
    expect(windowsAt(parsed, "deepseek-v3")).toEqual([128_000, 128_000]);
    expect(voteTokenLimit(windowsAt(parsed, "deepseek-v3"))).toBe(128_000);
  });

  test("非对话模型仍被过滤掉（不因写键改动而放宽）", () => {
    const parsed = __parsersForTest.litellm({
      "openai/text-embedding-3-large": { max_input_tokens: 8_191, mode: "embedding" },
    });
    expect(parsed["text-embedding-3-large"]).toBeUndefined();
  });
});

describe("parseOpenRouter — 写键行为不回归", () => {
  test("全名与裸名都登记", () => {
    const parsed = __parsersForTest.openrouter({
      data: [
        {
          id: "deepseek/deepseek-v4",
          top_provider: { context_length: 1_000_000, max_completion_tokens: 65_536 },
          reasoning: { supported_efforts: ["low", "high"] },
          supported_parameters: ["reasoning"],
        },
      ],
    });
    expect(windowsAt(parsed, "deepseek-v4")).toEqual([1_000_000]);
    expect(windowsAt(parsed, "deepseek/deepseek-v4")).toEqual([1_000_000]);
    expect(parsed["deepseek-v4"]?.[0]?.effortValues).toEqual(["low", "high"]);
    expect(parsed["deepseek-v4"]?.[0]?.supportsReasoning).toBe(true);
  });

  test("同裸名多条 → 全部保留（此前 `!(tail in out)` 会丢掉第二条）", () => {
    const parsed = __parsersForTest.openrouter({
      data: [
        { id: "a/glm-5.2", context_length: 1_000_000 },
        { id: "b/glm-5.2", context_length: 200_000 },
      ],
    });
    expect(windowsAt(parsed, "glm-5.2").sort((a, b) => a - b)).toEqual([200_000, 1_000_000]);
  });
});

describe("parseModelsDev — 镜像结构（同一模型多 provider 多条）", () => {
  // 真实镜像片段（2026-08-20 实测，字段已裁剪到我们消费的那几个）。
  const FIXTURE = {
    "zai-coding-plan": {
      models: {
        "glm-5.3": {
          id: "glm-5.3",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 1_000_000, output: 131_072 },
        },
      },
    },
    digitalocean: {
      models: {
        "glm-5.2": {
          id: "glm-5.2",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 262_144, output: 32_768 },
        },
      },
    },
    scaleway: {
      models: {
        "glm-5.2": {
          id: "glm-5.2",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 256_000, output: 32_768 },
        },
      },
    },
    zai: {
      models: {
        "glm-5.2": {
          id: "glm-5.2",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 1_000_000, output: 131_072 },
        },
      },
    },
    "routing-run": {
      models: {
        "glm-5.2": {
          id: "glm-5.2",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 1_000_000, output: 131_072 },
        },
      },
    },
    nvidia: {
      models: {
        "llama-nemotron-rerank-vl-1b-v2": {
          id: "llama-nemotron-rerank-vl-1b-v2",
          modalities: { input: ["text"], output: ["embedding"] },
          limit: { context: 128_000, output: 0 },
        },
        "magpie-tts-zeroshot": {
          id: "magpie-tts-zeroshot",
          modalities: { input: ["text"], output: ["audio"] },
          limit: { context: 0, output: 0 },
        },
      },
    },
    "nano-gpt": {
      models: {
        "zai-org/glm-5.3": {
          id: "zai-org/glm-5.3",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 1_048_576, output: 131_072 },
        },
      },
    },
  };

  test("glm-5.3 被采到，窗口 1M —— 用户报的症状在这里被修掉", () => {
    const parsed = __parsersForTest.modelsDev(FIXTURE);
    expect(windowsAt(parsed, "glm-5.3")).toContain(1_000_000);
    const entry = parsed["glm-5.3"]?.[0];
    // 顺带拿到 litellm/OpenRouter 都没有的 effort 档位 —— 不必再发非法请求去探。
    expect(entry?.effortValues).toEqual(["low", "high", "max"]);
    expect(entry?.supportsReasoning).toBe(true);
    expect(entry?.maxOutputTokens).toBe(131_072);
  });

  test("⚠ 同一模型多 provider 的全部值都进投票，不得在 parse 内收敛", () => {
    // 这些不是重复数据，是不同部署：第三方托管常阉割上下文（实测分歧 5.2 倍）。
    const parsed = __parsersForTest.modelsDev(FIXTURE);
    expect(windowsAt(parsed, "glm-5.2").sort((a, b) => a - b)).toEqual([
      256_000, 262_144, 1_000_000, 1_000_000,
    ]);
    // 众数选中第一方那个真值；min 会选中最阉割的 256000（这正是旧规则的错法）。
    expect(voteTokenLimit(windowsAt(parsed, "glm-5.2"))).toBe(1_000_000);
  });

  test("vendor 路径前缀的 modelId 也登记裸名（nano-gpt 的 zai-org/glm-5.3）", () => {
    const parsed = __parsersForTest.modelsDev(FIXTURE);
    expect(windowsAt(parsed, "glm-5.3")).toContain(1_048_576);
    expect(windowsAt(parsed, "zai-org/glm-5.3")).toEqual([1_048_576]);
  });

  test("非对话模型按 modalities.output 过滤 —— 它们确实带 context 值，会污染投票", () => {
    const parsed = __parsersForTest.modelsDev(FIXTURE);
    expect(parsed["llama-nemotron-rerank-vl-1b-v2"]).toBeUndefined();
    expect(parsed["magpie-tts-zeroshot"]).toBeUndefined();
  });

  test("ctx=0 被数值校验挡掉，不写成一个「窗口为 0」的条目", () => {
    const parsed = __parsersForTest.modelsDev({
      p: { models: { m: { modalities: { output: ["text"] }, limit: { context: 0, output: 0 } } } },
    });
    expect(parsed["m"]).toBeUndefined();
  });

  test("modalities 缺失时放行（未知 ≠ 非对话，宁可多收也不漏掉正常模型）", () => {
    const parsed = __parsersForTest.modelsDev({
      p: { models: { m: { limit: { context: 128_000 } } } },
    });
    expect(windowsAt(parsed, "m")).toEqual([128_000]);
  });

  test("reasoning_options 只认 type === 'effort' 的那一项", () => {
    // 该数组将来可能新增别的 reasoning 选项类型，按位置取会取错。
    const parsed = __parsersForTest.modelsDev({
      p: {
        models: {
          m: {
            limit: { context: 128_000 },
            reasoning_options: [
              { type: "token_budget", values: ["1024", "4096"] },
              { type: "effort", values: ["low", "max"] },
            ],
          },
        },
      },
    });
    expect(parsed["m"]?.[0]?.effortValues).toEqual(["low", "max"]);
  });

  test("畸形输入（非对象 / models 缺失 / 条目非对象）不抛异常", () => {
    for (const raw of [null, undefined, "x", 42, [], { p: null }, { p: { models: 1 } }]) {
      expect(() => __parsersForTest.modelsDev(raw)).not.toThrow();
    }
    expect(__parsersForTest.modelsDev({ p: { models: { m: null } } })).toEqual({});
  });
});

describe("投票诊断字段不得与窗口值脱节", () => {
  test("新一轮采集覆盖窗口时，旧的投票分布必须一并被抹掉", () => {
    // 分布与 contextWindow 是一体的：留着上一轮的分布会拼出一份自相矛盾的记录
    // （窗口 1M，分布却说众数是 200K），排障的人对着它做判断会得出错结论。
    __resetCapabilityCacheForTest({
      "some-model": {
        contextWindow: 200_000,
        contextWindowVotes: { "200000": 3, "128000": 1 },
        voteSources: ["litellm", "openrouter"],
        source: "catalog",
      },
    });
    // 模拟新一轮采集：只投出一个值 → voteEntries 不写分布 → mergeEntry 必须清掉旧分布
    __applyCatalogEntryForTest("some-model", { contextWindow: 1_000_000, source: "catalog" });
    const got = lookupCapability("some-model");
    expect(got?.contextWindow).toBe(1_000_000);
    expect(got?.contextWindowVotes).toBeUndefined();
    expect(got?.voteSources).toBeUndefined();
  });

  test("非 catalog 来源（探针/自愈）不动分布 —— 它没参与投票，无权改投票现场", () => {
    __resetCapabilityCacheForTest({
      "some-model": {
        contextWindow: 200_000,
        contextWindowVotes: { "200000": 3, "128000": 1 },
        source: "catalog",
      },
    });
    __applyCatalogEntryForTest("some-model", { effortValues: ["low"], source: "probe" });
    expect(lookupCapability("some-model")?.contextWindowVotes).toEqual({
      "200000": 3,
      "128000": 1,
    });
  });
});

describe("投票诊断字段的校验（会被渲染给人看，不能自相矛盾）", () => {
  test("非法票数 / 非法窗口键被剔除", () => {
    const got = __sanitizeEntryForTest({
      contextWindow: 1_000_000,
      contextWindowVotes: { "1000000": 3, "200000": -1, "not-a-number": 2, "0": 5 },
      voteSources: ["litellm", "litellm", 42, ""],
    });
    expect(got?.contextWindowVotes).toEqual({ "1000000": 3 });
    expect(got?.voteSources).toEqual(["litellm"]); // 去重 + 丢弃非字符串/空串
  });

  test("只剩诊断字段的记录 → null（否则会被当成「已知」而跳过兜底）", () => {
    // 一条能力字段全 undefined 但非 null 的记录，调用方据「非 null」判定已知，
    // 结果拿到 undefined 窗口 —— 比直接 miss 更糟。
    expect(__sanitizeEntryForTest({ contextWindowVotes: { "1000": 2 } })).toBeNull();
    expect(__sanitizeEntryForTest({ voteSources: ["litellm"] })).toBeNull();
  });
});
