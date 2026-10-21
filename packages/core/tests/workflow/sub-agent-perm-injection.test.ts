/**
 * workflow 子代理权限检查器注入测试（P0-1 回归）
 *
 * 修复前：SubAgentRunner 从不调 setPermissionChecker，workflow 内全量子代理拿不到
 * 权限检查器，写类工具被 B0 分级 fail-closed 全拒（isolation=worktree 因此是死能力）。
 * 实测轨迹 20261021-164810-ddb4860b：verify 子代理自述「权限拒绝: 未配置权限检查器」。
 *
 * 测试手法：patch SubAgent.prototype.execute 捕获 run() 实际构造的 SubAgent 实例
 * （不真跑子代理循环），断言 getPermissionChecker() 返回注入的 checker。
 * 这是对注入链路的直接断言——比源码字面量断言强（防止改成别的写法后字面量还在）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import type { SubAgentResult } from "@sid-code/core/agent/sub-agent.ts";
import { SubAgentRunner } from "@sid-code/core/workflow/sub-agent-runner.ts";
import type { AgentCallContext } from "@sid-code/core/workflow/runtime.ts";

/** 最小假 registry：fromRegistry 只需要这三个方法 */
const fakeRegistry = {
  getProvider: () => ({}),
  getCurrentModel: () => "test-model",
  getLanguage: () => "zh",
} as any;

const fakeChecker = { mark: "sub-agent-perm-injection-test" } as any;

/** patch 前的原方法（afterEach 恢复，防污染同批其它测试） */
const origExecute = SubAgent.prototype.execute;
let captured: SubAgent | null = null;

/** 经传参捕获实例（直接 `captured = this` 会触发 oxlint no-this-alias） */
function captureInstance(agent: SubAgent): void {
  captured = agent;
}

function patchExecute(): void {
  SubAgent.prototype.execute = async function (this: SubAgent): Promise<SubAgentResult> {
    captureInstance(this);
    return {
      success: true,
      output: "ok",
      toolUseCount: 0,
      usage: { inputTokens: 1, outputTokens: 2 },
    } as unknown as SubAgentResult;
  };
}

afterEach(() => {
  SubAgent.prototype.execute = origExecute;
  captured = null;
});

describe("SubAgentRunner 权限检查器注入（P0-1）", () => {
  test("构造选项带 permissionChecker → 子代理实例拿到同一 checker", async () => {
    patchExecute();
    const runner = new SubAgentRunner({
      providerRegistry: fakeRegistry,
      toolRegistry: {} as any,
      runId: "perm-test",
      permissionChecker: fakeChecker,
    });
    const ctx: AgentCallContext = {
      callIndex: 0,
      label: "t",
      signal: new AbortController().signal,
    };
    await runner.run("prompt", undefined, ctx);

    expect(captured).not.toBeNull();
    // 核心断言：注入链路打通（修复前这里是 null → B0 fail-closed 全拒写类）
    expect(captured!.getPermissionChecker()).toBe(fakeChecker);
  });

  test("构造选项不带 permissionChecker → 子代理 checker 为 null（B0 兜底语义，headless/测试调用方不变）", async () => {
    patchExecute();
    const runner = new SubAgentRunner({
      providerRegistry: fakeRegistry,
      toolRegistry: {} as any,
      runId: "perm-test",
    });
    const ctx: AgentCallContext = {
      callIndex: 0,
      label: "t",
      signal: new AbortController().signal,
    };
    await runner.run("prompt", undefined, ctx);

    expect(captured).not.toBeNull();
    expect(captured!.getPermissionChecker()).toBeNull();
  });
});

describe("send_message resume 路径注入（P1-1，源码锚定）", () => {
  test("resume 分支在 fromRegistry 之后注入 checker", async () => {
    // resume 路径依赖 task 注册表状态（terminated agent task），行为级测试装配成本高；
    // 此处锚定源码结构：fromRegistry 之后、execute 之前必须有 setPermissionChecker 注入。
    // M-1 审计测试（needs-permission-checker-audit.test.ts）已保证 setter 实现存在。
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "tool", "send-message.ts"),
      "utf8",
    );
    expect(src).toContain("subAgent.setPermissionChecker(this.permissionChecker)");
  });
});
