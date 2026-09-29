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
  /**
   * 本轮**首个**快照 id（空串 = 本轮至今没建过快照，仅能回退对话）。
   *
   * ⚠️ N6：这里必须是「本轮自己的快照」，**不是登记时刻的最新快照**。
   *
   * 口径（与 CheckpointManager 单一真相源一致）：快照 sN 存的是「产生 sN 那次工具调用
   * **之前**」的内容 ⇒ 「回到第 N 轮之前」= `restoreToSnapshot(第 N 轮的首个快照)`。
   *
   * 修之前在 `registerPoint` 里取 `getLatestSnapshotId()`，而 `registerPoint` 跑在
   * **用户输入提交前**、本轮快照还不存在，拿到的是**上一轮**建的快照 ⇒ 回退多撤一整轮
   * （第 N-1 轮的正确改动被一起回滚）；回退到第 1 轮时更是恒为空串 ⇒
   * 文件层永远不回滚（最想撤的那次恰恰撤不掉）。
   *
   * 所以改为**回填**：登记时留空，本轮首个快照建成时由 `attachSnapshot()` 补上。
   */
  snapshotId: string;
  /** 用户输入预览（截断展示用）。 */
  inputPreview: string;
  /**
   * N7：对话锚点是否已失效。`messageIndex` 是**数组下标**，而压缩会整体重排消息数组
   * （40 条 → 8 条），下标指向的坐标系当场不存在。压缩发生时由 `onMessagesCompacted()`
   * 把登记在压缩之前的点全部置 true。失效的点**仍可做 `code` 回退**（文件锚点是快照 id，
   * 与消息数组无关），只是不能再截断对话。
   */
  conversationStale: boolean;
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
  /**
   * N7：对话锚点已失效（压缩过 / 下标越界），本次**什么都没做**——对话未截断、文件未回滚、
   * 回退点全部保留。修之前这种情况会 `slice(0, 越界下标)` 原样写回（静默空转），
   * 还按「已丢弃未来」把回退点全清掉。
   */
  conversationUnavailable?: boolean;
}

/** 注入依赖：解耦 ctxMgr / checkpoint 具体实现，便于测试。 */
export interface RewindDeps {
  /** 取当前对话消息数组（用于登记时算下标、回退时截断）。 */
  getMessages: () => unknown[];
  /** 整体替换对话消息（截断后写回）。 */
  setMessages: (msgs: unknown[]) => void;
  /** 回滚文件到指定快照，返回受影响文件数（未启用/无快照返回 null）。 */
  restoreToSnapshot: (snapshotId: string) => Promise<number | null>;
  // N6：原有的 `getLatestSnapshotId` 已移除。它此前的唯一用途是在 registerPoint 里取文件锚点，
  // 而那正是缺陷所在（登记时刻本轮快照还不存在，取到的是上一轮的）。锚点改走 attachSnapshot()
  // 回填后它就零调用了——留着等于新造一个「只写不读」的注入项（文档 N8 批评的同一形态）。
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
      // N6：登记时刻本轮快照还不存在（registerPoint 跑在输入提交前，快照在工具执行前才建），
      // 所以这里留空、由 attachSnapshot() 在本轮首个快照建成时回填。
      // 取 getLatestSnapshotId() 会拿到**上一轮**的快照 ⇒ 回退多撤一整轮，见 RewindPoint.snapshotId。
      snapshotId: "",
      inputPreview: makePreview(userInput),
      conversationStale: false,
      timestamp: nowMs,
    };
    this.points.push(point);
    // 环形上限：超出则丢最旧。
    if (this.points.length > MAX_REWIND_POINTS) {
      this.points.splice(0, this.points.length - MAX_REWIND_POINTS);
    }
    return point;
  }

  /**
   * N6：把刚建成的快照 id 回填为**当前轮**回退点的文件锚点。
   *
   * 由 CheckpointManager 的 onSnapshotCreated 回调驱动（app.ts 接线）。
   * 只回填最新那个回退点、且**只认第一个**——本轮可能建多个快照（多次工具调用），
   * 而「回到本轮之前」要回滚到本轮**首个**快照（它记录的才是本轮任何改动发生前的状态）。
   * 后续快照直接忽略，所以这个方法是幂等的。
   *
   * 没有回退点时（非交互入口、或快照发生在首次登记之前）静默忽略：
   * 文件锚点缺失只会让该点退化为"仅能回退对话"，不该反过来影响快照创建。
   */
  attachSnapshot(snapshotId: string): void {
    if (!snapshotId) return;
    const current = this.points[this.points.length - 1];
    if (!current) return;
    if (current.snapshotId) return; // 本轮已有锚点 ⇒ 保留首个
    current.snapshotId = snapshotId;
  }

  /**
   * N7：消息数组被压缩重排后调用（app.ts 经 compactObserver 接线）。
   *
   * 为什么是「作废」而不是「重映射」：压缩把旧消息换成摘要，被摘要掉的那些轮次已不存在，
   * 没有可映射的目标；而幸存的尾部消息在新数组里的位置取决于摘要+ack 的注入条数，
   * 按偏移推算是在猜。猜错的代价是截掉用户不想丢的消息，比明确拒绝更坏。
   * 压缩之后登记的新点不受影响（它们的下标就在新坐标系里）。
   */
  onMessagesCompacted(): void {
    for (const p of this.points) p.conversationStale = true;
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

    // N7：涉及对话的回退，先校验对话锚点还有效。越界判据是兜底——即便某条改写消息数组的
    // 路径没通知 onMessagesCompacted，下标超出当前长度也足以说明坐标系已变。
    // 失效时整次操作不执行（连文件也不回滚）：「对话+代码」只做一半会让两者错位，
    // 用户看到的结果与选择的档位对不上。
    if (mode !== "code") {
      const len = this.deps.getMessages().length;
      if (point.conversationStale || point.messageIndex > len) {
        return {
          point,
          mode,
          messagesDropped: 0,
          filesRestored: 0,
          fileRestoreSkipped: true,
          conversationUnavailable: true,
        };
      }
    }

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
