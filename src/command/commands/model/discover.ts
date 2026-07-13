/**
 * /model discover — 自动发现模型参数
 *
 * 遍历 availableModels，通过 Provider API 查询 + 内置速查表兜底，
 * 获取每个模型的 contextWindow / maxOutputTokens。
 *
 * 用法:
 *   /model discover          → 干跑模式，只查询展示结果
 *   /model discover --apply  → 查询并写入 settings.json
 *   /model discover --force  → 强制覆盖已有值
 */

import type { LocalCommandResult, CommandContext } from "../../types.ts";
import type { ModelConfig } from "../../../config/config.ts";
import { lookupCatalog } from "../../../llm/model-params-catalog.ts";
import {
  getSettingsForSource,
  patchSettingsFile,
} from "../../../config/settings/index.ts";
import { getLogger } from "../../../debug/logger.ts";

// ─── 类型 ───────────────────────────────────────────────────────────

type DiscoverSource = "api" | "catalog" | "unchanged" | "failed";

interface DiscoverResult {
  model: ModelConfig;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  source: DiscoverSource;
  error?: string;
}

export interface DiscoverOptions {
  apply: boolean;
  force: boolean;
}

// ─── 主入口 ─────────────────────────────────────────────────────────

export async function discoverModels(
  ctx: CommandContext,
  opts: DiscoverOptions,
): Promise<LocalCommandResult> {
  const models = ctx.config.availableModels;
  if (models.length === 0) {
    return {
      type: "text",
      value: "未配置 availableModels，无模型可发现。\n请在 ~/.sid-code/settings.json 中添加模型配置。",
    };
  }

  // 逐个查询（串行，避免触发限流）
  const results: DiscoverResult[] = [];
  for (const model of models) {
    const result = await discoverSingle(model, opts.force);
    results.push(result);
  }

  // 筛选有变更的结果
  const updates = results.filter(
    (r) => r.source === "api" || r.source === "catalog",
  );

  const report = buildReport(results);

  if (updates.length === 0) {
    return {
      type: "text",
      value: report + "\n\n所有模型参数已是最新，无需更新。",
    };
  }

  if (!opts.apply) {
    return {
      type: "text",
      value:
        report +
        `\n\n发现 ${updates.length} 个模型可更新参数。` +
        "\n使用 /model discover --apply 将以上参数写入 settings.json",
    };
  }

  // --apply 模式：写入 settings.json
  const writeErr = applyUpdates(updates);
  if (writeErr) {
    return {
      type: "text",
      value: report + `\n\n写入失败: ${writeErr}`,
    };
  }

  return {
    type: "text",
    value:
      report +
      `\n\n✓ 已更新 ${updates.length} 个模型的参数到 settings.json` +
      `\n提示：参数将在下次启动 sid-code 时生效。`,
  };
}

// ─── 单模型查询 ─────────────────────────────────────────────────────

async function discoverSingle(
  model: ModelConfig,
  force: boolean,
): Promise<DiscoverResult> {
  // 已有参数且非强制模式 → 跳过
  if (!force && model.contextWindow && model.maxOutputTokens) {
    return {
      model,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      source: "unchanged",
    };
  }

  // 1. 尝试 API 查询
  try {
    const apiResult = await queryProviderAPI(model);
    if (apiResult && (apiResult.contextWindow || apiResult.maxOutputTokens)) {
      return {
        model,
        contextWindow: apiResult.contextWindow ?? model.contextWindow ?? null,
        maxOutputTokens:
          apiResult.maxOutputTokens ?? model.maxOutputTokens ?? null,
        source: "api",
      };
    }
  } catch (err) {
    getLogger().debug(
      "DISCOVER",
      `API 查询失败: ${model.name} — ${err}`,
    );
  }

  // 2. 内置速查表兜底
  const catalogEntry = lookupCatalog(model.name);
  if (catalogEntry) {
    return {
      model,
      contextWindow: catalogEntry.contextWindow,
      maxOutputTokens: catalogEntry.maxOutputTokens,
      source: "catalog",
    };
  }

  // 3. 全部失败
  return { model, contextWindow: null, maxOutputTokens: null, source: "failed" };
}

// ─── Provider API 查询（按 provider 分发）────────────────────────────

async function queryProviderAPI(
  model: ModelConfig,
): Promise<{ contextWindow?: number; maxOutputTokens?: number } | null> {
  const provider = model.provider;
  const apiKey = model.apiKey;
  const baseURL = model.baseURL;

  if (!apiKey || !provider) return null;

  switch (provider) {
    case "anthropic":
      return queryAnthropic(model.name, apiKey, baseURL);
    case "gemini":
    case "google":
      return queryGemini(model.name, apiKey, baseURL);
    case "openai":
    default:
      // OpenAI 兼容类 API（OpenAI/DeepSeek/Qwen/Moonshot）不返回参数
      return null;
  }
}

