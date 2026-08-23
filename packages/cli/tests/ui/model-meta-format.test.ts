/**
 * /model 面板参数/价格格式化 + 列宽预算测试
 *
 * 覆盖三件容易改坏的事：
 *   1. 猜测值必须带 `~` —— 把兜底常量 1M 印成事实是本次需求最主要的风险面
 *   2. 便宜价不能显示成 $0.00 —— 固定 2 位小数会让 DeepSeek 那档看起来免费
 *   3. 窄终端裁列时**已有三列永不被裁** —— 端点列承担区分同名渠道的功能性职责
 */
import { describe, test, expect } from "bun:test";
import {
  formatTokens,
  formatTokensSourced,
  formatPricePerM,
  formatPriceColumn,
  formatCapabilityLine,
  formatPricingLine,
  pricingSourceLabel,
  metaSourceLabel,
} from "@sid-code/cli/ui/components/model-meta-format.ts";
import { computeMetaColumns, padTo } from "@sid-code/cli/ui/components/model-meta-layout.ts";
import { TODO_COMPLETED } from "@sid-code/cli/ui/constants/figures.ts";
import stringWidth from "string-width";
import type { ModelProfile } from "@sid-code/core/llm/model-profile.ts";

/**
 * 「当前」徽章的真实宽度，从渲染用的同一个字形常量算出来。
 *
 * 不写字面量：生产代码里这里曾写死 6，实测是 7（`●` 是 1 列不是 2），差 1 列会让恰好
 * 卡在预算边界的那一行被 ink 换行。更关键的是——如果测试也手抄一个 6，两边就会
 * **一起错还互相验证通过**，property 测试反而给了错误的安全感。
 */
const BADGE = stringWidth(` ${TODO_COMPLETED} 当前`);

/** 造一个画像，只覆盖测试关心的字段 */
function profile(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    name: "m",
    wireModel: "m",
    contextWindow: { value: 1_000_000, source: "registry" },
    maxOutputTokens: { value: 65_536, source: "registry" },
    pricing: { input: 3, output: 15 },
    pricingSource: "registry",
    efforts: [],
    effortGatedByThinking: false,
    supportsThinkingToggle: false,
    ...over,
  };
}

describe("formatTokens：十进制口径压缩", () => {
  test("按 1000 换算而非 1024（200000 必须是 200K，不是 195K）", () => {
    expect(formatTokens(200_000)).toBe("200K");
    expect(formatTokens(1_000_000)).toBe("1M");
  });

  test("非整数量级取整到厂商口径（272K 而非 271.4K）", () => {
    expect(formatTokens(271_400)).toBe("271K");
  });

  test("小于 10 的量级保留一位小数（1.5M）", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });

  test("2 的幂按 1024 算 —— 厂商管 65536 叫 64K，不是 66K", () => {
    // 输出上限普遍是 2 的幂，一律按 1000 换算会得到 66K/33K/8.2K，对不上任何官方文档
    expect(formatTokens(65_536)).toBe("64K");
    expect(formatTokens(32_768)).toBe("32K");
    expect(formatTokens(8_192)).toBe("8K");
    expect(formatTokens(1_048_576)).toBe("1M");
  });

  test("千以下原样，非法值给破折号而不是 0", () => {
    expect(formatTokens(512)).toBe("512");
    expect(formatTokens(0)).toBe("—");
    expect(formatTokens(Number.NaN)).toBe("—");
    expect(formatTokens(1.5)).toBe("—");
  });
});

