import type { LocalCommandModule, LocalCommandResult } from "../../types.ts";
import type { CommandContext } from "../../types.ts";
import { resolvePricing } from "@sid-code/core/api/cost-tracker.ts";
import { lookupRegistry, getRegistryEntries } from "@sid-code/core/llm/model-registry.ts";
import { getGatewayCacheMeta, getAllGatewayEntries } from "@sid-code/core/llm/gateway-pricing.ts";
import { lookupGatewayPricing } from "@sid-code/core/llm/gateway-pricing.ts";
import { normalizeBaseURL } from "@sid-code/core/llm/endpoint-key.ts";

/**
 * /model 命令实现（按需加载）
 *
 * 用法:
 *   /model                          - 无可用模型列表时显示当前模型；否则打开选择对话框
 *   /model list                     - 显示所有可用模型 + 当前 fallback / 子代理映射
 *   /model discover                 - 自动发现模型参数（干跑）
 *   /model discover --apply         - 发现并写入 settings.json
 *   /model discover --force         - 强制覆盖已有参数
 *   /model <name>                   - 切换主模型（仅当会话生效）
 *   /model <name> -p                - 切换主模型并持久化到 settings.json（跨会话）
 *   /model fallback <name> [-p]     - 切换 fallback 降级模型
 *   /model fallback clear [-p]      - 清除 fallback（回退到"无降级"）
 *   /model sub <type> <name> [-p]   - 切换子代理模型（type 取自活跃 agent registry：default
 *                                     + explore/task/plan/summarize/verify/general-purpose
 *                                     + 用户自定义 / plugin agent，见 subagentTypes()）
 *   /model sub clear <type> [-p]    - 清除某类型子代理映射（回退 default/主模型）
 *
 * 持久化语义与 /effort 对齐：默认仅当会话生效，加 -p（别名 --persist / save）才写盘。
 */

/**
 * 合法的子代理类型键（default 是 subAgentModels 的兜底键）。
 *
 * 从**活跃 agent registry** 派生，与 config/schema.ts 的 getValidSubagentTypes() 同源。
 * 此前是模块级硬编码数组，已与 registry 漂移：registry 里有 `general-purpose`（以及用户
 * 自定义 / plugin agent），schema 校验也认，但 `/model sub general-purpose <model>` 会被
 * 这里拦成「无效类型」——手改 settings.json 能生效、命令却设不了也清不掉。
 *
 * 改为函数：动态 agent 在启动后期才注册，模块级常量求值太早拿不到（与 schema.ts 同一理由）。
 */
function subagentTypes(): string[] {
  try {
    const { getActiveAgentTypes } = require("@sid-code/core/agent/agent-definition.ts");
    const active = getActiveAgentTypes() as string[];
    if (active.length > 0) return ["default", ...active];
  } catch {
    /* registry 未就绪时退回静态兜底，保证命令仍可用 */
  }
  return ["default", "explore", "task", "plan", "summarize", "verify"];
}

/** 从 token 列表中剥离持久化标志，返回 {persist, rest}。 */
function stripPersist(tokens: string[]): { persist: boolean; rest: string[] } {
  const persist = tokens.some((t) => t === "-p" || t === "--persist" || t === "save");
  const rest = tokens.filter((t) => t !== "-p" && t !== "--persist" && t !== "save");
  return { persist, rest };
}

