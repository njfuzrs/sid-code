/**
 * `auth` CLI 子命令
 *
 *   auth login    P2：用飞书身份登录企业后端（backend.url），一次完成认证 + 设备注册，
 *                 凭据落 ~/.sid-code/device-credential.json。顶层 `sid-code login` 是别名。
 *   auth logout   通知后端解绑本设备（尽力而为），删本地凭据。
 *   auth status   三段：① 企业登录态（谁登录的、凭据是否过期、后端地址）；
 *                 ② 企业通道（策略 / 预算 / 账本 / 事件 / flag / 轨迹逐条：地址、来源、本地状态）；
 *                 ③ 模型 API Key 诊断（provider / 主模型 / Key 来源 / baseURL / 是否经网关）。
 *                 默认不发网络请求；加 --verify 才调 /ctl/whoami 确认服务端没吊销，
 *                 并对每条企业通道发一次**不写数据**的探测（判据见 identity/backend-channels.ts）。
 *
 * 登录的是 sid-code 自己的企业后端，不是模型厂商账户——模型 Key 仍走 settings.json / 环境变量。
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

// 登录状态的采集与渲染在 core（identity/login-status.ts），TUI 的 /whoami、/status 共用同一份
async function loadLoginStatusModule() {
  return import("@sid-code/core/identity/login-status.ts");
}

async function cmdLogin(asJson: boolean): Promise<void> {
  const { resolveBackendUrl } = await import("@sid-code/core/identity/backend-url.ts");
  const backend = resolveBackendUrl();
  if (!backend) {
    const { NO_BACKEND_HINT } = await loadLoginStatusModule();
    console.error(`错误: ${NO_BACKEND_HINT}`);
    process.exit(1);
  }
  const { performCliLogin, CliLoginError } = await import("@sid-code/core/identity/cli-login.ts");
  const { getRawVersion } = await import("@sid-code/shared/version.ts");

  // Ctrl+C 时让回调服务器干净退出，而不是留着端口
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once("SIGINT", onSigint);
  try {
    const result = await performCliLogin(backend.url, {
      version: getRawVersion(),
      signal: ac.signal,
      onAuthorizeUrl: (url) => {
        if (asJson) return;
        console.log("正在打开浏览器完成飞书授权。若没有自动打开，请手动访问：\n");
        console.log(`  ${url}\n`);
        console.log("等待授权（5 分钟内有效，Ctrl+C 取消）…");
      },
    });
    if (asJson) {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }
    const who = result.user?.name ?? result.user?.unionId ?? result.user?.id ?? "(未返回用户信息)";
    console.log(`\n✓ 已登录：${who}`);
    if (result.expiresAt) console.log(`  凭据有效期至 ${result.expiresAt}`);
  } catch (err) {
    const reason = err instanceof CliLoginError ? err.reason : "unknown";
    if (asJson) {
      console.log(JSON.stringify({ ok: false, reason, error: (err as Error).message }, null, 2));
    } else {
      console.error(`\n✗ 登录失败：${(err as Error).message}`);
    }
    process.exit(1);
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

async function cmdLogout(asJson: boolean): Promise<void> {
  const { resolveBackendUrl } = await import("@sid-code/core/identity/backend-url.ts");
  const { performCliLogout } = await import("@sid-code/core/identity/cli-login.ts");
  const result = await performCliLogout(resolveBackendUrl()?.url ?? null);
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.hadCredential) {
    console.log("本机没有登录凭据，无需登出。");
    return;
  }
  console.log("✓ 已删除本地登录凭据。");
  if (result.remote === "unsupported") {
    console.log("  后端不支持解绑接口：设备与用户的绑定仍在，换人登录前请联系管理员解绑。");
  } else if (result.remote === "failed") {
    console.log(
      `  通知后端解绑失败（${result.remoteDetail}）：换人登录若提示设备已绑定，请联系管理员。`,
    );
  } else if (result.remote === "skipped") {
    // 有凭据却没调后端，只可能是没配 backend.url
    console.log("  未配置后端地址，未通知服务端解绑：换人登录若提示设备已绑定，请联系管理员。");
  }
}

async function cmdStatus(asJson: boolean, verify: boolean): Promise<void> {
  const { collectLoginStatus, renderLoginStatus } = await loadLoginStatusModule();
  const login = await collectLoginStatus({ verify });
  const { loadConfig } = await import("@sid-code/core/config/config.ts");
  const config = await loadConfig({});
  const { collectBackendChannels, renderBackendChannels } =
    await import("@sid-code/core/identity/backend-channels.ts");
  // 逐条列出企业通道：以前这里只有「✓ 凭据有效」，用户据此以为全通了（U4）
  const channels = await collectBackendChannels({
    probe: verify,
    traceUpload: config.trace?.upload ?? null,
    featureFlagEndpoint: config.analytics?.featureFlagEndpoint,
  });

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
    // 模型诊断字段保持在顶层（向后兼容既有脚本），登录态挂在 login 下
    console.log(JSON.stringify({ ...report, login, channels }, null, 2));
    return;
  }

  for (const line of renderLoginStatus(login)) console.log(line);
  for (const line of renderBackendChannels(channels)) console.log(line);
  console.log("");
  console.log("模型认证:\n");
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
  const sub = args.find((a) => !a.startsWith("--"));
  switch (sub) {
    case "status":
    case undefined:
      await cmdStatus(asJson, args.includes("--verify"));
      return;
    case "login":
      await cmdLogin(asJson);
      return;
    case "logout":
      await cmdLogout(asJson);
      return;
    default:
      console.error(`错误: 未知 auth 子命令 "${sub}"。可用: login / logout / status`);
      process.exit(1);
  }
}
