/**
 * ModelCallUnpaired 的 `excluded_prompt_ms` 端到端链路（2026-11-15）
 *
 * ## 为什么需要这个文件
 *
 * `pairing-deadline.test.ts` 已经覆盖了 `promptMs()` 的**扣减算术**（b78ebe7f 形态：
 * 59s 请求 + 548s 等用户 → 不判）。但「闸门开着 → pair 看门狗到点 → collector 把
 * promptMs 写进 events.jsonl 的 ModelCallUnpaired」这条**落盘链路**此前没有任何测试
 * （全仓 `excluded_prompt_ms` 在 tests/ 下 0 命中）。
 *
 * 真实数据里这个字段一直是 0：本机 55 条带该字段的 ModelCallUnpaired（11-03～11-13）
 * 全部为 0，而这 17 个会话里 0 个有 HITL 段 —— 是「真没触发」，不是「没接上」。
 * 但「等不到样本」不等于「链路正确」：字段名写错、单位写成秒、取到的是快照而非增量，
 * 三种错都能通过现有单测却永远等不到真实数据来暴露。所以这里**自己造数据**：
 * 把超时压到 150ms，模拟弹窗打开期间看门狗到点，断言字段真的 > 0。
 *
 * ## 两个用例是正负对照
 *
 * 只测「> 0」不足以证明判据有区分力：如果实现是 `excluded_prompt_ms: 1`（写死非零），
 * 单条正例照样绿。所以另加一条「没有弹窗时恒为 0」的负例，两边一起才锁住语义。
 *
 * 落盘隔离：outputDir 指向 tmpdir，闸门状态在用例前后重置。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import {
  __resetHumanInputGate,
  beginHumanInputWait,
  endHumanInputWait,
} from "@sid-code/core/query/human-input-gate.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** 看门狗阈值压到 150ms —— 生产是 300s，测试不能真等。 */
const TIMEOUT_MS = 150;

let testDir: string;
let hookSystem: HookSystem;
let collector: TraceCollector | undefined;
let prevEnv: string | undefined;

beforeEach(() => {
  testDir = join(tmpdir(), `pairing-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  prevEnv = process.env.SID_CODE_PAIRING_TIMEOUT_MS;
  // 必须在 new TraceCollector 之前设：阈值是字段初始化时解析的
  process.env.SID_CODE_PAIRING_TIMEOUT_MS = String(TIMEOUT_MS);
  __resetHumanInputGate();
});

afterEach(() => {
  // 没有公开的清理接口；看门狗定时器在 fire 时已 delete + unref，不会阻止进程退出
  collector = undefined;
  if (prevEnv === undefined) delete process.env.SID_CODE_PAIRING_TIMEOUT_MS;
  else process.env.SID_CODE_PAIRING_TIMEOUT_MS = prevEnv;
  __resetHumanInputGate();
  rmSync(testDir, { recursive: true, force: true });
});

/** 读落盘的 events.jsonl（TraceWriter 落点：<outputDir>/sessions/<sessionId>/events.jsonl） */
function readEvents(): any[] {
  const sessionsDir = join(testDir, "sessions");
  if (!existsSync(sessionsDir)) return [];
  const out: any[] = [];
  for (const sid of readdirSync(sessionsDir)) {
    const file = join(sessionsDir, sid, "events.jsonl");
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const text = line.trim();
      if (!text) continue;
      try {
        out.push(JSON.parse(text));
      } catch {
        /* 半截行 */
      }
    }
  }
  return out;
}

/** 等到 events.jsonl 里出现 ModelCallUnpaired（看门狗是 setTimeout，落盘是异步 append） */
async function waitForUnpaired(timeoutMs = 3_000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = readEvents().find((e) => e.event === "ModelCallUnpaired");
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等 ModelCallUnpaired 落盘超时（${timeoutMs}ms）`);
}

/** 造一个「请求已发出、没有 AfterModel」的会话 */
async function fireRequestWithoutResponse(): Promise<void> {
  collector = new TraceCollector({ outputDir: testDir });
  hookSystem = new HookSystem();
  hookSystem.setSessionId(`sess-prompt-${Date.now()}`);
  hookSystem.setCwd("/tmp/test");
  collector.registerHooks(hookSystem);
  await hookSystem.fireSessionStartEvent("startup", { model: "claude-test" });
  await hookSystem.fireBeforeModelEvent({
    model: "claude-test",
    messages: [{ role: "user", content: "问题" }],
    raw_messages: [{ role: "user", content: "问题" }],
  });
}

describe("ModelCallUnpaired.excluded_prompt_ms 落盘链路", () => {
  it("本窗口内出现过弹窗：excluded_prompt_ms > 0 且不超过挂钟", async () => {
    await fireRequestWithoutResponse();
    const windowStart = Date.now();

    // 弹窗打开 60ms 后关闭。
    //
    // ⚠️ 不能「一直开着等它 fire」：`onPairingTimeout` 里 `remainingMs() > 0` 会**重排
    // 定时器**，而弹窗期间 effective 被 promptMs 扣减 → remaining 恒 > 0 → 永远不 fire
    // （2026-11-15 实测：开着弹窗等 3 秒也没落盘）。所以 `excluded_prompt_ms > 0` 的真实
    // 形态是「弹窗已关、但本窗口内等过人」—— 关掉后看门狗才到点，此时累计的等待时长
    // 仍在 promptMs 里。
    beginHumanInputWait();
    await new Promise((r) => setTimeout(r, 60));
    endHumanInputWait();

    const evt = await waitForUnpaired();
    const wallClock = Date.now() - windowStart;

    const excluded = evt.data?.excluded_prompt_ms;
    expect(typeof excluded).toBe("number");
    // ★核心断言：真的是被扣掉的等待时长，不是恒 0
    expect(excluded).toBeGreaterThan(0);
    // 防单位错误（写成秒会得到 < 1 的值；写成纳秒/微秒会远超挂钟）
    expect(excluded).toBeLessThanOrEqual(wallClock + 50);
    expect(evt.data?.elapsed_ms).toBe(TIMEOUT_MS);
  });

  it("负向对照：没有弹窗时恒为 0（防止写成「非零常量」也能过）", async () => {
    await fireRequestWithoutResponse();
    const evt = await waitForUnpaired();
    expect(evt.data?.excluded_prompt_ms).toBe(0);
  });
});
