/**
 * /model 面板分组 + 搜索纯逻辑测试
 *
 * 覆盖两个缺陷的修复面：
 *   问题一（缺搜索）→ buildModelRows 的 query 过滤 + 跳过标题行的导航
 *   问题二（缺分组）→ 按模型族聚类（族由模型名推断，不是 provider）
 */
import { describe, test, expect } from "bun:test";
import {
  buildModelRows,
  countModelRows,
  firstSelectableIndex,
  indexOfModel,
  inferModelFamily,
  nextSelectableIndex,
  parseModelDescription,
  type ModelOption,
  type ModelRow,
} from "../../src/ui/components/model-grouping.ts";
import { computeScrollStart } from "../../src/ui/components/ModelDialog.tsx";

/** 取某行的模型名（非模型行返回 undefined），省去每处手写类型收窄 */
function nameAt(rows: ModelRow[], idx: number): string | undefined {
  const row = rows[idx];
  return row?.kind === "model" ? row.name : undefined;
}

/** 复刻用户实际配置（问题单里那 12 行平铺列表） */
const MODELS: ModelOption[] = [
  { name: "gpt-5.4", provider: "openai", description: "openai (https://gateway.example.com/v1)" },
  { name: "ali-deepseek-v4-pro", provider: "openai", description: "openai (https://gateway.example.com/v1)" },
  { name: "ali-deepseek-v4-flash", provider: "openai", description: "openai (https://gateway.example.com/v1)" },
  { name: "claude-sonnet-4-6", provider: "anthropic", description: "anthropic (https://gateway.example.com)" },
  { name: "claude-sonnet-5", provider: "anthropic", description: "anthropic (https://gateway.example.com)" },
  { name: "claude-opus-4-8", provider: "anthropic", description: "anthropic (https://code.ppchat.vip)" },
  { name: "claude-opus-5", provider: "anthropic", description: "anthropic (https://code.ppchat.vip)" },
  { name: "glm-5.2", provider: "openai", description: "openai (https://gateway.example.com/v1)" },
  { name: "gpt-5.6-luna", provider: "openai", description: "openai (https://gateway.example.com/v1)" },
  { name: "gemini-3.5-flash", provider: "openai", description: "openai (https://gateway.example.com/v1)" },
  { name: "kimi-k2.6", provider: "openai", description: "openai (https://gateway.example.com/v1)" },
];

describe("inferModelFamily", () => {
  test("族由模型名决定，与 provider 无关", () => {
    // 这是问题二的核心：同一网关下 openai 协议里混着多个族，按 provider 分组等于没分组
    expect(inferModelFamily("ali-deepseek-v4-pro", "openai").key).toBe("deepseek");
    expect(inferModelFamily("glm-5.2", "openai").key).toBe("glm");
    expect(inferModelFamily("gemini-3.5-flash", "openai").key).toBe("gemini");
    expect(inferModelFamily("kimi-k2.6", "openai").key).toBe("kimi");
    expect(inferModelFamily("gpt-5.4", "openai").key).toBe("gpt");
    expect(inferModelFamily("claude-opus-5", "anthropic").key).toBe("claude");
  });

  test("识别不出的模型按 provider 兜底分组", () => {
    const f = inferModelFamily("some-unknown-model", "openai");
    expect(f.key).toBe("provider:openai");
    expect(f.label).toBe("其他 · openai");
  });

  test("provider 也缺失时不抛异常", () => {
    expect(inferModelFamily("", "").label).toBe("其他 · unknown");
  });
});

describe("parseModelDescription", () => {
  test("`provider (baseURL)` 形态只取端点主机名，不重复印 provider", () => {
    expect(parseModelDescription("openai (https://gateway.example.com/v1)", "openai"))
      .toEqual({ endpoint: "gateway.example.com" });
  });

  test("自定义 description 原样透传", () => {
    expect(parseModelDescription("公司内部专用", "openai"))
      .toEqual({ note: "公司内部专用" });
  });

  test("provider 与括号前文本不一致时视为自定义文案", () => {
    expect(parseModelDescription("azure (https://x.com)", "openai"))
      .toEqual({ note: "azure (https://x.com)" });
  });

  test("非法 URL 原样当端点", () => {
    expect(parseModelDescription("openai (local-socket)", "openai"))
      .toEqual({ endpoint: "local-socket" });
  });

  test("空 description 返回空对象", () => {
    expect(parseModelDescription(undefined, "openai")).toEqual({});
  });
});

