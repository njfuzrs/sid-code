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

describe("send_message resume 路径（P1-1 注入 + 工作区回归，行为级）", () => {
  // 行为级而不是源码字面量：字面量断言挡不住「注入写在 execute 之后」这类顺序错误。
  // patch 的 execute 在被调用的那一刻读取 checker，读到的就是执行时真正生效的那份。
  let capturedTask: { cwd?: string } | null = null;
  let checkerAtExecute: unknown = undefined;
  let executed: Promise<void>;
  let markExecuted: () => void;

  function patchExecuteForResume(): void {
    executed = new Promise((r) => (markExecuted = r));
    SubAgent.prototype.execute = async function (
      this: SubAgent,
      task: { cwd?: string },
    ): Promise<SubAgentResult> {
      capturedTask = task;
      checkerAtExecute = this.getPermissionChecker();
      markExecuted();
      return {
        success: true,
        output: "ok",
        toolUseCount: 0,
        usage: { inputTokens: 1, outputTokens: 2 },
      } as unknown as SubAgentResult;
    };
  }

  /** 造一个已终态的后台 agent task（resume 的前提） */
  async function makeTerminalAgentTask(cwd?: string): Promise<string> {
    const { createAgentTask, updateTask } = await import("@sid-code/core/task/index.ts");
    const { taskState } = createAgentTask({
      agentType: "general-purpose",
      prompt: "p",
      description: "d",
    });
    updateTask(
      taskState.id,
      (t) => ({ ...t, status: "completed", ...(cwd ? { cwd } : {}) }) as typeof t,
    );
    return taskState.id;
  }

  afterEach(() => {
    capturedTask = null;
    checkerAtExecute = undefined;
  });

  test("resume 执行时子代理已持有注入的 checker（注入在 execute 之前）", async () => {
    patchExecuteForResume();
    const { SendMessageTool } = await import("@sid-code/core/tool/send-message.ts");
    const tool = new SendMessageTool(fakeRegistry, {} as any);
    tool.setPermissionChecker(fakeChecker);
    const id = await makeTerminalAgentTask();

    const res = await tool.execute({ to: id, message: "继续" });
    expect(res.isError).toBeFalsy();
    await executed;
    expect(checkerAtExecute).toBe(fakeChecker);
    expect(capturedTask!.cwd).toBeUndefined();
  });

  test("原 agent 跑在隔离工作区 → 续跑回到同一目录，checker 按该目录派生", async () => {
    patchExecuteForResume();
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const wt = mkdtempSync(join(tmpdir(), "sid-resume-wt-"));
    try {
      const derivedChecker = { mark: "derived-for-worktree" };
      // 显式断言类型：闭包里赋值，TS 控制流分析会把 `let x: T | null = null` 收窄成 null
      let derivedFor = null as string | null;
      const deriving = {
        deriveForWorkspace: async (dir: string) => {
          derivedFor = dir;
          return derivedChecker;
        },
      } as any;
      const { SendMessageTool } = await import("@sid-code/core/tool/send-message.ts");
      const tool = new SendMessageTool(fakeRegistry, {} as any);
      tool.setPermissionChecker(deriving);
      const id = await makeTerminalAgentTask(wt);

      const res = await tool.execute({ to: id, message: "继续" });
      expect(res.isError).toBeFalsy();
      await executed;
      expect(capturedTask!.cwd).toBe(wt);
      expect(derivedFor).toBe(wt);
      expect(checkerAtExecute).toBe(derivedChecker);
      // 续跑后的新 task 也记下工作区（再次 send_message 仍回到这里）
      const { getTask } = await import("@sid-code/core/task/index.ts");
      const newId = JSON.parse(res.output).new_task_id as string;
      expect(newId).toBeTruthy();
      expect((getTask(newId) as { cwd?: string }).cwd).toBe(wt);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("原工作区已被清理 → 拒绝续跑，不降级到主工作区", async () => {
    patchExecuteForResume();
    const { SendMessageTool } = await import("@sid-code/core/tool/send-message.ts");
    const tool = new SendMessageTool(fakeRegistry, {} as any);
    tool.setPermissionChecker(fakeChecker);
    const id = await makeTerminalAgentTask("/nonexistent/sid-resume-wt-gone");

    const res = await tool.execute({ to: id, message: "继续" });
    expect(JSON.parse(res.output).status).toBe("cannot_resume");
    expect(capturedTask).toBeNull();
  });
});

describe("SubAgent.execute 记录工作区到 task 状态（send_message 续跑的前提）", () => {
  const proto = SubAgent.prototype as unknown as { executeInner: (...a: unknown[]) => unknown };
  const origInner = proto.executeInner;
  afterEach(() => {
    proto.executeInner = origInner;
  });

  test("显式 cwd → LocalAgentTaskState.cwd 被记下；不传 cwd 则不记", async () => {
    // 只替换执行体，保留 execute() 本身的 task 注册与 cwd 记录逻辑
    proto.executeInner = async () =>
      ({
        success: true,
        output: "ok",
        toolUseCount: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      }) as unknown;
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { getAllTasks } = await import("@sid-code/core/task/index.ts");
    const wt = mkdtempSync(join(tmpdir(), "sid-record-cwd-"));
    try {
      const before = new Set(getAllTasks().map((t) => t.id));
      const sub = SubAgent.fromRegistry(fakeRegistry, {} as any);
      await sub.execute({ type: "general-purpose", description: "d", prompt: "p", cwd: wt } as any);
      await sub.execute({ type: "general-purpose", description: "d2", prompt: "p" } as any);
      const created = getAllTasks().filter((t) => !before.has(t.id)) as {
        description: string;
        cwd?: string;
      }[];
      expect(created.find((t) => t.description === "d")?.cwd).toBe(wt);
      expect(created.find((t) => t.description === "d2")?.cwd).toBeUndefined();
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
