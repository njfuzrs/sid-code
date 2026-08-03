/**
 * /model 面板的分组 + 搜索纯逻辑（与渲染解耦，便于单测）
 *
 * 两个问题的根因都在"数据没有中间层"：
 *   1. availableModels 直接按配置文件顺序平铺 → 同一模型族散落各处（gpt / deepseek / claude
 *      交替出现），用户要在十几行里目扫找同族；
 *   2. 没有过滤层 → 只能靠 ↑↓ 一行行挪。
 * 这里补上中间层：先按「模型族」聚类（族名从模型名推断，与 provider 无关——ali-deepseek-v4-pro
 * 走 openai 协议但属于 deepseek 族），再按查询过滤，最后摊平成带分组标题的行序列供列表渲染。
 *
 * 设计约束：
 * - 族的顺序**固定**（FAMILY_RULES 顺序），不按"当前模型所在族置顶"之类的动态规则——
 *   面板位置稳定才能形成肌肉记忆，光标初始落点已经解决了"找到当前模型"的需求。
 * - 族内保持配置文件原顺序（稳定排序），尊重用户在 settings.json 里的排列意图。
 */

export interface ModelOption {
  name: string;
  provider: string;
  description?: string;
}

/** 分组标题行 */
export interface ModelHeaderRow {
  kind: "header";
  key: string;
  /** 族展示名，如 "Claude" / "DeepSeek" */
  label: string;
  /** 该族下的模型条数 */
  count: number;
}

/** 模型行（可被选中） */
export interface ModelEntryRow {
  kind: "model";
  key: string;
  name: string;
  provider: string;
  /** 所属族的展示名（供搜索命中与调试） */
  family: string;
  /** 端点主机名（从 description 的 `provider (baseURL)` 形态解析），无则 undefined */
  endpoint?: string;
  /** 非标准 description（用户自定义文案）原样透传，与 endpoint 互斥 */
  note?: string;
  isCurrent: boolean;
}

export type ModelRow = ModelHeaderRow | ModelEntryRow;

/**
 * 模型族识别规则。key 用于分组，label 用于展示，patterns 为模型名小写子串。
 * 顺序即展示顺序；新增族追加到合适位置即可（无匹配的落到「其他 · <provider>」）。
 */
const FAMILY_RULES: Array<{ key: string; label: string; patterns: string[] }> = [
  { key: "claude", label: "Claude", patterns: ["claude"] },
  { key: "gpt", label: "GPT", patterns: ["gpt", "o1-", "o3-", "o4-", "codex"] },
  { key: "deepseek", label: "DeepSeek", patterns: ["deepseek"] },
  { key: "gemini", label: "Gemini", patterns: ["gemini"] },
  { key: "glm", label: "GLM", patterns: ["glm", "chatglm"] },
  { key: "kimi", label: "Kimi", patterns: ["kimi", "moonshot"] },
  { key: "qwen", label: "Qwen", patterns: ["qwen", "qwq"] },
  { key: "grok", label: "Grok", patterns: ["grok"] },
  { key: "llama", label: "Llama", patterns: ["llama"] },
  { key: "mistral", label: "Mistral", patterns: ["mistral", "mixtral"] },
  { key: "doubao", label: "豆包", patterns: ["doubao"] },
  { key: "ernie", label: "文心", patterns: ["ernie", "wenxin"] },
  { key: "hunyuan", label: "混元", patterns: ["hunyuan"] },
  { key: "minimax", label: "MiniMax", patterns: ["minimax", "abab"] },
  { key: "yi", label: "Yi", patterns: ["yi-"] },
  { key: "step", label: "Step", patterns: ["step-"] },
  { key: "ollama", label: "Ollama", patterns: ["ollama"] },
];

/** 未识别族的兜底分组前缀（按 provider 兜底，仍好过全部堆在一起） */
const FALLBACK_PREFIX = "其他";

export interface ModelFamily {
  key: string;
  label: string;
}

/**
 * 从模型名推断模型族。识别不出时按 provider 兜底（族名形如「其他 · openai」）。
 * 注意：族由**模型名**决定而非 provider——同一网关下 openai 协议里混着 deepseek/glm/gemini，
 * 按 provider 分组等于没分组（现状就是十几个模型全挂在 openai 下）。
 */
export function inferModelFamily(name: string, provider: string): ModelFamily {
  const lower = (name || "").toLowerCase();
  for (const rule of FAMILY_RULES) {
    if (rule.patterns.some((p) => lower.includes(p))) {
      return { key: rule.key, label: rule.label };
    }
  }
  const p = provider || "unknown";
  return { key: `provider:${p}`, label: `${FALLBACK_PREFIX} · ${p}` };
}

/** 族的展示优先级：已登记族按 FAMILY_RULES 顺序，兜底族排在最后 */
function familyOrder(key: string): number {
  const idx = FAMILY_RULES.findIndex((r) => r.key === key);
  return idx >= 0 ? idx : FAMILY_RULES.length;
}

