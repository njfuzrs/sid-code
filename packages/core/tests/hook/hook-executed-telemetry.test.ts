/**
 * 观测缺口 PR1 · T1：hook 执行进轨迹（HookExecuted / HookAsyncCompleted）
 *
 * 这个模块的核心承诺是「**所有** hook 执行路径都记，一条不漏」——所以本文件的断言按
 * 源码里的四条路径逐条覆盖：并行 / 串行 / SessionEnd 预算串行 / 隔离 HookSystem。
 * 埋点只挂在 `HookRunner.executeHook` 一个咽喉上，任何一条路径没覆盖到，都是那一类
 * 事件在轨迹里永远缺一行。
 *
 * 另两条硬约束在这里锁死：
 *   1. runtime hook 不记（它是轨迹自己，记了会形成「记录 hook 的 hook」）；
 *   2. 命令原文 / stdout / stderr 不进事件（events.jsonl 会被上传，命令里可能拼着 token）。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HookRunner } from "@sid-code/core/hook/runner.ts";
import { AsyncHookRegistry } from "@sid-code/core/hook/async-registry.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { buildAgentHookSystem } from "@sid-code/core/agent/agent-hooks.ts";
import {
  setHookTraceSink,
  HOOK_EXECUTED_EVENT_NAME,
  HOOK_ASYNC_COMPLETED_EVENT_NAME,
} from "@sid-code/core/hook/hook-telemetry.ts";
import {
  ConfigSource,
  HookEventName,
  type CommandHookConfig,
  type HookInput,
} from "@sid-code/core/hook/types.ts";

type Captured = { event: string; data: Record<string, unknown> };

let captured: Captured[] = [];
let testHome: string;
/** 存/恢复原值：bun test 同进程跑多文件，delete 会把 preload 的兜底一起抹掉 */
const prevConfigDir = process.env.SID_CONFIG_DIR;

beforeEach(() => {
  captured = [];
  setHookTraceSink((event, data) => captured.push({ event, data }));
  testHome = mkdtempSync(join(tmpdir(), "sid-hook-telemetry-"));
  process.env.SID_CONFIG_DIR = testHome;
});

afterEach(() => {
  setHookTraceSink(null);
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(testHome, { recursive: true, force: true });
});

function baseInput(): HookInput {
  return {
    session_id: "test",
    cwd: process.cwd(),
    hook_event_name: HookEventName.PostToolUse,
    timestamp: new Date().toISOString(),
  };
}

const executed = () => captured.filter((c) => c.event === HOOK_EXECUTED_EVENT_NAME);
const completed = () => captured.filter((c) => c.event === HOOK_ASYNC_COMPLETED_EVENT_NAME);

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const echoHook = (over: Partial<CommandHookConfig> = {}): CommandHookConfig => ({
  type: "command",
  name: "echo-hook",
  command: "echo ok",
  ...over,
});

describe("T1 三条执行路径各记一条", () => {
  it("并行路径（executeHooksParallel）", async () => {
    const runner = new HookRunner();
    await runner.executeHooksParallel([echoHook()], HookEventName.PostToolUse, baseInput());

    expect(executed()).toHaveLength(1);
    const d = executed()[0].data;
    expect(d.event_name).toBe(HookEventName.PostToolUse);
    expect(d.hook_type).toBe("command");
    expect(d.hook_id).toBe("echo-hook");
    expect(d.outcome).toBe("success");
    expect(typeof d.run_id).toBe("string");
    expect(typeof d.duration_ms).toBe("number");
  });

  it("串行路径（executeHooksSequential）", async () => {
    const runner = new HookRunner();
    await runner.executeHooksSequential([echoHook()], HookEventName.PostToolUse, baseInput());
    expect(executed()).toHaveLength(1);
  });

  it("SessionEnd 预算串行路径（runSessionEndSequential）", async () => {
    const hs = new HookSystem();
    hs.setSessionId("t1-session-end");
    hs.registerHook(echoHook({ name: "session-end-hook" }), HookEventName.SessionEnd, {
      source: ConfigSource.User,
    });
    await hs.fireSessionEndEvent("exit");

    expect(executed()).toHaveLength(1);
    expect(executed()[0].data.event_name).toBe(HookEventName.SessionEnd);
    expect(executed()[0].data.hook_id).toBe("session-end-hook");
  });

  it("隔离 HookSystem（agent 声明的 hooks）也进同一个 sink", async () => {
    // 模块级 sink 的存在理由就是「实例级监听看不到隔离 HookSystem」
    const isolated = buildAgentHookSystem("test-agent", {
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo from-agent" }] }],
    });
    expect(isolated).toBeDefined();

    await isolated!.firePostToolUseEvent("edit", {}, {}, false, "tool-1");
    expect(executed()).toHaveLength(1);
    expect(executed()[0].data.hook_type).toBe("command");
  });
});

