/**
 * 会话恢复续接提示单测（缺口 B）
 *
 * 覆盖：
 * - buildResumeMarker 纯函数：含续接说明、可选进度note、不向用户复述
 * - restoreSession 三条路径恢复后历史末尾都能找到续接提示，且 tool_use/tool_result 配对完整
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { SessionStore } from "../../src/session/store.ts";
import type { SessionData } from "../../src/session/store.ts";
import { App } from "../../src/app.ts";
import { defaultConfig } from "../../src/config/config.ts";
import type { Config } from "../../src/config/config.ts";
import type { Message } from "../../src/llm/types.ts";
import { checkMessageHistoryIntegrity } from "../../src/agent/message-invariants.ts";

describe("SessionStore.buildResumeMarker（缺口 B 纯函数）", () => {
  test("含续接说明 + 不向用户复述约束", () => {
    const m = SessionStore.buildResumeMarker();
    expect(m).toContain("续接");
    expect(m).toContain("<system-reminder>");
    expect(m).toContain("请勿向用户");
  });

  test("传入进度note时附在标记后", () => {
    const m = SessionStore.buildResumeMarker("# 工作日志\n- [x] 完成 A\n- [ ] 待办 B");
    expect(m).toContain("待办 B");
    expect(m).toContain("进度");
  });

  test("空 progressNote 不产生空进度段", () => {
    const m = SessionStore.buildResumeMarker("   ");
    expect(m).not.toContain("进度记录如下");
  });
});

describe("App.restoreSession（缺口 B 三条路径）", () => {
  let testDir: string;
  let origHome: string | undefined;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-code-resume-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = testDir;
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function makeApp(): App {
    const config = {
      ...defaultConfig(),
      model: "mock-model",
      provider: "mock",
      availableModels: [],
      permissionMode: "default",
    } as unknown as Config;
    return new App({
      config,
      provider: {} as any,
      mcpManager: {} as any,
    });
  }

  /** 从 ctxMgr 取全部消息文本，便于断言续接提示存在 */
  function allText(msgs: Message[]): string {
    return msgs
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }

  function userMsg(text: string): Message {
    return { role: "user", content: [{ type: "text", text }] };
  }
  function asstMsg(text: string): Message {
    return { role: "assistant", content: [{ type: "text", text }] };
  }

  test("路径 1（短会话 ≤20 条）：恢复后含续接标记 + 配对完整", async () => {
    const app = makeApp();
    const messages: Message[] = [userMsg("第一个问题"), asstMsg("第一个回答")];
    const data: SessionData = {
      id: "short01",
      messages,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as SessionData;

    await app.restoreSession(data);
    const restored = (app as any).ctxMgr.getMessages() as Message[];
    expect(allText(restored)).toContain("续接");
    expect(checkMessageHistoryIntegrity(restored).orphans.length).toBe(0);
    expect(checkMessageHistoryIntegrity(restored).dangling.length).toBe(0);
  });

  test("路径 3（>20 条无摘要）：恢复后含续接标记 + 配对完整", async () => {
    const app = makeApp();
    const messages: Message[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push(userMsg(`问题${i}`));
      messages.push(asstMsg(`回答${i}`));
    }
    const data: SessionData = {
      id: "long-nosummary",
      messages,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as SessionData;

    await app.restoreSession(data);
    const restored = (app as any).ctxMgr.getMessages() as Message[];
    expect(allText(restored)).toContain("续接");
    expect(checkMessageHistoryIntegrity(restored).orphans.length).toBe(0);
    expect(checkMessageHistoryIntegrity(restored).dangling.length).toBe(0);
  });

  test("路径 2（>20 条有摘要）：恢复后含恢复提示（buildResumeMessage）", async () => {
    const store = new SessionStore();
    await store.saveSummary({
      sessionId: "long-summary",
      summary: "这是之前对话的摘要内容XYZ",
      messageCount: 30,
      createdAt: new Date().toISOString(),
    } as any);

    const app = makeApp();
    const messages: Message[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push(userMsg(`问题${i}`));
      messages.push(asstMsg(`回答${i}`));
    }
    const data: SessionData = {
      id: "long-summary",
      messages,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as SessionData;

    await app.restoreSession(data);
    const restored = (app as any).ctxMgr.getMessages() as Message[];
    expect(allText(restored)).toContain("恢复");
    expect(allText(restored)).toContain("摘要内容XYZ");
    expect(checkMessageHistoryIntegrity(restored).orphans.length).toBe(0);
    expect(checkMessageHistoryIntegrity(restored).dangling.length).toBe(0);
  });

  test("路径 1 末尾为未应答 tool_use 时，续接标记不破坏配对（backfill 兜底）", async () => {
    const app = makeApp();
    const messages: Message[] = [
      userMsg("帮我读取文件"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "好的" },
          { type: "tool_use", id: "call_x", name: "read", input: { file_path: "/a" } },
        ],
      },
      // 故意缺失 call_x 的 tool_result —— 模拟中断在工具执行前
    ];
    const data: SessionData = {
      id: "orphan-tail",
      messages,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as SessionData;

    await app.restoreSession(data);
    let restored = (app as any).ctxMgr.getMessages() as Message[];
    // 续接标记已追加
    expect(allText(restored)).toContain("续接");
    // 恢复阶段本身允许存在孤儿（发送前 backfillOrphanToolResults 兜底）；
    // 这里验证 backfill 后能消除孤儿、保留续接标记
    const { backfillOrphanToolResults } = await import("../../src/agent/message-invariants.ts");
    const fixed = backfillOrphanToolResults(restored);
    const finalMsgs = fixed.changed ? fixed.messages : restored;
    expect(checkMessageHistoryIntegrity(finalMsgs).orphans.length).toBe(0);
    expect(checkMessageHistoryIntegrity(finalMsgs).dangling.length).toBe(0);
    expect(allText(finalMsgs)).toContain("续接");
  });

  test("进度文件存在时，续接标记携带落盘进度", async () => {
    // 写入被恢复会话的 progress 文件
    const progressDir = join(testDir, ".sid-code", "progress");
    mkdirSync(progressDir, { recursive: true });
    writeFileSync(join(progressDir, "with-progress.md"), "# 工作日志\n- [ ] 尚未完成的任务PQR", "utf-8");

    const app = makeApp();
    const data: SessionData = {
      id: "with-progress",
      messages: [userMsg("继续之前的活")],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as SessionData;

    await app.restoreSession(data);
    const restored = (app as any).ctxMgr.getMessages() as Message[];
    expect(allText(restored)).toContain("尚未完成的任务PQR");
  });

  // ─── P0-2：permissionMode 不做隐式跨会话恢复（对齐 CC 安全红线）───

  test("P0-2：快照含 acceptEdits + CLI 未指定 → 恢复后仍为 default（不复活半恢复档）", async () => {
    const app = makeApp(); // config.permissionMode = "default"（CLI 未显式指定）
    const data: SessionData = {
      id: "perm-accept",
      messages: [userMsg("继续")],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        // 旧快照里残留 permissionMode 字段——恢复端应读到即忽略，不复活。
        agent_setting: { model: "m", effortLevel: null, thinking: null, permissionMode: "acceptEdits" },
      },
    } as unknown as SessionData;

    await app.restoreSession(data);
    // 关键断言：acceptEdits 不再跨会话静默复活，权限档位回到每会话重新裁定的 default。
    expect((app as any).config.permissionMode).toBe("default");
  });

  test("P0-2：CLI 显式 acceptEdits 不被快照的 default 覆盖（显式意图优先，与恢复无关）", async () => {
    const config = {
      ...defaultConfig(),
      model: "mock-model",
      provider: "mock",
      availableModels: [],
      permissionMode: "acceptEdits", // CLI 显式指定（loadConfig 阶段生效）
    } as unknown as Config;
    const app = new App({ config, provider: {} as any, mcpManager: {} as any });

    const data: SessionData = {
      id: "perm-cli-explicit",
      messages: [userMsg("继续")],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        agent_setting: { model: "m", effortLevel: null, thinking: null, permissionMode: "default" },
      },
    } as unknown as SessionData;

    await app.restoreSession(data);
    // 恢复流程完全不碰 permissionMode，CLI 显式值原样保留。
    expect((app as any).config.permissionMode).toBe("acceptEdits");
  });

  test("P0-2：agent_setting 的 model/effort/thinking 仍正常恢复（只删 permissionMode）", async () => {
    const app = makeApp();
    const data: SessionData = {
      id: "perm-keep-prefs",
      messages: [userMsg("继续")],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        agent_setting: { model: "restored-model", effortLevel: "high", thinking: "on", permissionMode: "acceptEdits" },
      },
    } as unknown as SessionData;

    await app.restoreSession(data);
    // 用户偏好（非安全边界）继续恢复，不受 P0-2 影响。
    expect((app as any).config.model).toBe("restored-model");
    expect((app as any).runtimeEffort).toBe("high");
    expect((app as any).runtimeThinking).toBe("on");
    // 但权限档位不恢复。
    expect((app as any).config.permissionMode).toBe("default");
  });
});
