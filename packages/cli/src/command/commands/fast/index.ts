import type { UnifiedCommand } from "../../types.ts";

/**
 * /fast 命令定义（轻量，启动时加载）。对齐 claude-code §4.3。
 *
 * 切换 Fast Mode（偏好更快的输出端点/服务档位）。当前公司网关未提供对等 fast 能力，
 * 故此命令切换的是「预留开关」config.fastMode（已透传 fallback 层），待网关支持后即生效。
 * 遵守 feedback-no-hardcoded-model-tier-rules——不写死模型名单，靠配置开关 + 未来能力探测。
 * 实现在 ./fast.ts。
 */
const fast: UnifiedCommand = {
  type: "local",
  name: "fast",
  aliases: [],
  description: "切换 Fast Mode 偏好（网关对等能力就绪前为预留开关）",
  argumentHint: "[on|off]",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./fast.ts").then((m) => m.default),
};

export default fast;