describe("猜测值必须可辨识（本次需求的核心诚实性约束）", () => {
  test("registry / catalog / user 三档精确来源不加记号", () => {
    expect(formatTokensSourced({ value: 200_000, source: "registry" })).toBe("200K");
    expect(formatTokensSourced({ value: 200_000, source: "catalog" })).toBe("200K");
    expect(formatTokensSourced({ value: 200_000, source: "user" })).toBe("200K");
  });

  test("fuzzy / fallback 两档必须加 ~ 前缀", () => {
    expect(formatTokensSourced({ value: 200_000, source: "fuzzy" })).toBe("~200K");
    expect(formatTokensSourced({ value: 1_000_000, source: "fallback" })).toBe("~1M");
  });

  test("null（输出上限全 miss）给破折号，不编数字", () => {
    expect(formatTokensSourced(null)).toBe("—");
  });

  test("只有猜的来源才有解释语，精确来源无需解释", () => {
    expect(metaSourceLabel("fuzzy")).toBeDefined();
    expect(metaSourceLabel("fallback")).toBeDefined();
    expect(metaSourceLabel("registry")).toBeUndefined();
    expect(metaSourceLabel("catalog")).toBeUndefined();
    expect(metaSourceLabel("user")).toBeUndefined();
  });
});

describe("formatPricePerM：便宜价不能归零", () => {
  test("≥1 给两位小数", () => {
    expect(formatPricePerM(3)).toBe("$3.00");
    expect(formatPricePerM(15.5)).toBe("$15.50");
  });

  test("0.01~1 给三位（DeepSeek 那档 $0.435 不能变 $0.44 也不能变 $0.00）", () => {
    expect(formatPricePerM(0.435)).toBe("$0.435");
  });

  test("< 0.01 给四位（固定两位会显示成 $0.00，读起来像免费）", () => {
    expect(formatPricePerM(0.0014)).toBe("$0.0014");
  });

  test("0 是「免费」而不是 $0.00（订阅制/内部渠道确实存在，0 是确定事实）", () => {
    expect(formatPricePerM(0)).toBe("免费");
  });

  test("undefined 给破折号", () => {
    expect(formatPricePerM(undefined)).toBe("—");
  });
});

describe("formatPriceColumn：列表列的紧凑形态", () => {
  test("整数价省掉小数（$3/$15 而不是 $3.00/$15.00）", () => {
    expect(formatPriceColumn(profile({ pricing: { input: 3, output: 15 } }))).toBe("$3/$15");
  });

  test("非整数价保留精度", () => {
    expect(formatPriceColumn(profile({ pricing: { input: 1.25, output: 10 } }))).toBe("$1.25/$10");
  });

  test("按次计费模型走「/次」，不能印成 in $0/out $0", () => {
    // 这是 /model pricing 踩过的坑：quota_type=1 的模型 token 价恒为 0，
    // 按 token 口径展示等于告诉用户"这个模型免费"。
    const p = profile({ pricing: null, perCallUSD: 0.05, pricingSource: "gateway" });
    expect(formatPriceColumn(p)).toBe("$0.050/次");
  });

  test("按次价优先于 token 价（两者互斥，择一展示）", () => {
    const p = profile({ pricing: { input: 0, output: 0 }, perCallUSD: 0.05 });
    expect(formatPriceColumn(p)).toContain("/次");
  });

  test("无价格给破折号", () => {
    expect(formatPriceColumn(profile({ pricing: null }))).toBe("—");
  });
});

describe("formatCapabilityLine：详情第一段", () => {
  test("有档位时列出档位集合", () => {
    const line = formatCapabilityLine(profile({ efforts: ["low", "high", "max"] }));
    expect(line).toContain("上下文 1M");
    expect(line).toContain("输出 64K");
    expect(line).toContain("档位 low/high/max");
  });

  test("不支持档位时整段省略，不写「档位 无」", () => {
    const line = formatCapabilityLine(profile({ efforts: [] }));
    expect(line).not.toContain("档位");
  });

  test("输出上限 null 时省略该段而不是印破折号", () => {
    const line = formatCapabilityLine(profile({ maxOutputTokens: null }));
    expect(line).not.toContain("输出");
  });

  test("别名与真名不同时点出真名（用户才知道实际发出去的是什么）", () => {
    const line = formatCapabilityLine(profile({ name: "gw-claude", wireModel: "claude-opus-5" }));
    expect(line).toContain("真名 claude-opus-5");
  });

  test("别名等于真名时不重复印（无信息量的噪音）", () => {
    expect(formatCapabilityLine(profile({ name: "x", wireModel: "x" }))).not.toContain("真名");
  });
});