describe("T1 过滤与结论", () => {
  it("runtime hook 不记（轨迹自己不该记录自己）", async () => {
    const runner = new HookRunner();
    await runner.executeHook(
      { type: "runtime", name: "runtime-probe", action: async () => {} },
      HookEventName.PostToolUse,
      baseInput(),
    );
    expect(executed()).toHaveLength(0);
  });

  it("exit 2 → outcome=blocking，且 decision=deny", async () => {
    const runner = new HookRunner();
    await runner.executeHook(
      echoHook({ command: "echo blocked >&2; exit 2" }),
      HookEventName.PreToolUse,
      {
        ...baseInput(),
        hook_event_name: HookEventName.PreToolUse,
        tool_name: "bash",
      } as HookInput,
    );

    const d = executed()[0].data;
    expect(d.outcome).toBe("blocking");
    expect(d.exit_code).toBe(2);
    expect(d.decision).toBe("deny");
    expect(d.tool_name).toBe("bash");
  });

  it("超时 → outcome=timeout", async () => {
    const runner = new HookRunner();
    await runner.executeHook(
      echoHook({ command: "sleep 2", timeout: 0.2 }),
      HookEventName.PostToolUse,
      baseInput(),
    );
    expect(executed()[0].data.outcome).toBe("timeout");
  });

  it("async hook：先 async_started，后台完成后 HookAsyncCompleted 且 run_id 一致", async () => {
    const runner = new HookRunner();
    runner.setAsyncRegistry(new AsyncHookRegistry());

    await runner.executeHook(
      echoHook({ name: "async-hook", command: "sleep 0.1; echo done", async: true }),
      HookEventName.PostToolUse,
      baseInput(),
    );

    expect(executed()).toHaveLength(1);
    expect(executed()[0].data.outcome).toBe("async_started");

    await waitFor(() => completed().length === 1);
    expect(completed()[0].data.run_id).toBe(executed()[0].data.run_id);
    expect(completed()[0].data.exit_code).toBe(0);
    expect(typeof completed()[0].data.duration_ms).toBe("number");
  });
});

describe("T1 隐私：命令原文与输出不进事件", () => {
  it("command 原文与 stdout 哨兵都不出现在序列化后的事件里", async () => {
    const secret = "SENTINEL_TOKEN_9f3a2b";
    const runner = new HookRunner();
    await runner.executeHook(
      { type: "command", command: `echo ${secret}` },
      HookEventName.PostToolUse,
      baseInput(),
    );

    expect(executed()).toHaveLength(1);
    // 没有 name 的 hook 用 sha 摘要标识，绝不是原文
    expect(String(executed()[0].data.hook_id)).toMatch(/^cmd:[0-9a-f]{12}$/);
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("echo");
  });

  it("hook 的 stdout 内容不进事件（哨兵只出现在输出里）", async () => {
    // 上一条的哨兵同时出现在 command 里，串行验证「命令原文不进事件」；
    // 这一条让哨兵**只出现在 stdout**，独立锁住「输出不进事件」——
    // 将来有人给事件加 stdout 字段时，上一条不会红（command 里本来就没它）。
    const stdoutSecret = "STDOUT_SENTINEL_5b7c1d";
    const runner = new HookRunner();
    await runner.executeHook(
      { type: "command", name: "stdout-probe", command: `printf '%s\\n' ${stdoutSecret}` },
      HookEventName.PostToolUse,
      baseInput(),
    );

    expect(executed()).toHaveLength(1);
    expect(JSON.stringify(captured)).not.toContain(stdoutSecret);
  });
});