const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const trimmed = args.trim();

    if (trimmed === "list" || trimmed === "ls") {
      return { type: "text", value: buildAvailableModels(ctx) };
    }

    // /model pricing [--all] —— 输出定价表（默认只列 availableModels，--all 追加全量注册表）
    if (trimmed === "pricing" || trimmed.startsWith("pricing ") || trimmed === "price") {
      const all = trimmed.includes("--all") || trimmed.includes("-a");
      return { type: "text", value: buildPricingTable(ctx, all) };
    }

    if (trimmed === "help" || trimmed === "-h" || trimmed === "--help") {
      return { type: "text", value: buildHelp() };
    }

    // /model discover [--apply|-a] [--force|-f] [--pricing]
    if (trimmed.startsWith("discover") || trimmed.startsWith("disc")) {
      // --pricing：从当前主模型端点（或全部 availableModels 端点）采集网关价格。
      if (trimmed.includes("--pricing")) {
        return syncGatewayPricingCmd(ctx, trimmed.includes("--force") || trimmed.includes("-f"));
      }
      const { discoverModels } = await import("./discover.ts");
      const apply = trimmed.includes("--apply") || trimmed.includes("-a");
      const force = trimmed.includes("--force") || trimmed.includes("-f");
      return discoverModels(ctx, { apply, force });
    }

    const tokens = trimmed.split(/\s+/).filter(Boolean);

    // /model fallback ...
    if (tokens[0] === "fallback" || tokens[0] === "fb") {
      return switchFallback(tokens.slice(1), ctx);
    }

    // /model sub ...
    if (tokens[0] === "sub" || tokens[0] === "subagent") {
      return switchSubAgent(tokens.slice(1), ctx);
    }

    // /model <name> [-p] —— 切换主模型
    if (tokens.length > 0) {
      const { persist, rest } = stripPersist(tokens);
      if (rest.length === 0) {
        // 只给了 -p 没给模型名：提示用法（避免把 "-p" 当模型名去查找报错）。
        return {
          type: "text",
          value: `错误: 缺少模型名\n用法: /model <name> [-p]\n\n${buildHelp()}`,
        };
      }
      return switchModel(rest[0], persist, ctx);
    }

    // 无参数且有可用模型时，打开交互式选择对话框
    if (ctx.config.availableModels.length > 0) {
      return { type: "dialog", dialog: "model" };
    }

    // 无可用模型时（首次启动未配置），打开 onboarding 引导
    return { type: "dialog", dialog: "onboarding" };
  },
};

/** 校验模型名在 availableModels 中；不在则返回错误文本，否则返回 null。 */
function validateModelName(modelName: string, ctx: CommandContext): string | null {
  if (ctx.config.availableModels.length === 0) return null; // 未配置列表时不校验
  const found = ctx.config.availableModels.some((m) => m.name === modelName);
  if (found) return null;

  // 仅大小写不同时直接点出正确写法。模型名匹配刻意保持大小写敏感（网关按原样透传模型名，
  // 擅自纠正可能切到另一个真实存在的条目），但「只差大小写」是高频手误，
  // 让报错自己给出可直接复制的正确名字，比让用户在十几行列表里目扫更省事。
  const caseHit = ctx.config.availableModels.find(
    (m) => m.name.toLowerCase() === modelName.toLowerCase(),
  );
  if (caseHit) {
    return `错误: 模型 "${modelName}" 不在可用模型列表中\n\n模型名区分大小写，你要找的可能是: ${caseHit.name}\n\n使用 /model list 查看详细信息`;
  }

  const available = ctx.config.availableModels.map((m) => `  - ${m.name}`).join("\n");
  return `错误: 模型 "${modelName}" 不在可用模型列表中\n\n可用模型:\n${available}\n\n使用 /model list 查看详细信息`;
}

/** 切换主模型。 */
function switchModel(modelName: string, persist: boolean, ctx: CommandContext): LocalCommandResult {
  const err = validateModelName(modelName, ctx);
  if (err) return { type: "text", value: err };

  ctx.setModel?.(modelName, persist);
  return {
    type: "text",
    value: `主模型已切换为: ${modelName}${persist ? "，并已保存到 settings.json（跨会话生效）" : "（仅当前会话，加 -p 可持久化）"}`,
  };
}

