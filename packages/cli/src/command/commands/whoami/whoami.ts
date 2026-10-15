import type { LocalCommandModule, LocalCommandResult } from "../../types.ts";

/**
 * /whoami 实现（按需加载）。采集与渲染复用 core 的 identity/login-status.ts，
 * 与 `sid-code auth status` 的登录段同一份文案。
 *
 * 默认不发网络请求；`--verify` 调 /ctl/whoami 核验服务端是否仍认这份凭据。
 * 企业通道明细与模型 Key 诊断不在这里，留给 `sid-code auth status`。
 */
const mod: LocalCommandModule = {
  async call(args: string): Promise<LocalCommandResult> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const unknown = tokens.filter((t) => t !== "--verify");
    if (unknown.length > 0) {
      return { type: "text", value: `未知参数「${unknown.join(" ")}」。用法: /whoami [--verify]` };
    }
    const { collectLoginStatus, renderLoginStatus } =
      await import("@sid-code/core/identity/login-status.ts");
    const st = await collectLoginStatus({ verify: tokens.includes("--verify") });
    const lines = renderLoginStatus(st, { loginHint: "/login", verifyHint: "/whoami --verify" });
    lines.push("企业通道逐条状态与模型 Key 诊断：在终端执行 sid-code auth status [--verify]");
    return { type: "text", value: lines.join("\n") };
  },
};

export default mod;
