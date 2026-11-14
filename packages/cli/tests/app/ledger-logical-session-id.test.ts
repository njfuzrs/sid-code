/**
 * CP-12（方案 20261114-cost面板数据失真）：resume 后账本必须按**逻辑会话 id**落行。
 *
 * 缺陷形态：`buildUsageLedgerEntry` 取的是 `sessionState.sessionId`（本进程新 id），
 * 而 resume 时 `restoreSession` 刻意不改它（进程 id 要跨进程唯一，供 crash marker / PID /
 * trajectory 用），逻辑会话 id 存在 `resumedSessionId` 里。于是同一逻辑会话在
 * `usage-ledger.jsonl` 里拆成两行：
 *   - 新行 id 在 `trajectories/sessions/` 下**没有对应目录**（账本按 sessionId 关联轨迹必失败）；
 *   - 行内口径混合 —— `promptTotal` / `costUSD` 经 `usage_stats` 回灌是**会话**口径，
 *     `byAgent` 却只含本进程 —— 按行求和会把 resume 前的用量算两遍。
 *
 * 这里走真实链路验证：进程 A 记账 → 进程 B `restoreSession(同 id)` → 再记账 →
 * 账本里只有一行、key 是逻辑会话 id，且四个字段都等于两段之和。
 *
 * 为什么必须在 App 层测：key 的取值发生在 `App.buildLedgerEntry()`（唯一生产者），
 * 只测 `usage-ledger.ts` 的 upsert 等于测了「能不能去重」，没测「到底用哪个 id 去重」。
 *
 * 经 SID_CONFIG_DIR + SID_CODE_USAGE_LEDGER 重定向到 tmp，不触碰真实 ~/.sid-code；
 * 不联网（provider 只构造、不发请求）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { App } from "@sid-code/cli/app.ts";
import { UnifiedCommandRegistry } from "@sid-code/cli/command/unified-registry.ts";
import { defaultConfig, resolveCurrentModelConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import { readUsageLedger } from "@sid-code/core/telemetry/usage-ledger.ts";
import {
  resetAgentUsageProcess,
  resetAgentUsageSession,
} from "@sid-code/core/telemetry/agent-usage.ts";
import { getSessionSideStats, resetSideCallStats } from "@sid-code/core/trace/side-call-sink.ts";

const SESSION_ID = "20261114-100000-cp12test"; // 逻辑会话 id（首次启动即会话 id）= 后续轨迹目录名
const PROC_B_ID = "20261114-101500-proc000b"; // resume 后新进程 id（必须与上面不同）
const BASE_URL = "http://127.0.0.1:9/mock"; // 不联网：只构造 provider，不发请求
const MODEL = "mock-model";

let testDir: string;
const saved = {
  HOME: process.env.HOME,
  SID_CONFIG_DIR: process.env.SID_CONFIG_DIR,
  SID_CODE_USAGE_LEDGER: process.env.SID_CODE_USAGE_LEDGER,
};

beforeEach(() => {
  testDir = join(tmpdir(), `sid-ledger-cp12-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testDir, ".sid-code"), { recursive: true });
  process.env.HOME = testDir;
  process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  process.env.SID_CODE_USAGE_LEDGER = join(testDir, ".sid-code", "usage-ledger.jsonl");
  // 两个模块都是**进程级**全局状态（基线 + 本进程记录），跨文件同进程跑必须清干净，
  // 否则前一个测试的 byAgent / 影子调用会漏进这一条。
  resetAgentUsageSession();
  resetAgentUsageProcess();
  resetSideCallStats();
});

afterEach(() => {
  resetAgentUsageSession();
  resetAgentUsageProcess();
  resetSideCallStats();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

function makeApp(processSessionId: string): any {
  const config = {
    ...defaultConfig(),
    model: MODEL,
    provider: "anthropic",
    sessionId: processSessionId,
    availableModels: [
      {
        name: MODEL,
        provider: "anthropic",
        baseURL: BASE_URL,
        apiKey: "k-mock",
        // 显式定价：成本非零才让「两段之和」这条断言有判别力（全 0 时 0 === 0+0 恒真）
        pricing: { input: 3, output: 15 },
      },
    ],
    permissionMode: "default",
  } as unknown as Config;
  resolveCurrentModelConfig(config);
  const registry = new ProviderRegistry(config);
  return new App({
    unifiedRegistry: new UnifiedCommandRegistry(),
    config,
    provider: registry.getProvider(),
    providerRegistry: registry,
    mcpManager: {} as any,
  } as any);
}

/** 喂一次主循环用量（每个字段刻意取不同量级，混叠时会立刻暴露）。 */
function bill(app: any, inputTokens: number, outputTokens: number): void {
  app.sessionState.updateUsage(
    MODEL,
    {
      inputTokens,
      outputTokens,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    1000,
    "anthropic",
    BASE_URL,
  );
}

/** 造一次辅助调用记账（byAgent 的唯一生产者是 billing-sink 去重后的这一步）。 */
function recordAux(agentId: string, inputTokens: number): void {
  // 计价函数由 App 构造时注入（SessionState.calculateCost），与账本 costUSD 同口径
  const { recordAgentUsage } = require("@sid-code/core/telemetry/agent-usage.ts");
  recordAgentUsage({
    agentId,
    model: MODEL,
    provider: "anthropic",
    baseURL: BASE_URL,
    usage: {
      inputTokens,
      outputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  });
}

/**
 * 造一次影子调用（标题生成这类消费侧自报）。
 *
 * 账本行的 `sideCostUSD` 取自 `getSessionSideStats()`（side-call-sink 的会话维度），
 * **不是** SessionState 的同名字段 —— 所以必须走 `recordSideCall` 这条真实采集路径，
 * 顺带经 `setSideCostObserver` → `addSideCost` 让行内 `costUSD` 也含这笔。
 */
function recordSide(costUSD: number, sentTokens: number): void {
  const { recordSideCall } = require("@sid-code/core/trace/side-call-sink.ts");
  recordSideCall({
    label: "title",
    model: MODEL,
    inputTokens: sentTokens,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD,
  });
}

function sessionSnapshot(id: string, metadata: Record<string, unknown>): any {
  const now = new Date().toISOString();
  return {
    version: "1",
    id,
    model: MODEL,
    provider: "anthropic",
    messages: [],
    createdAt: now,
    updatedAt: now,
    metadata,
  };
}

describe("CP-12：账本按逻辑会话 id 单行累计", () => {
  test("启动→计费→退出→resume→计费→退出：账本一行，key=轨迹目录名，四字段=两段之和", async () => {
    // ─── 第一段：进程 A（首次启动，进程 id 就是会话 id）───
    const appA = makeApp(SESSION_ID);
    bill(appA, 1000, 200);
    recordAux("extract", 400);
    recordSide(0.25, 300);
    const entryA = appA.buildLedgerEntry();
    expect(entryA).not.toBeNull();
    // 哨兵：这一行的成本与 token 都非零，否则下面「两段之和」的断言恒真
    expect(entryA.promptTotal).toBe(1000);
    expect(entryA.costUSD).toBeGreaterThan(0);
    expect(entryA.sideCostUSD).toBeCloseTo(0.25, 12);
    expect(entryA.byAgent?.extract.requests).toBe(1);

    // 落盘（生产路径是 SessionEnd / 增量刷，二者都走同一个 upsert）
    const { upsertUsageLedger } = require("@sid-code/core/telemetry/usage-ledger.ts");
    upsertUsageLedger(entryA);

    // ─── 段边界：模拟「进程 A 退出 → 进程 B 启动」───
    // 三个采集器都是进程级全局状态（基线 + 本进程记录）。真实时序是：新进程起来时
    // SessionStart 调 reset*（只清本进程记录、不清基线），随后 restoreSession 回灌基线。
    // 这里必须显式模拟，否则 A 段的本进程记录会漏进 B 段 —— 那是测试环境假象，
    // 不是产品行为（真进程退出后 _current 自然为空）。
    const sideSnapshot = getSessionSideStats(); // A 段的会话维度快照 = side_call_stats 落盘值
    resetSideCallStats();
    resetAgentUsageProcess();

    // ─── 第二段：进程 B，resume 同一个逻辑会话 ───
    const appB = makeApp(PROC_B_ID);
    expect((appB as any).sessionState.sessionId).toBe(PROC_B_ID); // 进程 id 是新 id（这是既有的刻意分离）
    await appB.restoreSession(
      sessionSnapshot(SESSION_ID, {
        usage_stats: appA.sessionState.serializeUsageSnapshot(),
        agent_usage: entryA.byAgent,
        side_call_stats: sideSnapshot,
      }),
    );
    // 关键前提：逻辑会话 id 已切到被恢复会话，而进程 id 没动
    expect((appB as any).getLogicalSessionId()).toBe(SESSION_ID);
    expect((appB as any).sessionState.sessionId).toBe(PROC_B_ID);

    const beforeB = appB.sessionState.getEffectiveTotalCostUSD();
    bill(appB, 500, 100);
    recordAux("extract", 600);
    recordSide(0.5, 700);
    const entryB = appB.buildLedgerEntry();
    expect(entryB).not.toBeNull();
    upsertUsageLedger(entryB);

    // ─── 断言：账本只有一行，且这一行是会话口径 ───
    const rows = readUsageLedger();
    expect(rows.length).toBe(1); // 修复前这里是 2（两行各自按 promptTotal/costUSD 求和会双计）

    const row = rows[0]!;
    // key 必须等于逻辑会话 id（与轨迹目录名同源：trace/collector.ts 用 resumed_from）
    expect(row.sessionId).toBe(SESSION_ID);
    expect(row.sessionId).toBe((appB as any).getLogicalSessionId());

    // promptTotal：主循环 token 经 usage_stats 回灌，跨 resume 连续
    expect(row.promptTotal).toBe(1500);

    // costUSD：金额同样跨 resume 连续（第一段 0.006 + 第二段 0.003 量级）
    expect(row.costUSD).toBeCloseTo(entryA.costUSD + (entryB.costUSD - beforeB), 12);
    expect(row.costUSD).toBeGreaterThan(entryA.costUSD); // 第二段真的加进去了，不是被覆盖成首段

    // sideCostUSD：经 usage_stats.sideCostUSD 回灌，两段相加
    expect(row.sideCostUSD).toBeCloseTo(0.75, 12);

    // byAgent：经 agent_usage 回灌基线，两段相加（修复前只有本进程的 1 次）
    expect(row.byAgent?.extract.requests).toBe(2);
    expect(row.byAgent?.extract.inputTokens).toBe(1000);
  });

  test("反向自证：非 resume 会话（/clear 后的新会话）仍按自己的 id 落行", () => {
    const app = makeApp("20261114-110000-freshid");
    bill(app, 300, 50);
    const entry = app.buildLedgerEntry();
    expect(entry).not.toBeNull();
    // 没有 resume 时逻辑 id 就是本进程 id —— 不能用「永远取某个全局会话 id」来通过上面那条测试
    expect(entry.sessionId).toBe("20261114-110000-freshid");
    expect(entry.sessionId).toBe((app as any).getLogicalSessionId());
  });
});
