import type { LocalCommandModule, LocalCommandResult } from "../../types.ts";
import type { CommandContext } from "../../types.ts";

/**
 * /model 命令实现（按需加载）
 *
 * 用法:
 *   /model                   - 无可用模型列表时显示当前模型；否则打开选择对话框
 *   /model list              - 显示所有可用模型
 *   /model discover          - 自动发现模型参数（干跑）
 *   /model discover --apply  - 发现并写入 settings.json
 *   /model discover --force  - 强制覆盖已有参数
 *   /model <name>            - 切换到指定模型
 */
const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const trimmed = args.trim();

    if (trimmed === "list" || trimmed === "ls") {
      return { type: "text", value: buildAvailableModels(ctx) };
    }

    // /model discover [--apply|-a] [--force|-f]
    if (trimmed.startsWith("discover") || trimmed.startsWith("disc")) {
      const { discoverModels } = await import("./discover.ts");
      const apply = trimmed.includes("--apply") || trimmed.includes("-a");
      const force = trimmed.includes("--force") || trimmed.includes("-f");
      return discoverModels(ctx, { apply, force });
    }

    if (trimmed) {
      return switchModel(trimmed, ctx);
    }

    // 无参数且有可用模型时，打开交互式选择对话框
    if (ctx.config.availableModels.length > 0) {
      return { type: "dialog", dialog: "model" };
    }

    return { type: "text", value: buildCurrentModel(ctx) };
  },
};

function buildCurrentModel(ctx: CommandContext): string {
  const lines = [
    `当前模型: ${ctx.config.model}`,
    `提供商: ${ctx.config.provider}`,
  ];
  if (ctx.config.availableModels.length > 0) {
    lines.push("", "可用模型:");
    ctx.config.availableModels.forEach((m) => {
      const current = m.name === ctx.config.model ? " (当前)" : "";
      const provider = m.provider ? ` [${m.provider}]` : "";
      lines.push(`  - ${m.name}${provider}${current}`);
    });
    lines.push("", "使用 /model <name> 切换模型");
    lines.push("使用 /model list 查看详细信息");
  }
  return lines.join("\n");
}

function buildAvailableModels(ctx: CommandContext): string {
  if (ctx.config.availableModels.length === 0) {
    return "未配置可用模型列表\n请在 ~/.sid-code/settings.json 中添加 availableModels 配置";
  }
  const lines = ["可用模型列表:"];
  ctx.config.availableModels.forEach((m, idx) => {
    const current = m.name === ctx.config.model ? " ✓ 当前" : "";
    lines.push(`\n${idx + 1}. ${m.name}${current}`);
    if (m.provider) lines.push(`   提供商: ${m.provider}`);
    if (m.baseURL) lines.push(`   API 地址: ${m.baseURL}`);
  });
  return lines.join("\n");
}

function switchModel(modelName: string, ctx: CommandContext): LocalCommandResult {
  if (ctx.config.availableModels.length > 0) {
    const modelConfig = ctx.config.availableModels.find(
      (m) => m.name === modelName,
    );
    if (!modelConfig) {
      const available = ctx.config.availableModels
        .map((m) => `  - ${m.name}`)
        .join("\n");
      return {
        type: "text",
        value: `错误: 模型 "${modelName}" 不在可用模型列表中\n\n可用模型:\n${available}\n\n使用 /model list 查看详细信息`,
      };
    }
  }

  ctx.setModel?.(modelName);
  return { type: "text", value: `模型已切换为: ${modelName}` };
}

export default mod;
