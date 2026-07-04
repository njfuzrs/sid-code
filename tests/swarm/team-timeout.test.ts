/**
 * T5-B2：team 级硬超时单测
 *
 * 验证：注入短 timeoutMs 后，若某成员 hang，team.run() 应在超时后
 * reject（而非永久阻塞）。同时验证超时后 teamAbortCtl 传播使成员 signal 被 abort。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TeamManager, type TeamOptions, type TeammateSpec } from "../../src/swarm/team.ts";

// --- Mock 基础设施 ---

/** 永不完成的 SubAgent：模拟 hang 成员 */
class HangingSubAgent {
  static fromRegistry() {
    return new HangingSubAgent();
  }
  async execute(_task: any, signal?: AbortSignal): Promise<any> {
    // 等到 signal abort 或 30s（远超测试超时）
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ success: false, output: "不应走到此处" });
      }, 30_000);
      timer.unref();
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve({ success: false, output: "被 team 超时中断" });
        }, { once: true });
      }
    });
  }
}

/** 正常完成的 SubAgent */
class NormalSubAgent {
  static fromRegistry() {
    return new NormalSubAgent();
  }
  async execute(_task: any, _signal?: AbortSignal): Promise<any> {
    return { success: true, output: "完成" };
  }
}

// mock ProviderRegistry / ToolRegistry
const mockProviderRegistry = {} as any;
const mockToolRegistry = {} as any;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-team-timeout-"));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("T5-B2 team 级硬超时", () => {
  test("超时后 run() reject，不永久阻塞", async () => {
    const members: TeammateSpec[] = [
      { name: "hang-member", type: "task", task: "会卡住的任务", isolated: false },
    ];
    const opts: TeamOptions = {
      teamName: "test-timeout",
      members,
      providerRegistry: mockProviderRegistry,
      toolRegistry: mockToolRegistry,
      baseDir: dir,
      timeoutMs: 200, // 200ms 短超时
    };
    const team = new TeamManager(opts);

    // mock SubAgent.fromRegistry → 返回 HangingSubAgent
    const origImport = (await import("../../src/agent/sub-agent.ts")).SubAgent;
    const origFromRegistry = origImport.fromRegistry;
    origImport.fromRegistry = HangingSubAgent.fromRegistry as any;

    try {
      const start = Date.now();
      let caught = false;
      try {
        await team.run(undefined, Date.now());
      } catch (err: any) {
        caught = true;
        expect(err.message).toMatch(/超时/);
      }
      const elapsed = Date.now() - start;
      expect(caught).toBe(true);
      // 应在 200ms 左右 reject（允许 300ms 余量）
      expect(elapsed).toBeLessThan(500);
    } finally {
      origImport.fromRegistry = origFromRegistry;
    }
  });

  test("超时后 signal 被 abort（成员执行被中断）", async () => {
    let memberSignalAborted = false;

    class SignalCheckSubAgent {
      static fromRegistry() { return new SignalCheckSubAgent(); }
      async execute(_task: any, signal?: AbortSignal): Promise<any> {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ success: false, output: "" }), 30_000);
          timer.unref();
          signal?.addEventListener("abort", () => {
            memberSignalAborted = true;
            clearTimeout(timer);
            resolve({ success: false, output: "aborted" });
          }, { once: true });
        });
      }
    }

    const opts: TeamOptions = {
      teamName: "test-signal-propagation",
      members: [{ name: "checker", type: "task", task: "检测", isolated: false }],
      providerRegistry: mockProviderRegistry,
      toolRegistry: mockToolRegistry,
      baseDir: dir,
      timeoutMs: 150,
    };
    const team = new TeamManager(opts);

    const origImport = (await import("../../src/agent/sub-agent.ts")).SubAgent;
    const origFromRegistry = origImport.fromRegistry;
    origImport.fromRegistry = SignalCheckSubAgent.fromRegistry as any;

    try {
      await team.run(undefined, Date.now()).catch(() => {});
      // 成员的 signal 应被 abort
      expect(memberSignalAborted).toBe(true);
    } finally {
      origImport.fromRegistry = origFromRegistry;
    }
  });

  test("正常完成时不触发超时", async () => {
    const opts: TeamOptions = {
      teamName: "test-normal",
      members: [{ name: "fast", type: "task", task: "快速任务", isolated: false }],
      providerRegistry: mockProviderRegistry,
      toolRegistry: mockToolRegistry,
      baseDir: dir,
      timeoutMs: 5000, // 5s，足够
    };
    const team = new TeamManager(opts);

    const origImport = (await import("../../src/agent/sub-agent.ts")).SubAgent;
    const origFromRegistry = origImport.fromRegistry;
    origImport.fromRegistry = NormalSubAgent.fromRegistry as any;

    try {
      const results = await team.run(undefined, Date.now());
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].output).toBe("完成");
    } finally {
      origImport.fromRegistry = origFromRegistry;
    }
  });
});
