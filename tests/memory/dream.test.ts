/**
 * G10: autoDream 测试
 * 聚焦三级 gate（shouldDream）+ 状态持久化 + recordSession 计数
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { shouldDream, initAutoDream, type DreamConfig } from "../../src/memory/dream/dream.ts";

const HOUR = 1000 * 60 * 60;

describe("shouldDream 三级 gate", () => {
  const config: DreamConfig = {
    enabled: true,
    minHoursBetweenDreams: 20,
    minSessionsBetweenDreams: 5,
    minMemoriesToDream: 8,
  };
  const now = 1_000_000_000_000;

  test("全部满足 → should=true", () => {
    const state = { lastDreamAt: now - 21 * HOUR, sessionsSinceLastDream: 6 };
    const r = shouldDream(state, 10, config, now);
    expect(r.should).toBe(true);
  });

  test("时间 gate 未满足 → false", () => {
    const state = { lastDreamAt: now - 10 * HOUR, sessionsSinceLastDream: 6 };
    const r = shouldDream(state, 10, config, now);
    expect(r.should).toBe(false);
    expect(r.reason).toContain("时间 gate");
  });

  test("会话 gate 未满足 → false", () => {
    const state = { lastDreamAt: now - 21 * HOUR, sessionsSinceLastDream: 3 };
    const r = shouldDream(state, 10, config, now);
    expect(r.should).toBe(false);
    expect(r.reason).toContain("会话 gate");
  });

  test("记忆量 gate 未满足 → false", () => {
    const state = { lastDreamAt: now - 21 * HOUR, sessionsSinceLastDream: 6 };
    const r = shouldDream(state, 3, config, now);
    expect(r.should).toBe(false);
    expect(r.reason).toContain("记忆量 gate");
  });

  test("首次运行（lastDreamAt=0）跳过时间 gate", () => {
    const state = { lastDreamAt: 0, sessionsSinceLastDream: 6 };
    const r = shouldDream(state, 10, config, now);
    expect(r.should).toBe(true);
  });

  test("使用默认阈值（config 未指定各阈值）", () => {
    const minimalConfig: DreamConfig = { enabled: true };
    // 默认 20h / 5 会话 / 8 条记忆
    const state = { lastDreamAt: 0, sessionsSinceLastDream: 5 };
    expect(shouldDream(state, 8, minimalConfig, now).should).toBe(true);
    expect(shouldDream(state, 7, minimalConfig, now).should).toBe(false); // 记忆不足
  });
});

describe("initAutoDream 状态持久化", () => {
  let memoryDir: string;

  beforeEach(() => {
    memoryDir = mkdtempSync(join(tmpdir(), "sid-dream-"));
  });
  afterEach(() => {
    rmSync(memoryDir, { recursive: true, force: true });
  });

  function makeHandle(enabled = true) {
    return initAutoDream({
      getMainContext: () => ({
        systemPrompt: "",
        messages: [],
        provider: {} as any,
        toolRegistry: {} as any,
        model: "test",
      }),
      memoryDir,
      canUseTool: () => ({ behavior: "passthrough" }) as any,
      config: { enabled },
      now: () => 1_000_000_000_000,
    });
  }

  test("recordSession 累加会话计数并落盘", () => {
    const h = makeHandle();
    h.recordSession();
    h.recordSession();
    const statePath = join(memoryDir, ".dream_state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.sessionsSinceLastDream).toBe(2);
  });

  test("enabled=false 时 recordSession 不计数", () => {
    const h = makeHandle(false);
    h.recordSession();
    const statePath = join(memoryDir, ".dream_state.json");
    expect(existsSync(statePath)).toBe(false);
  });

  test("损坏的状态文件不崩溃（回退默认）", () => {
    writeFileSync(join(memoryDir, ".dream_state.json"), "not json", "utf-8");
    const h = makeHandle();
    // 不应抛异常
    h.recordSession();
    const state = JSON.parse(readFileSync(join(memoryDir, ".dream_state.json"), "utf-8"));
    expect(state.sessionsSinceLastDream).toBe(1); // 从默认 0 开始 +1
  });

  test("drainPending 无进行中任务时立即返回", async () => {
    const h = makeHandle();
    await h.drainPending(100); // 不应挂起
    expect(true).toBe(true);
  });

  test("enabled=false 时 maybeDream 无副作用", async () => {
    const h = makeHandle(false);
    await h.maybeDream();
    expect(existsSync(join(memoryDir, ".dream_state.json"))).toBe(false);
  });
});
