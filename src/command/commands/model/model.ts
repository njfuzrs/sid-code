import type { LocalCommandModule, LocalCommandResult } from "../../types.ts";
import type { CommandContext } from "../../types.ts";

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
 *   /model sub <type> <name> [-p]   - 切换子代理模型（type: default/explore/task/plan/summarize/verify）
 *   /model sub clear <type> [-p]    - 清除某类型子代理映射（回退 default/主模型）
 *
 * 持久化语义与 /effort 对齐：默认仅当会话生效，加 -p（别名 --persist / save）才写盘。
 */

/** 合法的子代理类型键（default 是 subAgentModels 的兜底键）。 */
const SUBAGENT_TYPES = ["default", "explore", "task", "plan", "summarize", "verify"] as const;

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

    if (trimmed === "help" || trimmed === "-h" || trimmed === "--help") {
      return { type: "text", value: buildHelp() };
    }

    // /model discover [--apply|-a] [--force|-f]
    if (trimmed.startsWith("discover") || trimmed.startsWith("disc")) {
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
        return { type: "text", value: `错误: 缺少模型名\n用法: /model <name> [-p]\n\n${buildHelp()}` };
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

  ctx.setFallbackModel?.(modelName, persist);
  return {
    type: "text",
    value: `fallback 模型已切换为: ${modelName}${persist ? "，并已保存到 settings.json" : "（仅当前会话，加 -p 可持久化）"}${providerNote}`,
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
      return { type: "text", value: `错误: 缺少子代理类型\n用法: /model sub clear <type>\n合法类型: ${SUBAGENT_TYPES.join(" / ")}` };
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
  return (SUBAGENT_TYPES as readonly string[]).includes(type);
}

function buildInvalidTypeError(type: string): string {
  return `错误: 无效的子代理类型 "${type}"\n合法类型: ${SUBAGENT_TYPES.join(" / ")}\n\n说明:\n  · default —— 兜底，所有未单独指定的子代理类型都用它\n  · explore/task/plan/summarize/verify —— 按职责单独指定`;
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
    for (const type of SUBAGENT_TYPES) {
      if (sub[type]) lines.push(`   ${type} → ${sub[type]}`);
    }
  } else {
    lines.push("   (未设置，全部跟随主模型)");
  }
  lines.push("");
  lines.push("用法:");
  lines.push(`  /model sub <type> <name> [-p]   切换（type: ${SUBAGENT_TYPES.join(" / ")}）`);
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
    "  /model <name> [-p]              切换主模型（-p 持久化到 settings.json）",
    "  /model fallback <name> [-p]     切换 fallback 降级模型",
    "  /model fallback clear [-p]      清除 fallback",
    `  /model sub <type> <name> [-p]   切换子代理模型（type: ${SUBAGENT_TYPES.join(" / ")}）`,
    "  /model sub clear <type> [-p]    清除某类型子代理映射",
    "  /model discover [--apply]       自动发现模型参数",
    "",
    "持久化：默认仅当会话生效；加 -p（别名 --persist / save）才写入 settings.json 跨会话保留。",
  ].join("\n");
}

export default mod;