describe("formatPricingLine：详情第二段必须交代来源与折算", () => {
  test("四项单价 + 来源标签", () => {
    const line = formatPricingLine(
      profile({ pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }),
    );
    expect(line).toContain("输入 $5.00/M");
    expect(line).toContain("输出 $25.00/M");
    expect(line).toContain("缓存读 $0.50");
    expect(line).toContain("写 $6.25");
    expect(line).toContain("注册表");
  });

  test("缓存价缺失时不展示 —— 近似值（input×0.1）不能冒充厂商公布价", () => {
    const line = formatPricingLine(profile({ pricing: { input: 5, output: 25 } }));
    expect(line).not.toContain("缓存读");
    expect(line).not.toContain("写 ");
  });

  test("cacheWrite=0 一律省掉 —— 网关缺字段时被默认填成 0，印「免费」是冒充事实", () => {
    const line = formatPricingLine(
      profile({ pricing: { input: 1.4, output: 4.2, cacheRead: 0.7, cacheWrite: 0 } }),
    );
    expect(line).toContain("缓存读 $0.700");
    expect(line).not.toContain("写 ");
    // cacheRead 的 0 是另一回事：它没有"缺失被填 0"的路径，真 0 就是真免费
  });

  test("人民币原价必须点破（折算用的是固定汇率快照，不是实时汇率）", () => {
    const line = formatPricingLine(profile({ originalCurrency: "CNY" }));
    expect(line).toContain("原价人民币");
  });

  test("分时段模型标注当前落在哪个时段", () => {
    expect(formatPricingLine(profile({ isPeakNow: true }))).toContain("当前高峰价");
    expect(formatPricingLine(profile({ isPeakNow: false }))).toContain("当前空闲价");
  });

  test("非分时段模型不标时段（大多数模型，标了是噪音）", () => {
    const line = formatPricingLine(profile({ isPeakNow: undefined }));
    expect(line).not.toContain("高峰");
    expect(line).not.toContain("空闲");
  });

  test("四级全 miss 时说明这是估的，而不是静默印兜底价", () => {
    const line = formatPricingLine(profile({ pricing: null, pricingSource: "unknown" }));
    expect(line).toContain("未知");
  });

  test("五个来源档位都有标签（新增档位不能漏翻译）", () => {
    for (const s of ["user", "gateway", "registry", "unknown"] as const) {
      expect(pricingSourceLabel(s).length).toBeGreaterThan(0);
    }
  });
});

