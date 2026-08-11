/**
 * 会话回退管理器（P2-1，对标 claude-code 的 Esc+Esc rewind）
 *
 * 职责：在每轮用户输入前登记一个「回退点」，记录两样东西：
 *   1. 对话层锚点：本轮用户消息在 ctxMgr.messages 中的下标（回退 = 截断到此下标之前）。
 *   2. 文件层锚点：当前 CheckpointManager 的最新快照 id（回退 = restoreToSnapshot 到此）。
 *
 * 用户按 Esc+Esc → UI 列出最近 N 个回退点 → 选中后本管理器执行：
 *   - 仅对话：ctxMgr.setMessages(截断后的消息)。
 *   - 对话+代码：先 restoreToSnapshot 回滚文件，再截断对话。
 *
 * 设计要点：
 * - 纯数据 + 注入式依赖（ctxMgr 取/设消息、checkpoint 取最新快照 id/恢复），不 import App/UI，
 *   便于单测且不与并发编辑的 app.ts/App.tsx 抢占大文件。
 * - 回退点用环形上限（MAX_POINTS）防无限增长；截断后清理落在截断点之后的回退点。
 */

/** 单个回退点。 */
export interface RewindPoint {
  /** 自增 id（从 1 开始，稳定标识，供 UI 选中）。 */
  id: number;
  /** 本轮用户消息在 ctxMgr.messages 中的下标（截断到此下标 = 回到该轮之前）。 */
  messageIndex: number;
  /** 登记时 CheckpointManager 的最新快照 id（空串 = 当时无文件快照，仅能回退对话）。 */
  snapshotId: string;
  /** 用户输入预览（截断展示用）。 */
  inputPreview: string;
  /** 登记时间戳（ms）。 */
  timestamp: number;
}

/**
 * 回退模式（对齐 CC Esc+Esc 菜单的三档：代码 / 对话 / 两者）。
 * - `conversation`：仅截断对话，不动文件。
 * - `code`：仅回滚文件到该轮快照，保留对话（用户想留着上下文重试，只要撤销文件改动）。
 * - `conversation-and-code`：两者都做。
 */
export type RewindMode = "conversation" | "code" | "conversation-and-code";

/** 回退结果（供 UI 回显）。 */
export interface RewindResult {
  /** 实际回退到的点。 */
  point: RewindPoint;
  /** 使用的模式。 */
  mode: RewindMode;
  /** 对话是否被截断（截断了多少条消息）。 */
  messagesDropped: number;
  /** 文件是否被回滚（受影响文件数；未回滚为 0）。 */
  filesRestored: number;
  /** 文件回滚是否因无快照/未启用而跳过。 */
  fileRestoreSkipped: boolean;
}

/** 注入依赖：解耦 ctxMgr / checkpoint 具体实现，便于测试。 */
export interface RewindDeps {
  /** 取当前对话消息数组（用于登记时算下标、回退时截断）。 */
  getMessages: () => unknown[];
  /** 整体替换对话消息（截断后写回）。 */
  setMessages: (msgs: unknown[]) => void;
  /** 取 CheckpointManager 当前最新快照 id（无则返回空串）。 */
  getLatestSnapshotId: () => string;
  /** 回滚文件到指定快照，返回受影响文件数（未启用/无快照返回 null）。 */
  restoreToSnapshot: (snapshotId: string) => Promise<number | null>;
}

/** 回退点上限：只保留最近 N 个，防止长会话无限增长。 */
export const MAX_REWIND_POINTS = 30;
/** 输入预览最大字符数。 */
const PREVIEW_MAX = 60;

export class RewindManager {
  private points: RewindPoint[] = [];
  private nextId = 1;
  private deps: RewindDeps;

  constructor(deps: RewindDeps) {
    this.deps = deps;
  }

  /**
   * 在一轮用户输入提交前调用：登记一个回退点。
   * messageIndex 取"当前消息数组长度"——即本轮用户消息即将插入的位置，
   * 回退时截断到此下标 = 丢弃本轮及之后的所有消息，回到本轮之前的状态。
   * nowMs 由调用方注入（运行时用 Date.now()，测试可控）。
   */
  registerPoint(userInput: string, nowMs: number): RewindPoint {
    const messageIndex = this.deps.getMessages().length;
    const point: RewindPoint = {
      id: this.nextId++,
      messageIndex,
      snapshotId: this.deps.getLatestSnapshotId(),
      inputPreview: makePreview(userInput),
      timestamp: nowMs,
    };
    this.points.push(point);
    // 环形上限：超出则丢最旧。
    if (this.points.length > MAX_REWIND_POINTS) {
      this.points.splice(0, this.points.length - MAX_REWIND_POINTS);
    }
    return point;
  }

  /** 列出回退点（最新在前，供 UI 展示）。 */
  listPoints(): RewindPoint[] {
    return [...this.points].reverse();
  }

  /** 按 id 取回退点。 */
  getPoint(id: number): RewindPoint | null {
    return this.points.find((p) => p.id === id) ?? null;
  }

  /** 是否有可回退的点。 */
  hasPoints(): boolean {
    return this.points.length > 0;
  }

  /**
   * 执行回退到指定点。
   * - conversation：仅截断对话消息到 point.messageIndex。
   * - code：仅回滚文件到该轮快照，**不动对话**（回退点也全部保留，因为对话没变）。
   * - conversation-and-code：先 restoreToSnapshot 回滚文件，再截断对话。
   * 截断对话后清理所有落在该点之后（含该点）的回退点，避免"回退后又能回退到已丢弃的未来"。
   */
  async rewindTo(id: number, mode: RewindMode, nowMs: number): Promise<RewindResult | null> {
    void nowMs;
    const point = this.getPoint(id);
    if (!point) return null;

    let filesRestored = 0;
    let fileRestoreSkipped = false;
    if (mode === "code" || mode === "conversation-and-code") {
      if (point.snapshotId) {
        const n = await this.deps.restoreToSnapshot(point.snapshotId);
        if (n === null) fileRestoreSkipped = true;
        else filesRestored = n;
      } else {
        fileRestoreSkipped = true;
      }
    }

    // mode=code：只回滚文件，对话与回退点原样保留（用户要留着上下文继续/重试）。
    if (mode === "code") {
      return { point, mode, messagesDropped: 0, filesRestored, fileRestoreSkipped };
    }

    // 对话截断：保留 [0, messageIndex) 的消息。
    const msgs = this.deps.getMessages();
    const messagesDropped = Math.max(0, msgs.length - point.messageIndex);
    const truncated = msgs.slice(0, point.messageIndex);
    this.deps.setMessages(truncated);

    // 清理该点及其后的回退点（它们对应的对话已被丢弃）。
    this.points = this.points.filter((p) => p.messageIndex < point.messageIndex);

    return { point, mode, messagesDropped, filesRestored, fileRestoreSkipped };
  }

  /** 清空所有回退点（新会话/clear 时）。 */
  clear(): void {
    this.points = [];
    this.nextId = 1;
  }
}

/** 生成输入预览：单行化 + 截断。 */
function makePreview(input: string): string {
  const oneLine = input.replace(/\s+/g, " ").trim();
  if (oneLine.length <= PREVIEW_MAX) return oneLine;
  return oneLine.slice(0, PREVIEW_MAX - 1) + "…";
}
