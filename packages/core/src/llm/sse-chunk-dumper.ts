/**
 * SSE 逐 chunk 采样落盘（5.2，deepseek-reasoning-leak 修复）
 *
 * 背景：raw.jsonl 只存聚合后的 response 对象，逐 chunk 原始 SSE 流没有落盘。排查
 * "第 N 轮思考到底走哪个字段（reasoning_content vs content）、哪个 chunk 开始从
 * reasoning_content 切到 content、有没有 error/finish chunk" 时无从下手，只能靠聚合
 * 结果反推。这正是文档 5.2 的采集缺口。
 *
 * 设计（严格控制体积——本会话 raw.jsonl 已 423KB，不能无脑全量落盘）：
 * - 仅在 SID_CODE_DEBUG_SSE_DUMP=1 时启用（默认关闭，零开销）。
 * - 有界环形采样：保留 **首 N** + **尾 N** 个 chunk；中间 chunk 丢弃但计数。
 * - **关键 chunk 永远保留**（不占 head/tail 名额）：
 *     · error chunk（chunk.error 存在）
 *     · finish chunk（finish_reason 非空）
 *     · **通道切换 chunk**（reasoning_content ↔ content 的首次切换点）——这是定位
 *       "思考漂移进正文"的决定性证据，必须无条件留下。
 * - 每条流结束时 flush 成 trajectories/sse-dumps/<sessionId>/<index>.jsonl 一行一 chunk。
 *
 * 落点：provider 的 parseSSE 已能拿到每个原始 chunk（JSON.parse 后），在那里喂给本模块。
 */

import { join } from "node:path";
import { mkdirSync, existsSync, appendFileSync } from "node:fs";
import { sidHomePath } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";
import { getRequestContext } from "./request-context.ts";

/** 单个采样 chunk 的落盘格式 */
interface DumpedChunk {
  /** 该 chunk 在流中的序号（从 0 起，含被丢弃的） */
  seq: number;
  /** 相对流开始的毫秒偏移 */
  t: number;
  /** 该 chunk 承载的通道：reasoning / content / tool / finish / error / other */
  ch: "reasoning" | "content" | "tool" | "finish" | "error" | "other";
  /** 原始 chunk（JSON.parse 后的对象），大字段不截断——排查需要完整原文 */
  raw: unknown;
  /** 保留原因：head / tail / error / finish / transition */
  keep: "head" | "tail" | "error" | "finish" | "transition";
}

/** 头尾各保留多少个 chunk（关键 chunk 额外无条件保留，不占此名额） */
const HEAD_KEEP = 8;
const TAIL_KEEP = 12;

/**
 * 环境上下文（sessionId + turnIndex + loopId）。
 *
 * provider 的 parseSSE 拿不到 sessionId/turnIndex（不在其参数里），逐层透传对一个
 * 默认关闭的 debug 采集功能而言过重。改用模块级环境变量：主循环在每次发请求前
 * setSseDumpContext，parseSSE new 采样器时读取。未设置时采样器退化为空转。
 *
 * loopId（Fix 1）：每次 queryLoop 分配唯一 ID，用于 snapshot namespace 隔离，
 * 防止跨 queryLoop 的孤儿 generator 写入脏数据污染新循环的看门狗。
 */
let ambientCtx: { sessionId?: string; turnIndex: number; loopId: string } = {
  turnIndex: 0,
  loopId: "default",
};

/** 主循环在每轮 sendWithRetry 前调用，登记当前会话 id、轮次与 loopId。 */
export function setSseDumpContext(
  sessionId: string | undefined,
  turnIndex: number,
  loopId?: string,
): void {
  ambientCtx = { sessionId, turnIndex, loopId: loopId ?? ambientCtx.loopId };
}

/**
 * parseSSE 内构造采样器时读取当前环境上下文。
 *
 * ## PR2：优先读请求级 ALS 身份，其次才是这个模块级全局量
 *
 * 上面那个 `ambientCtx` **只有主循环写**（全仓唯一调用点 `query/loop.ts`）。
 * 于是 fork / 子代理 / side-call 发的流全都继承主循环最后登记的 `turnIndex`，
 * 与主循环共用同一个 attempt 计数器 —— 实测两个 fork 的 7 个流全落在 `index=17` 上，
 * attempt 涨到 8，在轨迹里长得就像"一个请求重试了 8 次"。
 *
 * 现在改成：有 ALS 身份就用它（`withRequestContext` 包过的路径），
 * 没有则原样返回 `ambientCtx`。**主循环不进 ALS，行为逐字节不变。**
 *
 * `agentId` 也一并透出：`emitStreamPhase` / `emitTimeoutFired` 早就支持这个第三维，
 * 只是 provider 侧一直拿不到它，于是永远传不进去（能力在、接线断）。
 */
