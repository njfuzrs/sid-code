/**
 * A12 会话远程接管：桩中继经 `--bridge` 发来消息，工具确认由远端批准，批准真的生效并留痕。
 *
 * 期望来源：触发清单 A12 的判据（`BridgeInbound` / `BridgePermission` /
 * `PermissionDecision.confirm_via=bridge`）。触发清单里该条依赖企业后端、**尚未人工实测**，
 * 事件形态取自 2026-11-08 构建产物 + 桩 WS 中继探针，台账已注明。
 * 该探针同时发现 `confirm_via` 从未落盘（collector 漏映射），已由 #668 修复。
 *
 * 判据选 allow 方向：deny 方向区分不了「远端拒绝」与「bridge 代理没接上、无头档位自动拒绝」，
 * 两者文件都还在；只有远端批准才能让 default 档下的 `rm` 真的执行。
 * 必须走真实权限（`realPermissions`）：跳过权限时根本不会发 permission_request。
 */
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "A12-bridge",
  ledger: "A12",
  feature: "会话远程接管",
  kind: "guard",
  realPermissions: true,
  repo: { "trash.txt": "remote approval required\n" },
  argv: [],
  bridge: { messages: ["删掉 trash.txt"], permission: "allow" },
  expect: {
    events: [
      { event: "BridgeInbound", where: { kind: "user_message" }, count: 1 },
      { event: "BridgeInbound", where: { kind: "permission_response" }, count: 1 },
      { event: "BridgePermission", where: { tool_name: "bash", decision: "allow" }, count: 1 },
      {
        event: "PermissionDecision",
        where: { tool_name: "bash", outcome: "allow", source: "user", confirm_via: "bridge" },
        count: 1,
      },
      { event: "PostToolUse", where: { tool_name: "bash", is_error: false }, count: 1 },
    ],
    files: [{ path: "trash.txt", absent: true }],
    output: ({ bridgeFrames }) => {
      const req = bridgeFrames.filter((f) => f.type === "permission_request");
      if (req.length !== 1) return `permission_request 期望 1 帧，实际 ${req.length} 帧`;
      if ((req[0]!.data as { toolName?: string })?.toolName !== "bash")
        return `permission_request 的 toolName 不是 bash：${JSON.stringify(req[0]!.data)}`;
      return null;
    },
  },
  mutations: [
    {
      file: "packages/cli/src/app.ts",
      find: "            checker?.setBridgePermissionDelegate?.(delegate);",
      replace: "            void delegate;",
      why: "bridge 权限代理没注入 checker：确认走无头档位自动拒绝，远端永远收不到 permission_request",
    },
    {
      file: "packages/core/src/bridge/permission-proxy.ts",
      find: "    const allowed = (message.data as { allowed?: boolean })?.allowed ?? false;",
      replace: "    const allowed = false;",
      why: "远端批准被读成拒绝：permission_response 送达了但 allowed 不认",
    },
    {
      file: "packages/core/src/trace/collector.ts",
      find: "      ...(e.confirmVia ? { confirm_via: e.confirmVia } : {}),",
      replace: "",
      why: "#668 修复前的形态：confirm_via 不落盘，远程批准与本地批准在轨迹里同名",
    },
  ],
};

export default def;
