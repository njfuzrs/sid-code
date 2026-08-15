/**
 * 协议完整性发送前关卡 — D1-1 + D3-2
 *
 * 背景（系统级查漏补缺方案 防线 1 / 防线 3）：
 * ADR-039 在生产端（executeTools 出口）守住了 tool_use/tool_result 配对，但孤儿
 * tool_use 仍可从中断时序 / followup 排序 / plan-mode 转换等路径进入消息历史，而
 * convertMessages 发送前**零校验**，原样转发即 OpenAI 400。
 *
 * 本模块在**消费端发送出口**设统一关卡（对齐 ADR-039 "不变量在出口强制"的哲学）：
 *   - D1-1：发送前扫描孤儿 tool_use，发现即 log.error + 落盘脏历史快照
 *   - D3-2：把触发孤儿的 assistant 消息 + 周边 ±3 条单独落 protocol-violation-<ts>.json，
 *           含 tool_call_id 配对明细，直接可验尸
 *
 * **不违反 ADR-039**：本关卡是**只读校验 + 告警 + 落盘**，不在 convertMessages 修数据
 * （ADR-039 方案 B 否决的是"修数据"）。脏数据仍由生产端负责不产生，消费端只负责发现并报警。
 *
 * strict 模式（eval/test 下抛错让 CI 红，生产下告警+落盘不中断用户）：
 *   - 显式传入 strict 参数优先
 *   - 否则读 SID_CODE_PROTOCOL_STRICT 环境变量（"1" / "true" 开启）
 */

import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import type { Message } from "./types.ts";
import {
  checkMessageHistoryIntegrity,
  describeIntegrityViolation,
  MessageHistoryViolationError,
  type MessageHistoryIntegrity,
} from "../agent/message-invariants.ts";
import { getLogger } from "../debug/logger.ts";
import { sidHomePath } from "../config/paths.ts";

export interface ProtocolGuardOptions {
  /** Provider 名称（诊断标签） */
  providerName: string;
  /**
   * strict 模式：true 时发现违例直接抛 MessageHistoryViolationError。
   * 未显式传入时由 SID_CODE_PROTOCOL_STRICT 环境变量决定（默认 false，生产只告警）。
   */
  strict?: boolean;
  /** 落盘根目录（默认 ~/.sid-code/protocol-violations）。测试可注入临时目录。 */
  dumpDir?: string;
  /** 时间戳（毫秒）。测试可注入固定值保证可复现；默认 Date.now()。 */
  now?: number;
}

/** 是否启用 strict 模式（显式参数 > 环境变量 > 默认 false） */
function resolveStrict(explicit?: boolean): boolean {
  if (typeof explicit === "boolean") return explicit;
  const env = process.env.SID_CODE_PROTOCOL_STRICT;
  return env === "1" || env === "true";
}

/**
 * P2-12：违规样本保留上限。
 *
 * 为什么需要（2026-08-14 实测）：`protocol-violations/` 无任何保留策略，用户盘上
 * 攒到 **8255 个文件 / 32MB**。落盘本身是对的（D3-2 的验尸现场），但**没有上限的
 * 采集等于慢性泄漏**。
 *
 * 上限定 500 而不是更小：违规样本的价值在于「同一类违规反复出现」的模式，
 * 只留几十个会把模式截断。500 × 平均 4KB ≈ 2MB，量级上无感。
 */
const MAX_VIOLATION_DUMPS = 500;

/**
 * 违规样本 LRU 清理：文件数超过 MAX_VIOLATION_DUMPS 时按 mtime 删最旧的。
 *
 * 复用 `collector.ts` 的 `pruneOldSessions` 模式（数一遍 → 算 overflow → 按 mtime
 * 排序删最旧）。差异只有一处：这里的条目是**文件**而非目录 —— 实测盘上 8255 个条目
 * 全是 `protocol-violation-<ts>.json` 平铺文件（方案文档写的"8255 个目录"口径有误）。
 *
 * best-effort：清理失败绝不影响落盘本身（落盘是主线，清理是附带）。
 */
function pruneOldViolationDumps(dumpDir: string): void {
  try {
    const entries = readdirSync(dumpDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith("protocol-violation-"))
      .map((e) => {
        const path = join(dumpDir, e.name);
        let mtime = 0;
        try {
          mtime = statSync(path).mtimeMs;
        } catch {
          /* stat 失败按最旧处理（mtime=0），优先被回收 */
        }
        return { path, mtime };
      });

    if (entries.length <= MAX_VIOLATION_DUMPS) return;

    const overflow = entries.length - MAX_VIOLATION_DUMPS;
    const deletable = entries.sort((a, b) => a.mtime - b.mtime).slice(0, overflow);
    for (const e of deletable) {
      try {
        rmSync(e.path, { force: true });
      } catch {
        /* 单个删除失败不影响其余 */
      }
    }
  } catch {
    /* 清理失败静默——不能让它挡住落盘 */
  }
}

