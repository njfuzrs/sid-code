/**
 * 团队默认模板内容门禁。
 *
 * 模板会被 install.sh 首装整份写成新用户的 settings.json，也会被编译进二进制做老用户
 * 增量补全（backfill-team-defaults.ts）。开源用户拿不到任何私有网关，所以模板只许指向
 * 各厂商**官方端点**，且不许带任何把数据发往维护者服务器的字段。
 */
import { describe, test, expect } from "bun:test";
import teamDefaults from "../../../../scripts/team-defaults.template.json" with { type: "json" };
import { lookupRegistryExact } from "@sid-code/core/llm/model-registry.ts";
import { PLACEHOLDER_API_KEY } from "@sid-code/core/config/config.ts";

type Model = { name: string; provider: string; baseURL: string; apiKey: string };
const tpl = teamDefaults as Record<string, any>;
const models = tpl.availableModels as Model[];

// 官方端点白名单：新增厂商时同步这里与官网 /team/defaults
const OFFICIAL_BASE_URLS: Record<string, string> = {
  "https://api.deepseek.com": "openai",
  "https://api.anthropic.com": "anthropic",
  "https://api.openai.com/v1": "openai",
  "https://open.bigmodel.cn/api/paas/v4": "openai",
  "https://api.moonshot.cn/v1": "openai",
  "https://dashscope.aliyuncs.com/compatible-mode/v1": "openai",
};

describe("team-defaults.template.json", () => {
  test("每个模型都指向官方端点，且 provider 与该端点的协议族一致", () => {
    for (const m of models) {
      expect(OFFICIAL_BASE_URLS[m.baseURL]).toBe(m.provider);
    }
  });

  test("apiKey 一律是占位符（模板不放任何真实 key）", () => {
    for (const m of models) expect(m.apiKey).toBe(PLACEHOLDER_API_KEY);
  });

  test("每个模型都在内置注册表里精确命中（窗口 / 输出上限不靠模糊层猜）", () => {
    for (const m of models) expect(lookupRegistryExact(m.name)).not.toBeNull();
  });

  test("model / fallbackModel / subAgentModels 引用的都在 availableModels 里", () => {
    const names = new Set(models.map((m) => m.name));
    expect(names.has(tpl.model)).toBe(true);
    expect(names.has(tpl.fallbackModel)).toBe(true);
    for (const v of Object.values(tpl.subAgentModels as Record<string, string>)) {
      expect(names.has(v)).toBe(true);
    }
  });

  test("不含会把数据发往维护者服务器的字段（搜索后端 / 轨迹上传 / 企业后端）", () => {
    const raw = JSON.stringify(tpl);
    expect(raw).not.toContain("sid-code.cc");
    expect(tpl.search).toBeUndefined();
    expect(tpl.trace?.upload).toBeUndefined();
    expect(tpl.backend).toBeUndefined();
  });

  test("不含私有网关痕迹（占位网关域名 / 网关路由前缀）", () => {
    const raw = JSON.stringify(tpl);
    expect(raw).not.toContain("example.com");
    for (const m of models) expect(m.name).not.toMatch(/^(ali|origin)-/);
  });
});
