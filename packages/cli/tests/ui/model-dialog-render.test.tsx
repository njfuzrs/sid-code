/**
 * /model 面板渲染回归：价格 / 参数列 + 光标详情行
 *
 * 为什么必须是渲染测试而不是只测纯函数：本次改动的风险面是**布局**——
 * 列宽算错的表现是终端里换行错位（整列对齐一起塌掉），而格式化函数的单测
 * 全绿也照样能塌。这里断言真实帧里「每行的列起始位置一致」。
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import stripAnsi from "strip-ansi";
import { render } from "@sid-code/tui-renderer/_vendor/testing.tsx";
import { ModelDialog } from "@sid-code/cli/ui/components/ModelDialog.tsx";
import { KeypressProvider } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import type { ModelProfile } from "@sid-code/core/llm/model-profile.ts";

const GW = "https://uniapi.example.com/v1";
const PP = "https://ppchat.example.com";

const MODELS = [
  { name: "claude-sonnet-4-6", provider: "anthropic", description: `anthropic (${GW})` },
  { name: "claude-opus-4-8", provider: "anthropic", description: `anthropic (${PP})` },
  { name: "gpt-5.4", provider: "openai", description: `openai (${GW})` },
  { name: "unknown-internal-m", provider: "openai", description: `openai (${GW})` },
];

/** 造画像：三个已知模型给精确来源，第四个模拟「什么都查不到」。 */
function profile(over: Partial<ModelProfile>): ModelProfile {
  return {
    name: "x",
    wireModel: "x",
    contextWindow: { value: 200_000, source: "registry" },
    maxOutputTokens: { value: 65_536, source: "registry" },
    pricing: { input: 3, output: 15 },
    pricingSource: "registry",
    efforts: [],
    effortGatedByThinking: false,
    supportsThinkingToggle: false,
    ...over,
  };
}

const PROFILES: Record<string, ModelProfile> = {
  "claude-sonnet-4-6": profile({ name: "claude-sonnet-4-6", wireModel: "claude-sonnet-4-6" }),
  "claude-opus-4-8": profile({
    name: "claude-opus-4-8",
    wireModel: "claude-opus-4-8",
    contextWindow: { value: 1_000_000, source: "registry" },
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    efforts: ["low", "medium", "high", "max"],
  }),
  "gpt-5.4": profile({
    name: "gpt-5.4",
    wireModel: "gpt-5.4",
    contextWindow: { value: 272_000, source: "catalog" },
    pricing: { input: 1.25, output: 10 },
  }),
  // 全 miss：窗口是兜底常量、价格未知 —— 面板必须把这两件事标成"不确定"
  "unknown-internal-m": profile({
    name: "unknown-internal-m",
    wireModel: "unknown-internal-m",
    contextWindow: { value: 1_000_000, source: "fallback" },
    maxOutputTokens: null,
    pricing: null,
    pricingSource: "unknown",
  }),
};

function renderPanel(opts: { columns?: number; withProfiles?: boolean; current?: string } = {}) {
  const { columns = 120, withProfiles = true, current = "gpt-5.4" } = opts;
  // 必须包 KeypressProvider：ModelDialog 用 useKeypress 接键，无 provider 会 throw，
  // 而 React 把它吞成一个空帧——不包的话所有断言都会看到 "\n"，看着像"渲染不出内容"。
  const { lastFrame, unmount } = render(
    React.createElement(
      KeypressProvider,
      null,
      React.createElement(ModelDialog, {
        onClose: () => {},
        currentModel: current,
        availableModels: MODELS,
        onModelSelect: () => {},
        getModelProfiles: withProfiles ? () => PROFILES : undefined,
      }),
    ),
    { columns },
  );
  const frame = stripAnsi(lastFrame() ?? "");
  unmount();
  return frame;
}

