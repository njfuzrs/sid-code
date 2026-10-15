import type { LocalCommandModule, LocalCommandResult } from "../../types.ts";

/**
 * /logout 实现（按需加载）。复用 core 的 performCliLogout：先通知后端解绑本设备，再删本地凭据。
 * 结果文案与 `sid-code logout` 一致。
 *
 * 登出**不会**解除本会话已生效的企业策略：远程策略是企业管控，登出不应成为绕过它的办法
 * （登录闭环方案 §5.6）。
 */
async function doLogout(): Promise<LocalCommandResult> {
  const { resolveBackendUrl } = await import("@sid-code/core/identity/backend-url.ts");
  const { performCliLogout } = await import("@sid-code/core/identity/cli-login.ts");
  const result = await performCliLogout(resolveBackendUrl()?.url ?? null);
  if (!result.hadCredential) return { type: "text", value: "本机没有登录凭据，无需登出。" };
  const lines = ["✓ 已删除本地登录凭据。"];
  if (result.remote === "ok") {
    lines.push("  已通知后端解绑本设备。");
  } else if (result.remote === "unsupported") {
    lines.push("  后端不支持解绑接口：设备与用户的绑定仍在，换人登录前请联系管理员解绑。");
  } else if (result.remote === "failed") {
    lines.push(
      `  通知后端解绑失败（${result.remoteDetail}）：换人登录若提示设备已绑定，请联系管理员。`,
    );
  } else {
    // 有凭据却没调后端，只可能是没配 backend.url
    lines.push("  未配置后端地址，未通知服务端解绑：换人登录若提示设备已绑定，请联系管理员。");
  }
  lines.push("  本会话已生效的企业策略不会因登出解除。");
  return { type: "text", value: lines.join("\n") };
}

const mod: LocalCommandModule = {
  async call(): Promise<LocalCommandResult> {
    const { getDeviceCredential } = await import("@sid-code/core/identity/credential.ts");
    const cred = getDeviceCredential();
    if (!cred) return { type: "text", value: "本机没有登录凭据，无需登出。" };
    const who = cred.user?.name ?? cred.user?.unionId ?? cred.user?.id ?? "(设备凭据未绑定到人)";
    return {
      type: "confirm",
      message: `将以 ${who} 的身份登出，并通知后端解绑本设备。继续？`,
      onConfirm: doLogout,
    };
  },
};

export default mod;