/** 切换 / 清除 fallback 模型。 */
function switchFallback(rawArgs: string[], ctx: CommandContext): LocalCommandResult {
  const { persist, rest } = stripPersist(rawArgs);

  if (rest.length === 0) {
    return {
      type: "text",
      value: `当前 fallback 模型: ${ctx.config.fallbackModel || "(未设置)"}\n\n用法:\n  /model fallback <name> [-p]   切换降级模型\n  /model fallback clear [-p]    清除 fallback`,
    };
  }

  // clear：清除 fallback。
  if (rest[0] === "clear" || rest[0] === "none" || rest[0] === "off") {
    ctx.setFallbackModel?.(undefined, persist);
    return {
      type: "text",
      value: `fallback 模型已清除（主模型出错不再自动降级）${persist ? "，并已保存到 settings.json" : "（仅当前会话，加 -p 可持久化）"}`,
    };
  }

  const modelName = rest[0];
  const err = validateModelName(modelName, ctx);
  if (err) return { type: "text", value: err };

  // 额外校验：fallback 目标必须有 provider（否则运行时无法构建降级 provider）。
  const fb = ctx.config.availableModels.find((m) => m.name === modelName);
  const providerNote =
    fb && !fb.provider
      ? "\n⚠ 该模型在 availableModels 中缺少 provider，运行时降级将被禁用（仅记录配置值）。"
      : "";

  // fallback == 主模型：降级等于"换成同一个模型再试一次"，零降级覆盖。
  // 不阻断（用户可能刻意用它做一次重试），但必须告警——否则用户以为配了保险，
  // 实际主模型挂掉时降级目标同样挂掉，只是多烧一次尝试后报"fallback 已用尽"。
  // 对比：ask 模式的降级候选会显式排除失败模型，唯独这条配置路径没有任何提示。
  const samePrimaryNote =
    modelName === ctx.config.model
      ? `\n⚠ fallback 与当前主模型相同（${modelName}），主模型故障时降级到同一模型不会有降级效果（多烧一次尝试后报「fallback 已用尽」）。建议选一个不同的模型或不同端点的同族模型。`
      : "";

  ctx.setFallbackModel?.(modelName, persist);
  return {
    type: "text",
    value: `fallback 模型已切换为: ${modelName}${persist ? "，并已保存到 settings.json" : "（仅当前会话，加 -p 可持久化）"}${providerNote}${samePrimaryNote}`,
  };
}

/** 切换 / 清除子代理模型。 */
function switchSubAgent(rawArgs: string[], ctx: CommandContext): LocalCommandResult {
  const { persist, rest } = stripPersist(rawArgs);

  if (rest.length === 0) {
    return { type: "text", value: buildSubAgentUsage(ctx) };
  }

  // /model sub clear <type>
  if (rest[0] === "clear" || rest[0] === "none") {
    const type = rest[1];
    if (!type) {
      return {
        type: "text",
        value: `错误: 缺少子代理类型\n用法: /model sub clear <type>\n合法类型: ${subagentTypes().join(" / ")}`,
      };
    }
    if (!isValidSubAgentType(type)) {
      return { type: "text", value: buildInvalidTypeError(type) };
    }
    ctx.setSubAgentModel?.(type, undefined, persist);
    return {
      type: "text",
      value: `子代理[${type}]模型映射已清除（回退 default / 主模型）${persist ? "，并已保存到 settings.json" : "（仅当前会话，加 -p 可持久化）"}`,
    };
  }

  // /model sub <type> <name>
  const type = rest[0];
  const modelName = rest[1];
  if (!isValidSubAgentType(type)) {
    return { type: "text", value: buildInvalidTypeError(type) };
  }
  if (!modelName) {
    return {
      type: "text",
      value: `错误: 缺少模型名\n用法: /model sub ${type} <name> [-p]\n\n${buildSubAgentUsage(ctx)}`,
    };
  }
  const err = validateModelName(modelName, ctx);
  if (err) return { type: "text", value: err };

  ctx.setSubAgentModel?.(type, modelName, persist);
  return {
    type: "text",
    value: `子代理[${type}]模型已切换为: ${modelName}${persist ? "，并已保存到 settings.json" : "（仅当前会话，加 -p 可持久化）"}`,
  };
}

