/**
 * G10: autoDream — 自主记忆巩固
 *
 * 对标 claude-code services/autoDream/autoDream.ts。sid 此前只有**被动**记忆提取
 * （turn-end 触发 extractMemories，只增不理），缺跨会话的**主动**巩固/剪枝——记忆
 * 长期只增不删，逐渐膨胀/陈旧。
 *
 * autoDream 补上这一层：会话结束（或空闲）时经三级 gate 判断是否该"做梦"，
 * 满足则 fire-and-forget 一个后台 forked agent 跑巩固流程（orient → review →
 * consolidate → prune），合并重复、删除过时、精炼冗长的记忆。
 *
 * 三级 gate（全部满足才触发，任一不满足则跳过）：
 * 1. 时间 gate：距上次 dream ≥ minHoursBetweenDreams（默认 20 小时）
 * 2. 会话 gate：自上次 dream 起累积会话数 ≥ minSessionsBetweenDreams（默认 5）
 * 3. 记忆量 gate：现有记忆条数 ≥ minMemoriesToDream（默认 8，太少不值得巩固）
 *
 * 状态持久化在 memoryDir/.dream_state.json（lastDreamAt + sessionsSinceLastDream）。
 */

import type { Message } from "../../llm/types.ts";
import type { ForkedAgentContext, CanUseToolFn } from "../../agent/forked-agent.ts";
import { runForkedAgent } from "../../agent/forked-agent.ts";
import { scanMemoryFiles, formatMemoryManifest } from "../scan.ts";
import { buildDreamPrompt } from "./prompts.ts";
import { getLogger } from "../../debug/logger.ts";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";

/** dream 触发配置 */
export interface DreamConfig {
  /** 是否启用（默认关闭——需用户显式开启 settings.autoDream） */
  enabled: boolean;
  /** 两次 dream 最小间隔（小时，默认 20） */
  minHoursBetweenDreams?: number;
  /** 两次 dream 之间最小会话数（默认 5） */
  minSessionsBetweenDreams?: number;
  /** 触发 dream 的最小记忆条数（默认 8） */
  minMemoriesToDream?: number;
}

const DEFAULT_MIN_HOURS = 20;
const DEFAULT_MIN_SESSIONS = 5;
const DEFAULT_MIN_MEMORIES = 8;

/** dream 状态（持久化到 .dream_state.json） */
interface DreamState {
  /** 上次 dream 的 Unix 毫秒时间戳（0 = 从未） */
  lastDreamAt: number;
  /** 自上次 dream 起累积的会话数 */
  sessionsSinceLastDream: number;
}

/** dream 系统句柄 */
export interface AutoDreamHandle {
  /** 记录一次会话结束（累加会话计数） */
  recordSession: () => void;
  /** 尝试触发 dream（经三级 gate 判断，满足才 fire-and-forget） */
  maybeDream: () => Promise<void>;
  /** 会话关闭前调用，等待进行中的 dream 完成 */
  drainPending: (timeoutMs?: number) => Promise<void>;
}

/** dream 上下文 */
export interface DreamContext {
  getMainContext: () => ForkedAgentContext;
  memoryDir: string;
  canUseTool: CanUseToolFn;
  config: DreamConfig;
  /** 当前时间戳提供器（默认 Date.now，测试可注入） */
  now?: () => number;
}

function dreamStatePath(memoryDir: string): string {
  return join(memoryDir, ".dream_state.json");
}

function loadDreamState(memoryDir: string): DreamState {
  const path = dreamStatePath(memoryDir);
  if (!existsSync(path)) {
    return { lastDreamAt: 0, sessionsSinceLastDream: 0 };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      lastDreamAt: typeof parsed.lastDreamAt === "number" ? parsed.lastDreamAt : 0,
      sessionsSinceLastDream:
        typeof parsed.sessionsSinceLastDream === "number" ? parsed.sessionsSinceLastDream : 0,
    };
  } catch {
    return { lastDreamAt: 0, sessionsSinceLastDream: 0 };
  }
}

