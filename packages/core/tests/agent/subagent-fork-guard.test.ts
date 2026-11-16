/**
 * forkMessages 必须在进程内执行 + sub_agent 不再暴露 fork 参数（06H1 T1 / T7）
 *
 * T7（2026-11-16）删掉了 `sub_agent` 的 `fork` 参数，T1/T2 两条「fork 用法报错」随之没有对象。
 * 但 `SubAgentTask.forkMessages` 保留：send_message 的 sidechain 真恢复（P2-3）用它把重建的
 * 完整历史灌给新子代理。spawn 的父子协议传不了这个字段，所以「forkMessages 非空 → 强制进程内」
 * 仍然要守，否则续接在 spawn 模式下会静默丢历史。这里锁住：
 * - sub_agent 的 schema 里不再有 fork（防止被当成「从来没有」而重新加回却没补论证）
 * - shouldUseSpawn() 为真时，forkMessages 非空仍走进程内，首条上下文来自 forkMessages
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

/** 记录每次请求的 messages，并回一句话收尾。 */
class RecordingProvider implements Provider {
  requests: SendParams[] = [];
  name() {
    return "recording";
  }
  defaultModel() {
    return "m";
  }
  async *sendMessageStream(params: SendParams): AsyncIterable<StreamEvent> {
    this.requests.push(params);
    yield {
      type: "message_start",
      message: { id: "m1", role: "assistant", usage: { inputTokens: 1, outputTokens: 0 } },
    } as StreamEvent;
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } as StreamEvent;
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "## 结论\n完成" },
    } as StreamEvent;
    yield { type: "content_block_stop", index: 0 } as StreamEvent;
    yield {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { outputTokens: 1 },
    } as StreamEvent;
  }
}

const PARENT_TEXT = "父对话里已经确认过的背景 A-42";

let base: string;
const savedConfigDir = process.env.SID_CONFIG_DIR;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sid-fork-guard-"));
  // 子代理会写 sidechain / session registry，全部重定向到 tmpdir（不碰真实 ~/.sid-code）
  process.env.SID_CONFIG_DIR = join(base, "home");
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedConfigDir;
  rmSync(base, { recursive: true, force: true });
});

function makeTool(providerRegistry?: ProviderRegistry): SubAgentTool {
  const config = defaultConfig() as Config;
  return new SubAgentTool(providerRegistry ?? new ProviderRegistry(config, {}), new Registry());
}

describe("T7：sub_agent 不再暴露 fork 参数", () => {
  test("schema 里没有 fork 字段", () => {
    const shape = (makeTool().zodSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).not.toContain("fork");
    // 对照：同一个 shape 确实读得到其他参数，避免 shape 取错而恒绿
    expect(Object.keys(shape)).toContain("isolation");
  });
});

describe("T1：forkMessages 存在时强制进程内（spawn 协议传不了它，send_message 续接依赖）", () => {
  test("shouldUseSpawn() 为真时 fork 仍走进程内，且首条上下文来自 fork", async () => {
    const provider = new RecordingProvider();
    const sub = new SubAgent(provider, "m", new Registry());
    let spawnCalled = false;
    (sub as unknown as { shouldUseSpawn: () => boolean }).shouldUseSpawn = () => true;
    (sub as unknown as { executeSpawned: () => Promise<never> }).executeSpawned = async () => {
      spawnCalled = true;
      throw new Error("不该走 spawn");
    };

    const r = await sub.execute({
      type: "explore",
      description: "核验",
      prompt: "接着聊",
      forkMessages: [{ role: "user", content: [{ type: "text", text: PARENT_TEXT }] }],
    });

    expect(spawnCalled).toBe(false);
    expect(r.success).toBe(true);
    expect(JSON.stringify(provider.requests)).toContain(PARENT_TEXT);
  });

  test("对照：没有 forkMessages 时 spawn 照常被选中（强制进程内只在 fork 时生效）", async () => {
    const provider = new RecordingProvider();
    const sub = new SubAgent(provider, "m", new Registry());
    let spawnCalled = false;
    (sub as unknown as { shouldUseSpawn: () => boolean }).shouldUseSpawn = () => true;
    (sub as unknown as { executeSpawned: () => Promise<unknown> }).executeSpawned = async () => {
      spawnCalled = true;
      return {
        success: true,
        output: "spawn 结果",
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 1,
        toolUseCount: 0,
      };
    };

    const r = await sub.execute({ type: "explore", description: "核验", prompt: "看看" });
    expect(spawnCalled).toBe(true);
    expect(r.success).toBe(true);
  });
});