function isValidSubAgentType(type: string): boolean {
  return subagentTypes().includes(type);
}

function buildInvalidTypeError(type: string): string {
  // 「按职责单独指定」那行从实际类型列表派生（去掉 default），不再写死 5 个内置名——
  // 否则用户自定义 agent 出现在「合法类型」里却不出现在说明里，看起来像半支持。
  const others = subagentTypes().filter((t) => t !== "default");
  return `错误: 无效的子代理类型 "${type}"\n合法类型: ${subagentTypes().join(" / ")}\n\n说明:\n  · default —— 兜底，所有未单独指定的子代理类型都用它\n  · ${others.join("/")} —— 按职责单独指定`;
}

/**
 * 判定某模型在某端点下的定价来源（与 resolvePricing 优先级链一致）：
 * 用户手写复合键 > 用户手写仅名 > 网关采集 > 注册表 > 兜底。
 */
function detectPricingSource(
  ctx: CommandContext,
  name: string,
  baseURL?: string,
): "用户手写" | "网关采集" | "内置注册表" | "兜底估算" {
  const models = ctx.config.availableModels;
  const exact = models.find(
    (m) => m.name === name && normalizeBaseURL(m.baseURL) === normalizeBaseURL(baseURL),
  );
  if (exact?.pricing && exact.pricing.input > 0) return "用户手写";
  const byName = models.find((m) => m.name === name);
  if (byName?.pricing && byName.pricing.input > 0) return "用户手写";
  if (lookupGatewayPricing(name, baseURL)) return "网关采集";
  if (lookupRegistry(name)?.pricing) return "内置注册表";
  return "兜底估算";
}

/**
 * 查网关采集缓存里某模型（某端点）的按次单价（quota_type=1）。
 * 命中返回 perCallUSD，否则 undefined（非按次计费 / 未采集）。
 */
function getGatewayPerCall(name: string, baseURL?: string): number | undefined {
  // 端点桶优先，未命中回退合并视图（兼容用户配置端点与采集端点归一化后不完全一致的情况）。
  const scoped = getAllGatewayEntries(baseURL)[name] ?? getAllGatewayEntries()[name];
  if (scoped && scoped.quotaType === 1 && typeof scoped.perCallUSD === "number") {
    return scoped.perCallUSD;
  }
  return undefined;
}

/** 格式化一行价格（in/out/cacheRead/cacheWrite，$/1M）。 */
function formatPriceLine(name: string, availableModels: any[], baseURL?: string): string {
  const p = resolvePricing(name, availableModels, baseURL);
  if (!p) return "价格: (未知，走兜底估算 in $2 / out $10)";
  const parts = [`in $${p.input}/M`, `out $${p.output}/M`];
  if (p.cacheRead !== undefined) parts.push(`cacheRead $${p.cacheRead}/M`);
  if (p.cacheWrite !== undefined) parts.push(`cacheWrite $${p.cacheWrite}/M`);
  return `价格: ${parts.join("  ")}`;
}

function buildAvailableModels(ctx: CommandContext): string {
  if (ctx.config.availableModels.length === 0) {
    return "未配置可用模型列表\n请在 ~/.sid-code/settings.json 中添加 availableModels 配置";
  }
  const lines = ["可用模型列表:"];
  ctx.config.availableModels.forEach((m, idx) => {
    const current = m.name === ctx.config.model ? " ✓ 主模型" : "";
    lines.push(`\n${idx + 1}. ${m.name}${current}`);
    if (m.provider) lines.push(`   提供商: ${m.provider}`);
    if (m.baseURL) lines.push(`   API 地址: ${m.baseURL}`);
    const src = detectPricingSource(ctx, m.name, m.baseURL);
    lines.push(
      `   ${formatPriceLine(m.name, ctx.config.availableModels, m.baseURL)}（来源: ${src}）`,
    );
  });

  // 当前 fallback / 子代理映射一并展示，让用户知道除主模型外还有哪些可切换项。
  lines.push("", "─────────────");
  lines.push(`主模型:     ${ctx.config.model}`);
  lines.push(`fallback:   ${ctx.config.fallbackModel || "(未设置)"}`);
  const sub = ctx.config.subAgentModels as Record<string, string> | undefined;
  if (sub && Object.keys(sub).length > 0) {
    lines.push("子代理映射:");
    for (const [type, name] of Object.entries(sub)) {
      lines.push(`   ${type} → ${name}`);
    }
  } else {
    lines.push("子代理映射: (未设置，全部跟随主模型)");
  }
  lines.push("", "切换命令见 /model help");
  return lines.join("\n");
}