describe("computeMetaColumns：窄终端裁列，已有列永不被裁", () => {
  const ITEMS = [
    {
      name: "claude-opus-5",
      provider: "anthropic",
      endpoint: "code.ppchat.vip",
      context: "1M",
      price: "$5/$25",
    },
    {
      name: "gpt-5.4",
      provider: "openai",
      endpoint: "uniapi.ruijie.com.cn",
      context: "272K",
      price: "$1.25/$10",
    },
  ];

  test("宽终端下五列齐全", () => {
    const c = computeMetaColumns(ITEMS, 200);
    expect(c.nameWidth).toBe("claude-opus-5".length);
    expect(c.providerWidth).toBe("anthropic".length);
    expect(c.endpointWidth).toBe("uniapi.ruijie.com.cn".length);
    expect(c.contextWidth).toBe("272K".length);
    expect(c.priceWidth).toBe("$1.25/$10".length);
  });

  test("身份列（名字 / provider）再窄也不裁 —— 没有它们这行就没有意义", () => {
    for (const w of [40, 50, 60, 80]) {
      const c = computeMetaColumns(ITEMS, w);
      expect(c.nameWidth).toBe("claude-opus-5".length);
      expect(c.providerWidth).toBe("anthropic".length);
    }
  });

  test("端点列优先于价格 / 窗口列被认领（区分同名双渠道 > 看到价）", () => {
    // 找一个「端点与价格只能二选一」的宽度：端点必须是胜出的那个。
    // 用短端点名保证它确实能挤进来（长端点名下端点比价格宽，放不下不代表优先级错）。
    const shortEp = ITEMS.map((i) => ({ ...i, endpoint: "gw.io" }));
    let checked = false;
    for (let w = 40; w <= 120; w++) {
      const c = computeMetaColumns(shortEp, w);
      if (c.priceWidth > 0) {
        // 一旦价格列放得下，端点列必须已经放下了（它排在前面认领）
        expect(c.endpointWidth).toBeGreaterThan(0);
        checked = true;
      }
    }
    expect(checked).toBe(true);
  });

  test("价格列优先于窗口列 —— 但仅在两者可互换时（同宽同列数）", () => {
    // 判据要写准：优先级只在「二选一、且选谁列数相同」时才决定胜负。
    // 本组素材里窗口列（4 列 `272K`）比价格列（9 列 `$1.25/$10`）窄，所以存在
    // 「窗口放得下、价格放不下」的宽度区间 —— 那里显示窗口是对的（2 列 > 1 列），
    // 不是优先级错。用等宽素材才能真正测到优先级。
    // 两列必须**真的等宽**才构成"可互换"：`1M`(2) 与 `$3/$9`(5) 不等宽，
    // 存在只放得下窗口的区间，测不到优先级（第一版就错在这里）。
    const equal = ITEMS.map((i) => ({ ...i, context: "12345", price: "$3/$9" }));
    let checked = false;
    for (let w = 40; w <= 200; w++) {
      const c = computeMetaColumns(equal, w);
      if (c.contextWidth > 0) {
        expect(c.priceWidth).toBeGreaterThan(0);
        checked = true;
      }
    }
    expect(checked).toBe(true);
  });

  test("宽度差导致的取舍：窄列能多显示一列时就多显示（列数优先于优先级）", () => {
    // 窗口列窄、价格列宽时，必然存在只放得下窗口的区间 —— 此时显示窗口而不是空着
    let sawContextOnly = false;
    for (let w = 40; w <= 200; w++) {
      const c = computeMetaColumns(ITEMS, w);
      if (c.contextWidth > 0 && c.priceWidth === 0) sawContextOnly = true;
    }
    expect(sawContextOnly).toBe(true);
  });

  test("列宽单调不减：终端越宽，能放的列不会变少", () => {
    let prev = -1;
    for (let w = 40; w <= 220; w += 2) {
      const c = computeMetaColumns(ITEMS, w);
      const n =
        (c.endpointWidth > 0 ? 1 : 0) + (c.contextWidth > 0 ? 1 : 0) + (c.priceWidth > 0 ? 1 : 0);
      expect(n).toBeGreaterThanOrEqual(prev === -1 ? 0 : prev);
      prev = n;
    }
  });

  test("总宽永不超出终端（溢出会被 ink 硬换行，把整个列表的对齐冲掉）", () => {
    for (let w = 40; w <= 200; w += 2) {
      const c = computeMetaColumns(ITEMS, w);
      // 复刻组件的行构成：光标(2) + 各列 + 列间隔(2/列) + 徽章预留(6)
      const used =
        2 +
        c.nameWidth +
        (c.providerWidth ? 2 + c.providerWidth : 0) +
        (c.endpointWidth ? 2 + c.endpointWidth : 0) +
        (c.priceWidth ? 2 + c.priceWidth : 0) +
        (c.contextWidth ? 2 + c.contextWidth : 0) +
        6;
      // 身份列本身可能超宽（模型名极长时不裁，与改动前一致），所以只在身份列装得下时断言
      const identity = 2 + c.nameWidth + 2 + c.providerWidth + BADGE;
      if (identity <= w - 4) expect(used).toBeLessThanOrEqual(w - 4);
    }
  });

  test("画像缺失（全无 context/price）时两列宽为 0，面板退化成改动前形态", () => {
    const c = computeMetaColumns(
      ITEMS.map((i) => ({ name: i.name, provider: i.provider, endpoint: i.endpoint })),
      200,
    );
    expect(c.contextWidth).toBe(0);
    expect(c.priceWidth).toBe(0);
  });

  test("非 TTY（columns=0）按 80 列假设，而不是把所有列裁光", () => {
    const c = computeMetaColumns(ITEMS, 0);
    // 80 列下至少还能放下价格列
    expect(c.priceWidth).toBeGreaterThan(0);
  });
});