/**
 * D3-2：把违例现场落盘。
 *
 * 对每个孤儿 tool_use，截取其所在 assistant 消息 + 周边 ±3 条，连同完整配对明细
 * 写入 protocol-violation-<ts>.json。best-effort：落盘失败不影响主流程（只记日志）。
 *
 * @returns 落盘文件绝对路径；落盘失败返回 null
 */
export function dumpProtocolViolation(
  messages: Message[],
  result: MessageHistoryIntegrity,
  opts: ProtocolGuardOptions,
): string | null {
  const log = getLogger();
  try {
    const dumpDir = opts.dumpDir ?? sidHomePath("protocol-violations");
    if (!existsSync(dumpDir)) mkdirSync(dumpDir, { recursive: true });

    const ts = opts.now ?? Date.now();

    // 收集所有违例涉及的 messageIndex，取并集后扩展 ±3 条窗口
    const focusIndices = new Set<number>();
    for (const o of result.orphans) focusIndices.add(o.messageIndex);
    for (const d of result.dangling) focusIndices.add(d.messageIndex);

    const windowIndices = new Set<number>();
    for (const idx of focusIndices) {
      for (let i = idx - 3; i <= idx + 3; i++) {
        if (i >= 0 && i < messages.length) windowIndices.add(i);
      }
    }
    const sortedWindow = [...windowIndices].sort((a, b) => a - b);

    // 周边消息：保留 role + content 概要（tool_use/tool_result 的 id，文本截断），避免泄露/膨胀
    const context = sortedWindow.map((i) => ({
      index: i,
      role: messages[i].role,
      blocks: summarizeBlocks(messages[i]),
    }));

    const snapshot = {
      kind: "protocol-violation",
      provider: opts.providerName,
      timestamp: new Date(ts).toISOString(),
      summary: describeIntegrityViolation(result),
      orphans: result.orphans,
      dangling: result.dangling,
      total_messages: messages.length,
      context_window: context,
    };

    const filePath = join(dumpDir, `protocol-violation-${ts}.json`);
    writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
    // P2-12：落盘后做一次 LRU，把目录压回上限内。
    // 放在 write **之后**：本次样本永远保得住，被回收的只会是更旧的。
    pruneOldViolationDumps(dumpDir);
    log.error(
      "LLM:PROTOCOL",
      `协议违例现场已落盘: ${filePath}（${describeIntegrityViolation(result)}）`,
    );
    return filePath;
  } catch (err: any) {
    log.warn("LLM:PROTOCOL", `协议违例落盘失败（不影响主流程）: ${err?.message ?? err}`);
    return null;
  }
}

/** 把单条消息的 content 概要化（只留类型 + id + 文本截断），用于诊断落盘 */
function summarizeBlocks(msg: Message): Array<Record<string, unknown>> {
  if (!Array.isArray(msg.content)) return [];
  return msg.content.map((b) => {
    if (b.type === "text") {
      return { type: "text", text_preview: b.text.slice(0, 200) };
    }
    if (b.type === "tool_use") {
      return { type: "tool_use", id: b.id, name: b.name };
    }
    if (b.type === "tool_result") {
      return {
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        is_error: b.is_error ?? false,
        content_preview: typeof b.content === "string" ? b.content.slice(0, 200) : "",
      };
    }
    // thinking / redacted_thinking — 不含敏感信息，只记类型
    return { type: b.type };
  });
}

/**
 * D1-1：发送前关卡。在 convertMessages 之前调用。
 *
 * - 完整 → 静默返回
 * - 有违例 → log.error + 落盘（D3-2）；strict 模式额外抛 MessageHistoryViolationError
 *
 * **只读**：不修改 messages，不补占位（尊重 ADR-039：脏数据由生产端负责不产生）。
 *
 * @throws MessageHistoryViolationError 仅在 strict 模式且存在违例时
 */
export function guardOutgoingMessages(messages: Message[], opts: ProtocolGuardOptions): void {
  const result = checkMessageHistoryIntegrity(messages);
  if (result.intact) return;

  const log = getLogger();
  log.error(
    "LLM:PROTOCOL",
    `[${opts.providerName}] 发送前检测到消息历史违反 tool_calls 协议不变量: ${describeIntegrityViolation(result)}。` +
      `这是 OpenAI 兼容 provider 400 的直接成因——孤儿 tool_use 从 executeTools 之外的路径进入了历史。`,
  );

  dumpProtocolViolation(messages, result, opts);

  if (resolveStrict(opts.strict)) {
    throw new MessageHistoryViolationError(
      `[${opts.providerName}] strict 模式：消息历史违反协议不变量，拒绝发送。${describeIntegrityViolation(result)}`,
      result,
    );
  }
}