/**
 * 解析 description。app.ts 构造的形态是 `${provider} (${baseURL})`——provider 已单独成列，
 * 整串展示等于把 provider 印两遍（"openai — openai (https://…)"），所以这里只取端点主机名。
 * 非该形态的（用户自定义 description）原样透传，不做任何裁剪。
 */
export function parseModelDescription(
  description: string | undefined,
  provider: string,
): { endpoint?: string; note?: string } {
  if (!description) return {};
  const m = description.match(/^(.+?)\s*\((.+)\)$/);
  if (m && m[1].trim() === (provider || "").trim()) {
    const raw = m[2].trim();
    try {
      return { endpoint: new URL(raw).host };
    } catch {
      // 不是合法 URL（如相对路径 / 自定义标识），原样当端点展示
      return { endpoint: raw };
    }
  }
  return { note: description };
}

/** 聚类阶段的内部形态：在行数据上挂族 key（不外泄到渲染层） */
interface DecoratedEntry extends ModelEntryRow {
  familyKey: string;
}

/** 查询是否命中某个模型（名称 / provider / 族名 / 端点 / 自定义描述） */
function matches(row: ModelEntryRow, q: string): boolean {
  return (
    row.name.toLowerCase().includes(q) ||
    row.provider.toLowerCase().includes(q) ||
    row.family.toLowerCase().includes(q) ||
    (row.endpoint?.toLowerCase().includes(q) ?? false) ||
    (row.note?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * 构建带分组标题的扁平行序列：过滤 → 按族聚类 → 摊平。
 * 空族（过滤后无成员）不产出标题行；返回结果可直接喂给列表渲染与滚动窗口。
 */
export function buildModelRows(
  models: ModelOption[],
  currentModel: string,
  query = "",
): ModelRow[] {
  const q = query.trim().toLowerCase();

  const entries: DecoratedEntry[] = models.map((m, i) => {
    const family = inferModelFamily(m.name, m.provider);
    const { endpoint, note } = parseModelDescription(m.description, m.provider);
    return {
      kind: "model",
      // key 带下标：同名不同端点的模型（如两个 claude-sonnet-5）不会撞 React key
      key: `model-${i}-${m.name}`,
      name: m.name,
      provider: m.provider,
      family: family.label,
      endpoint,
      note,
      isCurrent: m.name === currentModel,
      familyKey: family.key,
    };
  });

  const filtered = q ? entries.filter((e) => matches(e, q)) : entries;

  // 按族聚类，族内保持配置原顺序（filter 已是稳定的，直接 push 即可）
  const buckets = new Map<string, { label: string; items: DecoratedEntry[] }>();
  for (const e of filtered) {
    let bucket = buckets.get(e.familyKey);
    if (!bucket) {
      bucket = { label: e.family, items: [] };
      buckets.set(e.familyKey, bucket);
    }
    bucket.items.push(e);
  }

  const sortedKeys = [...buckets.keys()].sort((a, b) => {
    const oa = familyOrder(a);
    const ob = familyOrder(b);
    if (oa !== ob) return oa - ob;
    // 同优先级（都是兜底族）按展示名排，保证确定性
    return buckets.get(a)!.label.localeCompare(buckets.get(b)!.label);
  });

  const rows: ModelRow[] = [];
  for (const fk of sortedKeys) {
    const bucket = buckets.get(fk)!;
    rows.push({
      kind: "header",
      key: `family-${fk}`,
      label: bucket.label,
      count: bucket.items.length,
    });
    rows.push(...bucket.items);
  }
  return rows;
}

/** 行是否可被光标选中（分组标题不可选） */
export function isSelectableRow(row: ModelRow | undefined): boolean {
  return row?.kind === "model";
}

/** 首个可选行下标，全无可选行时返回 -1 */
export function firstSelectableIndex(rows: ModelRow[]): number {
  return rows.findIndex((r) => r.kind === "model");
}

/**
 * 从 from 出发朝 dir 方向找下一个可选行（跳过分组标题），到边界环绕。
 * 无可选行返回 -1；只有一个可选行时原地返回它。
 */
export function nextSelectableIndex(
  rows: ModelRow[],
  from: number,
  dir: 1 | -1,
): number {
  if (rows.length === 0) return -1;
  for (let step = 1; step <= rows.length; step++) {
    const idx = (from + dir * step + rows.length * step) % rows.length;
    if (rows[idx]?.kind === "model") return idx;
  }
  return -1;
}

/** 定位某模型名所在行下标（用于光标初始落在当前模型上），找不到回退首个可选行 */
export function indexOfModel(rows: ModelRow[], name: string): number {
  const idx = rows.findIndex((r) => r.kind === "model" && r.name === name);
  return idx >= 0 ? idx : firstSelectableIndex(rows);
}

/** 可选模型总数（标题行不计入，用于「N 个可用 / M 项匹配」这类计数） */
export function countModelRows(rows: ModelRow[]): number {
  return rows.reduce((n, r) => n + (r.kind === "model" ? 1 : 0), 0);
}
