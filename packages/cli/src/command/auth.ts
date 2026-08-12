/**
 * `auth` CLI 子命令（缺口 A-1 的可行子集 + 超越项）
 *
 * claude-code 的 `auth login/logout` 依赖其账户体系（OAuth 登录到 Anthropic 账户），
 * 本项目无该后端，故 login/logout 不适用。但**认证诊断**是纯本地能力且高价值：
 *
 *   auth status   打印当前 provider / 主模型 / API Key 来源与是否已配置 / baseURL /
 *                 是否经网关 / 各 available_models 的 key 配置情况。用于快速排查
 *                 "为什么请求 401 / 为什么没走我以为的 provider"。
 *
 * 只读，不发起真实网络请求（避免误扣费/长等待）；连通性判断基于配置推断 + 可选轻量探测。
 */

import { isMissingApiKey } from "@sid-code/core/config/config.ts";

/** 从 baseURL 粗判是否经由网关（非 api.anthropic.com / api.openai.com 等官方直连域名）。 */
function looksLikeGateway(baseURL?: string): boolean {
  if (!baseURL) return false;
  const officialHosts = [
    "api.anthropic.com",
    "api.openai.com",
    "api.deepseek.com",
    "generativelanguage.googleapis.com",
  ];
  try {
    const host = new URL(baseURL).host;
    return !officialHosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function maskKey(key?: string): string {
  if (isMissingApiKey(key)) return "(未配置)";
  const k = key!.trim();
  if (k.length <= 8) return "****";
  return `${k.slice(0, 4)}…${k.slice(-4)}（长度 ${k.length}）`;
}

async function cmdStatus(asJson: boolean): Promise<void> {
  const { loadConfig } = await import("@sid-code/core/config/config.ts");
  const config = await loadConfig({});

  const activeModel = config.availableModels.find((m) => m.name === config.model);
  // 顶层 key 按 provider 选择（config 用 anthropicKey / openaiKey 两套顶层字段，无统一 apiKey）。
  const providerKey = config.provider === "openai" ? config.openaiKey : config.anthropicKey;
  // API Key 解析优先级：模型级 > 顶层 config > env。与 provider 层解析口径保持一致的近似。
  const effectiveKey = activeModel?.apiKey || providerKey || process.env.ANTHROPIC_API_KEY;
  const effectiveBaseURL = activeModel?.baseURL || config.baseURL || undefined;
  const keySource = activeModel?.apiKey
    ? "模型级 (available_models[].apiKey)"
    : !isMissingApiKey(providerKey)
      ? `顶层 config.${config.provider === "openai" ? "openaiKey" : "anthropicKey"}`
      : process.env.ANTHROPIC_API_KEY
        ? "环境变量 ANTHROPIC_API_KEY"
        : "(无)";

  const report = {
    provider: config.provider || "(未指定)",
    model: config.model || "(未指定)",
    apiKeyConfigured: !isMissingApiKey(effectiveKey),
    apiKeyMasked: maskKey(effectiveKey),
    apiKeySource: keySource,
    baseURL: effectiveBaseURL ?? "(默认直连)",
    viaGateway: looksLikeGateway(effectiveBaseURL),
    availableModels: config.availableModels.map((m) => ({
      name: m.name,
      provider: m.provider ?? config.provider,
      apiKeyConfigured: !isMissingApiKey(m.apiKey || providerKey),
    })),
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("认证状态:\n");
  console.log(`  Provider:     ${report.provider}`);
  console.log(`  主模型:       ${report.model}`);
  console.log(
    `  API Key:      ${report.apiKeyConfigured ? "✓ 已配置" : "✗ 未配置"}  ${report.apiKeyMasked}`,
  );
  console.log(`  Key 来源:     ${report.apiKeySource}`);
  console.log(`  baseURL:      ${report.baseURL}`);
  console.log(`  经由网关:     ${report.viaGateway ? "是" : "否（直连官方域名）"}`);
  if (report.viaGateway) {
    console.log(`  ⚠ 注意:      经网关时 --betas 等直连专属头可能不透传（详见 anthropic.ts）。`);
  }
  console.log("");
  console.log(`  available_models（共 ${report.availableModels.length} 个）:`);
  for (const m of report.availableModels) {
    console.log(
      `    - ${m.name}  provider=${m.provider ?? "(继承)"}  key=${m.apiKeyConfigured ? "✓" : "✗"}`,
    );
  }
  if (!report.apiKeyConfigured) {
    console.log(
      "\n提示: API Key 未配置。可在 ~/.sid-code/settings.json 或环境变量 ANTHROPIC_API_KEY 中设置。",
    );
  }
}

export async function handleAuthCommand(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const sub = args[0];
  switch (sub) {
    case "status":
    case undefined:
      await cmdStatus(asJson);
      return;
    case "login":
    case "logout":
      console.error(
        `错误: "auth ${sub}" 不适用——本项目通过 settings.json / 环境变量配置 API Key，无账户登录体系。\n` +
          "用 `sid-code auth status` 查看当前认证配置。",
      );
      process.exit(1);
    default:
      console.error(`错误: 未知 auth 子命令 "${sub}"。可用: status`);
      process.exit(1);
  }
}