function saveDreamState(memoryDir: string, state: DreamState): void {
  try {
    writeFileSync(dreamStatePath(memoryDir), JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    getLogger().debug("DREAM", `保存 dream 状态失败: ${err}`);
  }
}

/**
 * 判断是否应触发 dream（三级 gate）。
 * 返回 { should, reason }——reason 用于日志（说明为何触发/跳过）。
 */
export function shouldDream(
  state: DreamState,
  memoryCount: number,
  config: DreamConfig,
  now: number,
): { should: boolean; reason: string } {
  const minHours = config.minHoursBetweenDreams ?? DEFAULT_MIN_HOURS;
  const minSessions = config.minSessionsBetweenDreams ?? DEFAULT_MIN_SESSIONS;
  const minMemories = config.minMemoriesToDream ?? DEFAULT_MIN_MEMORIES;

  // Gate 1: 时间
  const hoursSince = (now - state.lastDreamAt) / (1000 * 60 * 60);
  if (state.lastDreamAt > 0 && hoursSince < minHours) {
    return { should: false, reason: `时间 gate 未满足（距上次 ${hoursSince.toFixed(1)}h < ${minHours}h）` };
  }

  // Gate 2: 会话数
  if (state.sessionsSinceLastDream < minSessions) {
    return {
      should: false,
      reason: `会话 gate 未满足（累积 ${state.sessionsSinceLastDream} < ${minSessions}）`,
    };
  }

  // Gate 3: 记忆量
  if (memoryCount < minMemories) {
    return { should: false, reason: `记忆量 gate 未满足（${memoryCount} < ${minMemories} 条）` };
  }

  return { should: true, reason: `三级 gate 全部满足（${hoursSince.toFixed(1)}h / ${state.sessionsSinceLastDream} 会话 / ${memoryCount} 条记忆）` };
}

/**
 * 初始化 autoDream 系统。
 */
export function initAutoDream(ctx: DreamContext): AutoDreamHandle {
  const log = getLogger();
  const now = ctx.now ?? Date.now;
  let pending: Promise<void> | null = null;

  function recordSession(): void {
    if (!ctx.config.enabled) return;
    const state = loadDreamState(ctx.memoryDir);
    state.sessionsSinceLastDream += 1;
    saveDreamState(ctx.memoryDir, state);
    log.debug("DREAM", `会话计数 +1 → ${state.sessionsSinceLastDream}`);
  }

  async function runDream(): Promise<void> {
    const state = loadDreamState(ctx.memoryDir);

    // 扫描现有记忆
    const headers = await scanMemoryFiles(ctx.memoryDir);
    const gate = shouldDream(state, headers.length, ctx.config, now());
    if (!gate.should) {
      log.debug("DREAM", `跳过 dream：${gate.reason}`);
      return;
    }

    log.info("DREAM", `触发记忆巩固：${gate.reason}`);
    const manifest = formatMemoryManifest(headers);
    const promptText = buildDreamPrompt(manifest);
    const promptMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: promptText }] },
    ];

    try {
      const result = await runForkedAgent(ctx.getMainContext(), {
        promptMessages,
        canUseTool: ctx.canUseTool,
        maxTurns: 10, // 巩固比提取需要更多轮（review → 逐条处理）
        querySource: "auto-dream",
        timeoutMs: 120_000, // 2 分钟——巩固是重活
      });
      log.info("DREAM", `记忆巩固完成（${result.turns} 轮，${result.deniedToolCalls} 次工具拒绝）`);
    } catch (err) {
      log.warn("DREAM", `记忆巩固失败: ${err}`);
    } finally {
      // 无论成败都更新状态（避免失败反复重试打满配额）
      saveDreamState(ctx.memoryDir, {
        lastDreamAt: now(),
        sessionsSinceLastDream: 0,
      });
    }
  }

  async function maybeDream(): Promise<void> {
    if (!ctx.config.enabled) return;
    // 已有进行中的 dream 则不重复触发
    if (pending) {
      log.debug("DREAM", "已有进行中的 dream，跳过");
      return;
    }
    pending = runDream().finally(() => {
      pending = null;
    });
    // fire-and-forget：不 await（不阻塞会话关闭）
  }

  async function drainPending(timeoutMs = 5_000): Promise<void> {
    if (!pending) return;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  return { recordSession, maybeDream, drainPending };
}