export function currentSseDumpContext(): {
  sessionId?: string;
  turnIndex: number;
  loopId: string;
  agentId?: string;
  callerLabel?: string;
} {
  const req = getRequestContext();
  if (req) {
    return {
      sessionId: req.sessionId ?? ambientCtx.sessionId,
      turnIndex: req.turnIndex,
      // loopId 缺省沿用全局量：fork 属于同一个 queryLoop 的生命周期，
      // 换 namespace 会让 `clearAllSnapshots(loopId)` 收不到它的快照（泄漏）。
      loopId: req.loopId ?? ambientCtx.loopId,
      agentId: req.agentId,
      callerLabel: req.callerLabel,
    };
  }
  return ambientCtx;
}

/** 判断一个原始 SSE chunk 主要承载的通道 */
function classifyChunk(raw: any): DumpedChunk["ch"] {
  if (raw?.error) return "error";
  const delta = raw?.choices?.[0]?.delta;
  const finish = raw?.choices?.[0]?.finish_reason;
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0)
    return "reasoning";
  if (typeof delta?.content === "string" && delta.content.length > 0) return "content";
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) return "tool";
  if (finish) return "finish";
  return "other";
}

/**
 * 一条 SSE 流的 chunk 采样器。每条流一个实例（parseSSE 内 new 一个）。
 * 未启用时所有方法都是空转（record 直接 return），零开销。
 */
export class SseChunkDumper {
  private readonly enabled: boolean;
  private seq = 0;
  private readonly startAt: number;
  private readonly head: DumpedChunk[] = [];
  private readonly tail: DumpedChunk[] = [];
  private readonly keyChunks: DumpedChunk[] = []; // error / finish / transition
  private droppedMiddle = 0;
  /** 上一个承载"实质内容"的通道，用于检测 reasoning↔content 切换 */
  private lastContentCh: "reasoning" | "content" | null = null;

  constructor(
    private readonly sessionId: string | undefined,
    private readonly turnIndex: number,
    startAt: number,
  ) {
    // 仅显式开启 + 有 sessionId 时启用
    this.enabled = process.env.SID_CODE_DEBUG_SSE_DUMP === "1" && !!sessionId;
    this.startAt = startAt;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 记录一个已 JSON.parse 的原始 chunk */
  record(raw: unknown): void {
    if (!this.enabled) return;
    const seq = this.seq++;
    const ch = classifyChunk(raw);

    // 通道切换检测：只在承载实质内容的 reasoning/content 间切换时判定 transition
    let isTransition = false;
    if (ch === "reasoning" || ch === "content") {
      if (this.lastContentCh !== null && this.lastContentCh !== ch) {
        isTransition = true;
      }
      this.lastContentCh = ch;
    }

    const base = { seq, t: Date.now() - this.startAt, ch, raw };

    // 关键 chunk 无条件保留（不占 head/tail 名额）
    if (ch === "error") {
      this.keyChunks.push({ ...base, keep: "error" });
      return;
    }
    if (ch === "finish") {
      this.keyChunks.push({ ...base, keep: "finish" });
      return;
    }
    if (isTransition) {
      this.keyChunks.push({ ...base, keep: "transition" });
      return;
    }

    // 普通 chunk：头 N 个进 head，其余滚动进 tail（环形，超出丢弃并计数）
    if (this.head.length < HEAD_KEEP) {
      this.head.push({ ...base, keep: "head" });
      return;
    }
    this.tail.push({ ...base, keep: "tail" });
    if (this.tail.length > TAIL_KEEP) {
      this.tail.shift();
      this.droppedMiddle++;
    }
  }

  /** 流结束时 flush 到磁盘。失败仅告警不抛（采集不影响正常使用）。 */
  flush(): void {
    if (!this.enabled) return;
    try {
      const dir = sidHomePath("trajectories", "sse-dumps", this.sessionId!);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file = join(dir, `turn-${this.turnIndex}.jsonl`);
      // 首行 meta：总 chunk 数、丢弃数、各通道分布，便于快速判断是否发生漂移
      const meta = {
        _meta: true,
        sessionId: this.sessionId,
        turnIndex: this.turnIndex,
        totalChunks: this.seq,
        droppedMiddle: this.droppedMiddle,
        keyChunkCount: this.keyChunks.length,
        hasChannelTransition: this.keyChunks.some((c) => c.keep === "transition"),
      };
      // 按 seq 归并输出：head → keyChunks（穿插）→ tail，保留时间顺序
      const all = [...this.head, ...this.keyChunks, ...this.tail].sort((a, b) => a.seq - b.seq);
      const lines = [JSON.stringify(meta), ...all.map((c) => JSON.stringify(c))];
      appendFileSync(file, lines.join("\n") + "\n");
    } catch (err) {
      getLogger().warn("SSE_DUMP", `flush SSE chunk 采样失败: ${err}`);
    }
  }
}
