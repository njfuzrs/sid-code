/**
 * async-decision.ts：三路竞争与 fail-closed 兜底。
 *
 * 重点覆盖「兜底判据 = 有没有路径可等，不是 isInteractive」：
 * 旧判据下，调用方传了 isInteractive=true 却没接 userDecision 时，
 * 三路全空也只能等满 300s 超时；而唯一调用方又写死 isInteractive=true，
 * 于是那个分支成了永远不可达的死代码（A10）。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePermission } from "../../src/permission/async-decision.ts";

// 日志落盘隔离：resolvePermission 会 getLogger()，不能写真实 ~/.sid-code。
// bunfig 的 preload 有兜底，这里显式设置并恢复（同批多文件共进程，不能无条件 delete）。
const ORIGINAL_SID_CONFIG_DIR = process.env.SID_CONFIG_DIR;
process.env.SID_CONFIG_DIR = mkdtempSync(join(tmpdir(), "sid-async-decision-"));
afterAll(() => {
  if (ORIGINAL_SID_CONFIG_DIR === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = ORIGINAL_SID_CONFIG_DIR;
});

const req = { toolName: "bash", input: { command: "echo hi" }, description: "测试用请求" };

describe("resolvePermission · fail-closed 兜底", () => {
  test("三路全空 → 立即拒绝（source=auto），不白等超时", async () => {
    const started = Date.now();
    const result = await resolvePermission(req, {
      isInteractive: false,
      isSubAgent: false,
      timeoutMs: 500,
    });
    expect(result.source).toBe("auto");
    expect(result.decision.allowed).toBe(false);
    // 兜底是同步 finish，远早于 500ms 超时；留余量避免慢 runner 抖动
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("交互态但没接 userDecision → 同样立即拒绝（判据不是 isInteractive）", async () => {
    const started = Date.now();
    const result = await resolvePermission(req, {
      isInteractive: true,
      isSubAgent: false,
      timeoutMs: 500,
    });
    expect(result.source).toBe("auto");
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("子代理不启动 user 路径 → 无 hook/classifier 时立即拒绝", async () => {
    const result = await resolvePermission(req, {
      isInteractive: true,
      isSubAgent: true,
      timeoutMs: 500,
      userDecision: (_req, resolve) => resolve.resolve({ allowed: true, reason: "不该被采纳" }),
    });
    expect(result.source).toBe("auto");
    expect(result.decision.allowed).toBe(false);
  });
});

describe("resolvePermission · 三路竞争", () => {
  test("hook 先返回 → source=hook", async () => {
    const result = await resolvePermission(req, {
      isInteractive: true,
      isSubAgent: false,
      timeoutMs: 500,
      hookDecision: async () => ({ allowed: true, reason: "hook 放行" }),
      // 故意不 resolve：模拟用户还没点，hook 先赢
      userDecision: () => {},
    });
    expect(result.source).toBe("hook");
    expect(result.decision.allowed).toBe(true);
  });

  test("classifier 先返回 → source=classifier", async () => {
    const result = await resolvePermission(req, {
      isInteractive: true,
      isSubAgent: false,
      timeoutMs: 500,
      classifierDecision: async () => ({ allowed: true, reason: "分类器判定安全" }),
      userDecision: () => {},
    });
    expect(result.source).toBe("classifier");
    expect(result.decision.allowed).toBe(true);
  });

  test("用户路径在 grace 之后 resolve → source=user，alwaysAllow 透传", async () => {
    const result = await resolvePermission(req, {
      isInteractive: true,
      isSubAgent: false,
      gracePeriodMs: 10,
      timeoutMs: 500,
      userDecision: (_req, resolve) => {
        setTimeout(() => resolve.resolve({ allowed: true, reason: "用户批准" }, true), 30);
      },
    });
    expect(result.source).toBe("user");
    expect(result.alwaysAllow).toBe(true);
  });

  test("用户在 grace 内 resolve，hook 宽限期内先返回 → hook 赢（suppress 生效）", async () => {
    const result = await resolvePermission(req, {
      isInteractive: true,
      isSubAgent: false,
      gracePeriodMs: 50,
      timeoutMs: 500,
      hookDecision: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { allowed: false, reason: "hook 拒绝" };
      },
      userDecision: (_req, resolve) => resolve.resolve({ allowed: true, reason: "用户秒批" }),
    });
    expect(result.source).toBe("hook");
    expect(result.decision.allowed).toBe(false);
  });

  test("hook 存在但不干预 → 等超时（文档化：hook 存在即视为有路径可等）", async () => {
    const result = await resolvePermission(req, {
      isInteractive: false,
      isSubAgent: false,
      timeoutMs: 30,
      hookDecision: async () => null,
    });
    expect(result.source).toBe("timeout");
    expect(result.decision.allowed).toBe(false);
  });
});