function buildSubAgentUsage(ctx: CommandContext): string {
  const sub = ctx.config.subAgentModels as Record<string, string> | undefined;
  const lines = ["/model sub —— 切换子代理模型", ""];
  lines.push("当前映射:");
  if (sub && Object.keys(sub).length > 0) {
    for (const type of subagentTypes()) {
      if (sub[type]) lines.push(`   ${type} → ${sub[type]}`);
    }
  } else {
    lines.push("   (未设置，全部跟随主模型)");
  }
  lines.push("");
  lines.push("用法:");
  lines.push(`  /model sub <type> <name> [-p]   切换（type: ${subagentTypes().join(" / ")}）`);
  lines.push("  /model sub clear <type> [-p]    清除该类型映射");
  lines.push("");
  lines.push("说明: default 是兜底键，未单独指定的类型都用它；未配则跟主模型。");
  return lines.join("\n");
}

function buildHelp(): string {
  return [
    "/model —— 显示或切换模型（主模型 / fallback / 子代理）",
    "",
    "  /model                          打开模型选择对话框（无参）",
    "  /model list                     显示所有可用模型 + 当前 fallback / 子代理映射",
    "  /model pricing [--all]          显示定价表（--all 追加内置注册表全量）",
    "  /model <name> [-p]              切换主模型（-p 持久化到 settings.json）",
    "  /model fallback <name> [-p]     切换 fallback 降级模型",
    "  /model fallback clear [-p]      清除 fallback",
    `  /model sub <type> <name> [-p]   切换子代理模型（type: ${subagentTypes().join(" / ")}）`,
    "  /model sub clear <type> [-p]    清除某类型子代理映射",
    "  /model discover [--apply]       自动发现模型参数",
    "",
    "持久化：默认仅当会话生效；加 -p（别名 --persist / save）才写入 settings.json 跨会话保留。",
  ].join("\n");
}

/**
 * /model discover --pricing —— 手动从网关采集定价。
 *
 * 遍历 availableModels 里去重后的端点，逐个拉取 `/api/pricing`。每个端点写入各自的
 * 缓存桶（按归一化端点分桶），不再互相覆盖——多渠道场景下所有端点的价格都得以保留。
 */
async function syncGatewayPricingCmd(
  ctx: CommandContext,
  force: boolean,
): Promise<LocalCommandResult> {
  const { syncGatewayPricing } = await import("@sid-code/core/llm/gateway-pricing.ts");
  // 去重端点：优先 availableModels 的 baseURL，回退顶层 config.baseURL。
  const endpoints = new Set<string>();
  for (const m of ctx.config.availableModels) {
    if (m.baseURL) endpoints.add(m.baseURL);
  }
  if (endpoints.size === 0 && ctx.config.baseURL) endpoints.add(ctx.config.baseURL);
  if (endpoints.size === 0) {
    return {
      type: "text",
      value: "未找到可采集的端点（availableModels 与 config.baseURL 均无 base_url）",
    };
  }
  const results: string[] = ["网关定价采集结果:"];
  for (const baseURL of endpoints) {
    try {
      const r = await syncGatewayPricing({ baseURL, force });
      results.push(
        `  ${baseURL} → ${r.reason}（${r.count} 条，${r.updated ? "已更新" : "无变化"}）`,
      );
    } catch (e) {
      results.push(`  ${baseURL} → 采集失败: ${String(e)}`);
    }
  }
  results.push("", "查看结果: /model pricing");
  return { type: "text", value: results.join("\n") };
}

