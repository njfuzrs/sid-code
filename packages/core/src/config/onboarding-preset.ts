/**
 * 首次引导「选预置模型 → 只填 key」的配置改写（纯函数，便于测试）。
 *
 * 背景：安装脚本把团队默认模板整份写成新用户的 settings.json，模板按厂商列了多条官方端点，
 * apiKey 全是占位符 `__YOUR_API_KEY__`。新用户通常只有其中一家的 key。引导里选中一个模型、
 * 填一次 key 之后要做三件事：
 *
 * 1. **同端点的占位符条目一起回填**：DeepSeek 的 pro / flash 共用一个 key，填一次两条都能用；
 *    只认「仍是占位符」的条目，用户已填过的真 key 一律不动。
 * 2. **主模型指向选中的模型**。
 * 3. **把仍指向「没 key 的模型」的引用改到选中模型上**：fallbackModel、subAgentModels。
 *    不改的话主模型能用，但降级 / 子代理一跑就 401——用户只会觉得「装好了却时灵时不灵」。
 *    fallbackModel 指向没 key 的模型时改成同端点里另一个已有 key 的模型，没有就清空（无降级
 *    好过降级到一个必然失败的模型）。
 *
 * 只改写 availableModels / model / fallbackModel / subAgentModels 四个顶层键，其余原样保留；
 * 输入输出都是**原始** settings JSON（不展开 env 占位符），字段名 snake / camel 两种写法都认。
 */

import { PLACEHOLDER_API_KEY } from "./config.ts";

type Raw = Record<string, unknown>;
type RawModel = Record<string, unknown>;

function keyOf(m: RawModel): unknown {
  return m.apiKey ?? m.api_key;
}

function urlOf(m: RawModel): string {
  const v = m.baseURL ?? m.base_url ?? m.baseUrl;
  return typeof v === "string" ? v : "";
}

function isPlaceholder(v: unknown): boolean {
  return typeof v === "string" && v.trim() === PLACEHOLDER_API_KEY;
}

/** 本次引导要写回 settings.json 的顶层键（值为 undefined = 删除该键） */
export type OnboardingPatch = Partial<
  Record<"availableModels" | "model" | "fallbackModel" | "subAgentModels", unknown>
>;

export function applyPresetApiKey(raw: Raw, model: string, apiKey: string): OnboardingPatch {
  const list = Array.isArray(raw.availableModels) ? (raw.availableModels as RawModel[]) : [];
  const picked = list.find((m) => m && m.name === model);
  if (!picked) throw new Error(`settings.json 的 availableModels 里没有模型 "${model}"`);
  const endpoint = urlOf(picked);

  const availableModels = list.map((m) => {
    if (!m || typeof m !== "object") return m;
    const sameEndpoint = m === picked || (endpoint !== "" && urlOf(m) === endpoint);
    if (!sameEndpoint || !isPlaceholder(keyOf(m))) return m;
    // 保留用户（模板）原本的字段名写法
    const field = "api_key" in m && !("apiKey" in m) ? "api_key" : "apiKey";
    return { ...m, [field]: apiKey };
  });

  const usable = new Set(
    availableModels
      .filter((m) => m && typeof m === "object" && !isPlaceholder(keyOf(m as RawModel)))
      .map((m) => (m as RawModel).name as string),
  );
  // ollama 不需要 key：占位符检查对它无意义，视为可用
  for (const m of availableModels as RawModel[]) {
    if (m?.provider === "ollama") usable.add(m.name as string);
  }

  const patch: OnboardingPatch = { availableModels, model };

  const fb = raw.fallbackModel;
  if (typeof fb === "string" && fb !== "" && !usable.has(fb)) {
    const sibling = (availableModels as RawModel[]).find(
      (m) => m.name !== model && usable.has(m.name as string) && urlOf(m) === endpoint,
    );
    patch.fallbackModel = sibling ? sibling.name : "";
  }

  const sub = raw.subAgentModels;
  if (sub && typeof sub === "object" && !Array.isArray(sub)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sub as Record<string, unknown>)) {
      if (typeof v === "string" && v !== "" && !usable.has(v)) {
        next[k] = model;
        changed = true;
      } else {
        next[k] = v;
      }
    }
    if (changed) patch.subAgentModels = next;
  }

  return patch;
}