/**
 * Anthropic: GET /v1/models/{id}
 * 返回 context_window 和 max_output_tokens 字段
 */
async function queryAnthropic(
  modelName: string,
  apiKey: string,
  baseURL?: string,
): Promise<{ contextWindow?: number; maxOutputTokens?: number } | null> {
  const base = (baseURL || "https://api.anthropic.com").replace(/\/$/, "");
  const url = `${base}/v1/models/${encodeURIComponent(modelName)}`;

  const resp = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) return null;

  const data = (await resp.json()) as Record<string, unknown>;
  const cw =
    typeof data.context_window === "number" ? data.context_window : undefined;
  const mo =
    typeof data.max_output_tokens === "number"
      ? data.max_output_tokens
      : undefined;

  if (!cw && !mo) return null;
  return { contextWindow: cw, maxOutputTokens: mo };
}

/**
 * Google Gemini: GET /v1beta/models/{model}?key=
 * 返回 inputTokenLimit 和 outputTokenLimit 字段
 */
async function queryGemini(
  modelName: string,
  apiKey: string,
  baseURL?: string,
): Promise<{ contextWindow?: number; maxOutputTokens?: number } | null> {
  const base = (
    baseURL || "https://generativelanguage.googleapis.com"
  ).replace(/\/$/, "");
  const modelPath = modelName.startsWith("models/")
    ? modelName
    : `models/${modelName}`;
  const url = `${base}/v1beta/${modelPath}?key=${apiKey}`;

  const resp = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) return null;

  const data = (await resp.json()) as Record<string, unknown>;
  const cw =
    typeof data.inputTokenLimit === "number" ? data.inputTokenLimit : undefined;
  const mo =
    typeof data.outputTokenLimit === "number"
      ? data.outputTokenLimit
      : undefined;

  if (!cw && !mo) return null;
  return { contextWindow: cw, maxOutputTokens: mo };
}

// ─── 写入 settings.json ─────────────────────────────────────────────

function applyUpdates(updates: DiscoverResult[]): string | null {
  try {
    const { settings } = getSettingsForSource("userSettings");
    if (!settings) {
      return "无法读取 userSettings";
    }

    const models = [...(settings.availableModels ?? [])];

    for (const update of updates) {
      const idx = models.findIndex((m) => m.name === update.model.name);
      if (idx === -1) continue;
      if (update.contextWindow) {
        models[idx] = { ...models[idx], contextWindow: update.contextWindow };
      }
      if (update.maxOutputTokens) {
        models[idx] = {
          ...models[idx],
          maxOutputTokens: update.maxOutputTokens,
        };
      }
    }

    // 外科式补丁：只写 availableModels，避免整体覆盖丢 api_key/base_url + env 明文化。
    patchSettingsFile("userSettings", "availableModels", models);
    return null;
  } catch (err) {
    return String(err);
  }
}

// ─── 报告格式化 ─────────────────────────────────────────────────────

function buildReport(results: DiscoverResult[]): string {
  const lines: string[] = ["模型参数发现结果:", ""];

  // 表头
  const nameWidth = Math.max(
    12,
    ...results.map((r) => r.model.name.length),
  );
  const header = [
    pad("模型", nameWidth + 4),
    pad("contextWindow", 14),
    pad("maxOutput", 12),
    "来源",
  ].join("  ");
  lines.push(header);
  lines.push("─".repeat(header.length));

  for (const r of results) {
    const icon = sourceIcon(r.source);
    const cw = r.contextWindow ? formatTokens(r.contextWindow) : "—";
    const mo = r.maxOutputTokens ? formatTokens(r.maxOutputTokens) : "—";
    const sourceName = sourceLabel(r.source);

    lines.push(
      [
        `${icon} ${pad(r.model.name, nameWidth + 2)}`,
        pad(cw, 14),
        pad(mo, 12),
        sourceName,
      ].join("  "),
    );
  }

  return lines.join("\n");
}

function sourceIcon(source: DiscoverSource): string {
  switch (source) {
    case "api":
      return "✓";
    case "catalog":
      return "◇";
    case "unchanged":
      return "·";
    case "failed":
      return "⚠";
  }
}

function sourceLabel(source: DiscoverSource): string {
  switch (source) {
    case "api":
      return "API";
    case "catalog":
      return "速查表";
    case "unchanged":
      return "已有";
    case "failed":
      return "失败";
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}