/**
 * /model pricing —— 输出定价表供用户核对。
 *
 * 默认列出 availableModels（用户实际会用到的模型 + 端点 + 解析后价格 + 来源）。
 * --all 追加内置注册表全量条目（model-registry.ts 的所有模型），满足「查看所有模型价格」需求。
 */
function buildPricingTable(ctx: CommandContext, all: boolean): string {
  const lines: string[] = [];
  const fmtPrice = (v?: number) => (v === undefined ? "—" : `$${v}`);

  // ── 网关采集缓存状态 ──
  const meta = getGatewayCacheMeta();
  if (meta) {
    const ageH = ((Date.now() - meta.fetchedAt) / 3_600_000).toFixed(1);
    lines.push(
      `网关定价缓存: ${meta.count} 条，采集于 ${ageH}h 前（version ${meta.version.slice(0, 8)}）`,
    );
  } else {
    lines.push("网关定价缓存: (无，执行 /model discover --pricing 采集)");
  }
  lines.push("");

  // ── availableModels 定价表 ──
  lines.push("已配置模型定价（$/1M token）:");
  lines.push("");
  if (ctx.config.availableModels.length === 0) {
    lines.push("  (未配置 availableModels)");
  } else {
    for (const m of ctx.config.availableModels) {
      const p = resolvePricing(m.name, ctx.config.availableModels, m.baseURL);
      const src = detectPricingSource(ctx, m.name, m.baseURL);
      const current = m.name === ctx.config.model ? " ✓" : "";
      lines.push(`  ${m.name}${current}`);
      lines.push(`    端点: ${m.baseURL || "(默认/官方)"}`);
      // 按次计费（quota_type=1）模型：resolvePricing 对其返回 null（token 价不适用），
      // 直接显示网关采到的按次单价，避免误示为「in $0 / out $0」。
      const perCall = getGatewayPerCall(m.name, m.baseURL);
      if (perCall !== undefined) {
        lines.push(`    按次计费 $${perCall}/次  [网关采集]`);
      } else if (p) {
        lines.push(
          `    in ${fmtPrice(p.input)}  out ${fmtPrice(p.output)}  cacheRead ${fmtPrice(p.cacheRead)}  cacheWrite ${fmtPrice(p.cacheWrite)}  [${src}]`,
        );
      } else {
        lines.push(`    (未知价格，走兜底估算 in $2 / out $10)  [${src}]`);
      }
    }
  }

  // ── 全量注册表（--all）──
  if (all) {
    lines.push("", "─────────────", "内置注册表全量定价（官方，$/1M token）:", "");
    for (const [name, entry] of getRegistryEntries()) {
      const p = entry.pricing;
      if (!p) {
        lines.push(`  ${name}: (无定价)`);
        continue;
      }
      lines.push(
        `  ${name}: in ${fmtPrice(p.input)}  out ${fmtPrice(p.output)}  cacheRead ${fmtPrice(p.cacheRead)}  cacheWrite ${fmtPrice(p.cacheWrite)}`,
      );
    }

    // 网关采集到的按次计费模型（quota_type=1，如 veo 视频类）：token 价不适用，
    // 单列展示按次单价——否则这些模型在上面按 token 的表里会被漏掉或误示为 $0。
    const perCallEntries = Object.entries(getAllGatewayEntries()).filter(
      ([, e]) => e.quotaType === 1 && typeof e.perCallUSD === "number",
    );
    if (perCallEntries.length > 0) {
      lines.push("", "─────────────", "网关按次计费模型（quota_type=1，USD/次）:", "");
      for (const [name, e] of perCallEntries) {
        lines.push(`  ${name}: $${e.perCallUSD}/次`);
      }
    }
  } else {
    lines.push("", "（加 --all 查看内置注册表全部模型价格 + 网关按次计费模型）");
  }

  return lines.join("\n");
}

export default mod;
