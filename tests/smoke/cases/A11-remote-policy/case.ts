/**
 * A11 下发策略：本地桩后端下发 `permissions.deny: ["Bash(rm *)"]`，真二进制启动时拉取、写缓存、
 * 注入 policySettings 规则源，回放的 `rm` 被规则拒绝。
 *
 * ⚠ 期望来源与其他用例不同：触发清单 A11 **尚未人工实测通过**（依赖企业后端）。这里的期望取自
 * 2026-11-07 用桩后端跑真二进制的探针，并回源码核对过语义（`config/policy.ts` RemotePolicyLoader、
 * `permission/rule-loader.ts` setPolicyRules）。等 A11 人工实测完成，要回来对一遍期望。
 *
 * 构造：
 * - 桩服务 `backend` 由运行器起在 127.0.0.1 随机端口；`backend.url` 写进用户级 settings
 *   （明文 http 只放行 loopback，`identity/backend-url.ts`）；
 * - 预置 `device-credential.json`：无凭据时 RemotePolicyLoader 直接跳过、零请求；
 * - 预算接口返回 204（无远程预算），本用例只守策略这一半。
 *
 * 跑的是 `--dangerously-skip-permissions`（运行器默认）：deny 规则在这个模式下仍然生效
 * （`step=skip-deny-rule`），这正是企业策略要守的——用户自己跳过权限也绕不开管理员的 deny。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SmokeCase } from "../../lib/types.ts";

const DENY = "Bash(rm *)";

const def: SmokeCase = {
  id: "A11-remote-policy",
  ledger: "A11",
  feature: "下发策略 / 预算",
  kind: "guard",
  repo: { "trash.txt": "keep me\n" },
  config: { "device-credential.json": JSON.stringify({ credential: "smoke-device-token" }) },
  services: {
    backend: {
      handler: (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/api/v1/ctl/policy") {
          return Response.json(
            { source: "remote", permissions: { deny: [DENY] } },
            { headers: { ETag: '"smoke-p1"' } },
          );
        }
        return new Response(null, { status: 204 });
      },
    },
  },
  settings: ({ defaults, services }) => ({ ...defaults, backend: { url: services.backend } }),
  argv: ["-p", "删掉 trash.txt"],
  expect: {
    events: [
      {
        event: "PermissionDecision",
        where: { tool_name: "bash", outcome: "deny", source: "rule", step: "skip-deny-rule" },
        count: 1,
      },
    ],
    files: [{ path: "trash.txt", equals: "keep me\n" }],
    output: ({ services, configDir }) => {
      const hits = services.backend ?? [];
      const policy = hits.filter((h) => h.method === "GET" && h.path === "/api/v1/ctl/policy");
      if (policy.length !== 1) return `策略接口期望请求 1 次，实际 ${JSON.stringify(hits)}`;
      if (!policy[0].auth) return "策略请求没带 Authorization（设备凭据没接上）";
      const cache = JSON.parse(readFileSync(join(configDir, "policy-cache.json"), "utf8"));
      if (cache.last_status !== 200)
        return `policy-cache.last_status 期望 200，实际 ${cache.last_status}`;
      if (cache.etag !== '"smoke-p1"')
        return `policy-cache.etag 期望 "smoke-p1"，实际 ${cache.etag}`;
      const deny = cache.settings?.permissions?.deny;
      if (JSON.stringify(deny) !== JSON.stringify([DENY])) {
        return `policy-cache 里的 deny 期望 ${JSON.stringify([DENY])}，实际 ${JSON.stringify(deny)}`;
      }
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/config/policy.ts",
      find: '    const endpoint = resolveEndpoint("policy")?.url;\n    if (!endpoint) return null;\n\n    let cache = readPolicyCache();',
      replace:
        '    const endpoint = resolveEndpoint("policy")?.url;\n    if (endpoint || !endpoint) return null;\n\n    let cache = readPolicyCache();',
      why: "启动时不再拉远程策略（配了 backend.url 也零请求），管理员下发的 deny 不生效",
    },
    {
      file: "packages/core/src/permission/rule-loader.ts",
      find: '    const rules = this.parsePermissions(perms, "policySettings");\n    this.sources.set("policySettings", rules);\n    this.invalidateCache();\n  }',
      replace: "    void perms;\n    this.invalidateCache();\n  }",
      why: "策略拉到了、缓存也写了，但规则没注入 policySettings 源（「下发成功、执行不认」）",
    },
  ],
};

export default def;