describe("computeMetaColumns 的两条不变量（property 测试，穷举列宽组合）", () => {
  // 用确定性伪随机而不是 Math.random：失败时能复现，且不会某天 CI 上偶然挂一次。
  function caseAt(t: number) {
    const seed = (t * 2654435761) % 2147483647;
    const epW = (seed >> 6) % 28;
    return {
      name: "n".repeat(3 + (seed % 30)),
      provider: "p".repeat(3 + ((seed >> 3) % 12)),
      endpoint: epW ? "e".repeat(epW) : undefined,
      context: "c".repeat(1 + ((seed >> 10) % 8)),
      price: "$".repeat(1 + ((seed >> 13) % 14)),
    };
  }

  /** 复刻 ModelDialog 的行构成，算出这套列宽实际会占多少列。 */
  function usedWidth(c: ReturnType<typeof computeMetaColumns>): number {
    return (
      2 + // 光标列
      c.nameWidth +
      (c.providerWidth ? 2 + c.providerWidth : 0) +
      (c.endpointWidth ? 2 + c.endpointWidth : 0) +
      (c.priceWidth ? 2 + c.priceWidth : 0) +
      (c.contextWidth ? 2 + c.contextWidth : 0) +
      BADGE
    );
  }

  test("不变量一：身份列装得下时，总宽永不超出可用宽度", () => {
    let violations = 0;
    for (let t = 0; t < 4000; t++) {
      const item = caseAt(t);
      for (let w = 20; w <= 200; w += 7) {
        const c = computeMetaColumns([item], w);
        const avail = w - 4; // 边框 2 + paddingX 2
        const identity = 2 + c.nameWidth + 2 + c.providerWidth + BADGE;
        // 身份列本身超宽时不裁（与改动前一致，由 ink 换行），不在本不变量范围内
        if (identity <= avail && usedWidth(c) > avail) violations++;
      }
    }
    expect(violations).toBe(0);
  });

  test("不变量二：终端越宽显示的列只增不减（贪心分配会破坏这条）", () => {
    // 这条不是理论洁癖：贪心版实测存在「拉宽终端反而少一列」——端点恰好放得下时
    // 先认领掉宽度，把价格与窗口双双挤掉。用户拖宽窗口信息变少，是纯 bug 观感。
    let violations = 0;
    for (let t = 0; t < 400; t++) {
      const item = caseAt(t);
      let prev = -1;
      for (let w = 20; w <= 240; w++) {
        const c = computeMetaColumns([item], w);
        const n =
          (c.endpointWidth > 0 ? 1 : 0) + (c.contextWidth > 0 ? 1 : 0) + (c.priceWidth > 0 ? 1 : 0);
        if (prev >= 0 && n < prev) violations++;
        prev = n;
      }
    }
    expect(violations).toBe(0);
  });
});

describe("padTo：CJK 安全的列对齐", () => {
  test("按终端列宽补齐，不是按码点数", () => {
    // 「豆包」是 2 个码点但占 4 列，用 .length 会少补 2 个空格导致整列漂移
    expect(padTo("豆包", 6)).toBe("豆包  ");
    expect(padTo("ab", 5)).toBe("ab   ");
  });

  test("超宽时原样返回，不截断（截断会让模型名不可读）", () => {
    expect(padTo("verylongname", 4)).toBe("verylongname");
  });
});