describe("buildModelRows 分组", () => {
  test("同族模型聚到一起，各族有一行标题", () => {
    const rows = buildModelRows(MODELS, "glm-5.2");
    const headers = rows.filter(r => r.kind === "header");
    expect(headers.map(h => h.kind === "header" ? h.label : "")).toEqual([
      "Claude", "GPT", "DeepSeek", "Gemini", "GLM", "Kimi",
    ]);
    // 标题上的计数与该族成员数一致
    const claudeHeader = headers[0];
    expect(claudeHeader.kind === "header" && claudeHeader.count).toBe(4);
  });

  test("族内保持配置文件原顺序", () => {
    const rows = buildModelRows(MODELS, "glm-5.2");
    const gptIdx = rows.findIndex(r => r.kind === "header" && r.label === "GPT");
    expect(nameAt(rows, gptIdx + 1)).toBe("gpt-5.4");
    expect(nameAt(rows, gptIdx + 2)).toBe("gpt-5.6-luna");
  });

  test("模型总数不因分组而变化（标题行不计入）", () => {
    const rows = buildModelRows(MODELS, "glm-5.2");
    expect(countModelRows(rows)).toBe(MODELS.length);
    expect(rows.length).toBe(MODELS.length + 6); // 11 模型 + 6 组标题
  });

  test("当前模型被标记", () => {
    const rows = buildModelRows(MODELS, "glm-5.2");
    const current = rows.filter(r => r.kind === "model" && r.isCurrent);
    expect(current).toHaveLength(1);
    expect(nameAt(current, 0)).toBe("glm-5.2");
  });

  test("同名不同端点的模型 key 不冲突", () => {
    const dup: ModelOption[] = [
      { name: "claude-sonnet-5", provider: "anthropic", description: "anthropic (https://a.com)" },
      { name: "claude-sonnet-5", provider: "anthropic", description: "anthropic (https://b.com)" },
    ];
    const rows = buildModelRows(dup, "");
    const keys = rows.map(r => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("空列表返回空行序列", () => {
    expect(buildModelRows([], "")).toEqual([]);
  });
});

describe("buildModelRows 搜索过滤", () => {
  test("按模型名过滤", () => {
    const rows = buildModelRows(MODELS, "glm-5.2", "opus");
    expect(countModelRows(rows)).toBe(2);
    expect(rows.filter(r => r.kind === "header")).toHaveLength(1);
  });

  test("按族名过滤（模型名里没有 'deepseek' 以外的族关键词也能命中）", () => {
    const rows = buildModelRows(MODELS, "glm-5.2", "gemini");
    expect(countModelRows(rows)).toBe(1);
  });

  test("按 provider 过滤", () => {
    const rows = buildModelRows(MODELS, "glm-5.2", "anthropic");
    expect(countModelRows(rows)).toBe(4);
  });

  test("按端点过滤", () => {
    const rows = buildModelRows(MODELS, "glm-5.2", "ppchat");
    expect(countModelRows(rows)).toBe(2);
  });

  test("大小写不敏感 + 首尾空白忽略", () => {
    expect(countModelRows(buildModelRows(MODELS, "", "  OPUS  "))).toBe(2);
  });

  test("空族过滤后不产出标题行", () => {
    const rows = buildModelRows(MODELS, "glm-5.2", "kimi");
    expect(rows.filter(r => r.kind === "header")).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  test("无命中返回空", () => {
    expect(buildModelRows(MODELS, "glm-5.2", "zzz-nonexistent")).toEqual([]);
  });
});

describe("导航跳过分组标题", () => {
  const rows = buildModelRows(MODELS, "glm-5.2");

  test("首个可选行是标题之后的第一个模型（不是 index 0 的标题）", () => {
    expect(rows[0].kind).toBe("header");
    expect(firstSelectableIndex(rows)).toBe(1);
  });

  test("向下移动跳过标题行", () => {
    // Claude 族最后一项 → 下一步应落到 GPT 族第一个模型，而不是 "GPT" 标题
    const lastClaude = 4; // header + 4 个 claude → index 1..4
    const next = nextSelectableIndex(rows, lastClaude, 1);
    expect(rows[next]?.kind).toBe("model");
    expect(nameAt(rows, next)).toBe("gpt-5.4");
  });

  test("向上移动跳过标题行", () => {
    const firstGpt = 6;
    const prev = nextSelectableIndex(rows, firstGpt, -1);
    expect(nameAt(rows, prev)).toBe("claude-opus-5");
  });

  test("到末尾环绕回第一个可选行", () => {
    const last = rows.length - 1;
    expect(nextSelectableIndex(rows, last, 1)).toBe(firstSelectableIndex(rows));
  });

  test("到开头环绕回最后一个可选行", () => {
    expect(nextSelectableIndex(rows, firstSelectableIndex(rows), -1)).toBe(rows.length - 1);
  });

  test("只有一个模型时原地返回它", () => {
    const one = buildModelRows([MODELS[0]], "");
    const idx = firstSelectableIndex(one);
    expect(nextSelectableIndex(one, idx, 1)).toBe(idx);
    expect(nextSelectableIndex(one, idx, -1)).toBe(idx);
  });

  test("空行序列返回 -1，不抛异常", () => {
    expect(nextSelectableIndex([], 0, 1)).toBe(-1);
    expect(firstSelectableIndex([])).toBe(-1);
  });
});

describe("indexOfModel", () => {
  const rows = buildModelRows(MODELS, "glm-5.2");

  test("定位到当前模型所在行", () => {
    expect(nameAt(rows, indexOfModel(rows, "glm-5.2"))).toBe("glm-5.2");
  });

  test("找不到时回退首个可选行（不是标题行）", () => {
    const idx = indexOfModel(rows, "not-configured");
    expect(idx).toBe(firstSelectableIndex(rows));
    expect(rows[idx]?.kind).toBe("model");
  });
});

describe("computeScrollStart", () => {
  test("总行数不超过窗口时不滚动", () => {
    expect(computeScrollStart(5, 4, 0, 14)).toBe(0);
  });

  test("光标在窗口上方时窗口跟上去", () => {
    expect(computeScrollStart(30, 3, 10, 14)).toBe(3);
  });

  test("光标在窗口下方时窗口跟下来", () => {
    expect(computeScrollStart(30, 20, 0, 14)).toBe(7);
  });

  test("窗口不越过末尾", () => {
    expect(computeScrollStart(20, 19, 0, 14)).toBe(6);
  });

  test("光标在窗口内时窗口不动", () => {
    expect(computeScrollStart(30, 12, 5, 14)).toBe(5);
  });
});