describe("宽终端：列齐全且对齐", () => {
  const frame = renderPanel({ columns: 120 });

  test("上下文列出现，且十进制口径正确", () => {
    expect(frame).toContain("200K");
    expect(frame).toContain("272K");
    expect(frame).toContain("1M");
  });

  test("价格列出现，整数价省小数", () => {
    expect(frame).toContain("$3/$15");
    expect(frame).toContain("$5/$25");
    expect(frame).toContain("$1.25/$10");
  });

  test("兜底窗口必须带 ~ 标记 —— 不能把猜的 1M 印成事实", () => {
    expect(frame).toContain("~1M");
  });

  test("各模型行的 provider 列起始位置一致（列宽算错会在这里暴露）", () => {
    // ⚠ 只在**列表行**里找，不能用 includes(name) 全帧搜：标题区的
    // 「当前: gpt-5.4 (openai)」也含模型名与 provider，会被 find 先命中，
    // 量出来的是标题行的列位置（曾因此误判成列宽 bug）。
    // 判据：列表行必然含端点主机名，标题行不含。
    const rows = frame.split("\n").filter((l) => l.includes("example.com"));
    expect(rows.length).toBe(MODELS.length);
    const cols = rows.map((l) => l.indexOf(l.includes("anthropic") ? "anthropic" : "openai"));
    // 四行的 provider 列必须落在同一列上
    expect(new Set(cols).size).toBe(1);
  });

  test("端点 / 上下文 / 价格三列也各自对齐成列", () => {
    const rows = frame.split("\n").filter((l) => l.includes("example.com"));
    // 端点列：所有行的 "example.com" 之前的主机名起点一致 → 用 uniapi/ppchat 的起点量
    const endpointCols = rows.map((l) => {
      const idx = l.indexOf("uniapi.example.com");
      return idx >= 0 ? idx : l.indexOf("ppchat.example.com");
    });
    expect(new Set(endpointCols).size).toBe(1);
  });

  test("每行不超过终端宽度（溢出会换行，把对齐全打乱）", () => {
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(120);
    }
  });
});

describe("光标详情行", () => {
  test("默认落在当前模型上，显示它的完整参数与价格来源", () => {
    const frame = renderPanel({ current: "gpt-5.4" });
    expect(frame).toContain("上下文 272K");
    expect(frame).toContain("输出 64K"); // 65536 按 1024 算 = 64K，与厂商文档一致
    expect(frame).toContain("输入 $1.25/M");
    expect(frame).toContain("输出 $10.00/M");
    expect(frame).toContain("注册表");
  });

  test("缓存价有值时展示，无值时不假造近似值", () => {
    const withCache = renderPanel({ current: "claude-opus-4-8" });
    expect(withCache).toContain("缓存读 $0.50");
    expect(withCache).toContain("写 $6.25");

    const without = renderPanel({ current: "gpt-5.4" });
    expect(without).not.toContain("缓存读");
  });

  test("档位集合出现在详情行（支持切档的模型）", () => {
    expect(renderPanel({ current: "claude-opus-4-8" })).toContain("档位 low/medium/high/max");
  });

  test("兜底窗口给出解释语，而不是只默默标 ~", () => {
    const frame = renderPanel({ current: "unknown-internal-m" });
    expect(frame).toContain("兜底");
    expect(frame).toContain("单价未知");
  });
});

describe("窄终端：裁列不塌版", () => {
  test("60 列下不溢出，且已有的模型名 / provider 仍在", () => {
    const frame = renderPanel({ columns: 60 });
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
    expect(frame).toContain("claude-opus-4-8");
    expect(frame).toContain("anthropic");
  });

  test("窄终端下详情行仍在 —— 裁掉的列信息不丢失（L3.3 折叠要给摘要）", () => {
    const frame = renderPanel({ columns: 60, current: "claude-opus-4-8" });
    expect(frame).toContain("上下文");
  });
});

describe("画像缺失时优雅退化（元数据链路挂了也要能选模型）", () => {
  const frame = renderPanel({ withProfiles: false });

  test("列表照常渲染，模型仍可见可选", () => {
    for (const m of MODELS) expect(frame).toContain(m.name);
  });

  test("不显示价格列与详情行，也不印一堆破折号", () => {
    expect(frame).not.toContain("$");
    expect(frame).not.toContain("上下文");
  });
});
