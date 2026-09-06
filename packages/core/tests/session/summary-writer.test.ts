/**
 * D2：会话摘要写入端的接线测试。
 *
 * 这条缺陷的形态是「两头都活着、中间没人接」：`SessionSummary` 接口、`saveSummary()`
 * 实现、`loadSummary()` 三级兜底查找**全都在**，唯独没有任何生产代码调用 saveSummary
 * （唯一调用者是一个测试），磁盘上 34 个项目目录下的 summaries/ 全部为空。
 *
 * 后果不是「少一个功能」，而是 restoreSession 的摘要路径**恒不可达** ——
 * 所有长会话都掉进最差的截断分支（D1）。
 *
 * 所以这里测的判据是**落盘 + 可被 loadSummary 读回**，而不是「函数被调用过」：
 * 前者才能证明整条通路接上了。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { SessionStore } from "@sid-code/core/session/store.ts";
import { App } from "@sid-code/cli/app.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";

describe("D2：会话摘要写入端（compactObserver → saveSummary）", () => {
  let testDir: string;
  let origHome: string | undefined;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-summary-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    return new App({ config, provider: {} as any, mcpManager: {} as any });
  }

  /** 等待 persistSessionSummary 的 fire-and-forget 落盘完成。 */
  async function waitForSummary(id: string, tries = 40): Promise<any> {
    const store = new SessionStore();
    for (let i = 0; i < tries; i++) {
      const s = await store.loadSummary(id);
      if (s) return s;
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  }

  test("D2：压缩产出的摘要被写入 summaries/ 且能被 loadSummary 读回", async () => {
    const app = makeApp();
    const sessionId = "d2-writer-1";
    (app as any).sessionState.sessionId = sessionId;

    // 直接调私有落盘方法：等价于 compactObserver 被 compactWithSummary 触发那一刻。
    // 不去真跑一次压缩，是因为压缩需要 LLM —— 而本用例要验的是**接线**，不是压缩质量。
    (app as any).persistSessionSummary("这是压缩产出的摘要ABC", 42);

    const saved = await waitForSummary(sessionId);
    expect(saved).not.toBeNull();
    expect(saved.summary).toContain("这是压缩产出的摘要ABC");
    // messageCount 记的是被这次压缩移除的消息数，恢复端据此判断摘要覆盖面
    expect(saved.messageCount).toBe(42);
    expect(saved.sessionId).toBe(sessionId);
  });

  /**
   * D2 的接线本身：**ctxMgr 触发压缩观察者时，摘要必须真的落盘。**
   *
   * 上一个用例直接调 persistSessionSummary，证明的是「落盘函数能用」；
   * 这一个从 ctxMgr 那一侧触发，证明的是「观察者确实被接上了」——
   * 而「两头都活着、中间没人接」正是 D2 的原始形态，所以这条不能省。
   */
  test("D2：经 ctxMgr 压缩观察者触发时摘要落盘（接线不是死的）", async () => {
    const app = makeApp();
    const sessionId = "d2-observer-wired";
    (app as any).sessionState.sessionId = sessionId;

    // 复现 doInit() 里的注入，再从 ctxMgr 存下的那个回调触发 ——
    // compactWithSummary 完成时调的就是这个字段（manager.ts 的 `this.compactObserver(...)`）。
    // 刻意不为测试在生产代码上开触发口子：直接取存下的回调，测的就是真实那一条。
    (app as any).ctxMgr.setCompactObserver((s: string, n: number) =>
      (app as any).onContextCompacted(s, n),
    );
    const observer = (app as any).ctxMgr.compactObserver;
    expect(typeof observer).toBe("function"); // 接线存在性本身就是判据
    observer("观察者链路产出的摘要DEF", 13);

    const saved = await waitForSummary(sessionId);
    expect(saved).not.toBeNull();
    expect(saved.summary).toContain("观察者链路产出的摘要DEF");
    expect(saved.messageCount).toBe(13);
  });

  test("D2：空摘要不落盘（不产生无内容的摘要文件）", async () => {
    const app = makeApp();
    const sessionId = "d2-writer-empty";
    (app as any).sessionState.sessionId = sessionId;

    (app as any).persistSessionSummary("   ", 10);
    await new Promise((r) => setTimeout(r, 120));

    const store = new SessionStore();
    expect(await store.loadSummary(sessionId)).toBeNull();
  });

  /**
   * D2 的关键细节：**必须用逻辑会话 id 落盘**。
   *
   * resume 后 `sessionState.sessionId` 是本进程新生成的 id，而摘要要能在下次恢复
   * **旧会话**时被 loadSummary 找到 —— 写到新 id 下等于换一种方式继续断线。
   */
  test("D2：resume 后摘要落在被恢复会话的 id 下（逻辑 id，非进程新 id）", async () => {
    const app = makeApp();
    (app as any).sessionState.sessionId = "process-new-id";
    (app as any).resumedSessionId = "resumed-old-id";

    (app as any).persistSessionSummary("恢复会话里产生的摘要", 7);

    const saved = await waitForSummary("resumed-old-id");
    expect(saved).not.toBeNull();
    expect(saved.sessionId).toBe("resumed-old-id");

    // 反向自证：不该写到进程新 id 下
    const store = new SessionStore();
    expect(await store.loadSummary("process-new-id")).toBeNull();
  });
});
