/**
 * 循环检测器
 * 检测 agent 陷入无效循环，避免浪费 token
 * 参考 gemini-cli 的两层检测机制
 */

import { createHash } from "node:crypto";
import { getLogger } from "../debug/logger.ts";
import type { Message } from "../llm/types.ts";

/** 循环检测配置 */
export interface LoopDetectionConfig {
  /** 工具调用重复阈值（连续相同调用次数） */
  toolCallThreshold: number;
  /** 内容重复阈值（相同内容块出现次数） */
  contentThreshold: number;
  /** 内容分块大小（字符数） */
  contentChunkSize: number;
  /** 最大恢复尝试次数 */
  maxRecoveryAttempts: number;
  /** 工具 shape 探测循环阈值（同 toolName + 同 key-set 但 value 不同的连续次数） */
  toolShapeThreshold: number;
  /** 工具 shape 滑动窗口大小（最近 N 次内统计 shape 出现次数） */
  toolShapeWindow: number;
  /** 恢复次数耗尽后的处置策略：
   *  - "continue"（默认）：注入最终强提示后**继续放行**，把"停不停"交给模型自己。
   *    真死循环模型会 end_turn / 用户会 ESC / costLimit 会兜底；被误判的正当长任务能存活。
   *    这是"优先保成功、不首先防坏"的取舍——避免一次循环误判废掉跑了几十轮的复杂任务。
   *  - "terminate"：旧行为，耗尽即终止整个任务（防失控优先，弱模型场景可 opt-in 回退）。 */
  recoveryExhaustedAction: "continue" | "terminate";
}

/** 默认配置 */
export const DEFAULT_LOOP_CONFIG: LoopDetectionConfig = {
  toolCallThreshold: 3, // 连续 3 次相同工具调用即触发（之前 5 次过于宽松，模型容易绕开）
  contentThreshold: 10, // 相同内容块出现 10 次
  contentChunkSize: 50, // 50 字符一块
  maxRecoveryAttempts: 3, // 最多恢复 3 次（方案 C-1: 2→3，避免正当任务被一次误判掐死）
  // ADR-020 §2.2 原始值 5/8（62.5%）；差距分析 P1-3 发现该比例对"同 path 下连续多个
  // 不同主题的正当探索"（如系统性 grep 5-6 个不同 symbol）误报率偏高——这类场景与
  // hrn_006（反复变换 pattern 探测同一个不存在字符串）在 shape 层面无法区分，只能靠
  // 放宽窗口/阈值换取更多"免费"探索次数。放宽到 7/10（70%）后，hrn_006 仍能在其
  // max_steps=12 预算内被兜住（第 7 次触发），但常规 5-6 次探索性搜索不再被误杀。
  toolShapeThreshold: 7,
  toolShapeWindow: 10,
  recoveryExhaustedAction: "continue", // 默认继续放行（保成功优先），见字段注释
};

/** 从环境变量解析循环检测配置，未设置的项回退到 DEFAULT_LOOP_CONFIG。
 *  设计意图：阈值不再写死在代码里——用户面对越来越长的任务 / 越来越强的模型时，
 *  可放宽限制而无需改源码（CLAUDE.md「有必要的可以做配置化」）。所有默认值保持现状，
 *  仅在显式设置 env 时覆盖，且对非法值（NaN / ≤0）静默回退默认，绝不因配错而更严。
 *
 *  - SID_LOOP_MAX_RECOVERY        → maxRecoveryAttempts（恢复尝试次数）
 *  - SID_LOOP_TOOL_CALL_THRESHOLD → toolCallThreshold（连续相同调用阈值）
 *  - SID_LOOP_SHAPE_THRESHOLD     → toolShapeThreshold（同 shape 探测阈值）
 *  - SID_LOOP_SHAPE_WINDOW        → toolShapeWindow（shape 滑动窗口）
 *  - SID_LOOP_EXHAUSTED_ACTION    → recoveryExhaustedAction（"terminate" 回退旧的耗尽即终止） */
export function resolveLoopConfig(): LoopDetectionConfig {
  const cfg: LoopDetectionConfig = { ...DEFAULT_LOOP_CONFIG };

  const readPositiveInt = (envName: string): number | undefined => {
    const raw = process.env[envName];
    if (raw === undefined || raw === "") return undefined;
    const n = Number.parseInt(raw, 10);
    // 非法或非正数静默忽略——配错只回退默认，不会让限制变得更严而误杀任务
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  const maxRecovery = readPositiveInt("SID_LOOP_MAX_RECOVERY");
  if (maxRecovery !== undefined) cfg.maxRecoveryAttempts = maxRecovery;

  const toolCall = readPositiveInt("SID_LOOP_TOOL_CALL_THRESHOLD");
  if (toolCall !== undefined) cfg.toolCallThreshold = toolCall;

  const shapeThreshold = readPositiveInt("SID_LOOP_SHAPE_THRESHOLD");
  if (shapeThreshold !== undefined) cfg.toolShapeThreshold = shapeThreshold;

  const shapeWindow = readPositiveInt("SID_LOOP_SHAPE_WINDOW");
  if (shapeWindow !== undefined) cfg.toolShapeWindow = shapeWindow;

  // 仅显式设为 "terminate" 才回退旧的耗尽即终止；其余值（含未设置）一律 continue
  if (process.env.SID_LOOP_EXHAUSTED_ACTION === "terminate") {
    cfg.recoveryExhaustedAction = "terminate";
  }

  return cfg;
}

/** 循环恢复提示词
 *  注：给出**具体**的下一步建议，而不只是"换一种方法"，避免模型反复尝试相同变体。
 *  包裹 <system-reminder> 以被 history-adapter 的 isInternalOnlyText 过滤，
 *  防止此仅供 LLM 的内部提示作为 UserMessage 泄漏到 TUI。 */
export const LOOP_RECOVERY_PROMPT = `<system-reminder>
系统检测到你陷入了非生产性循环——连续多次以等价参数调用同一工具但未取得进展。

请立刻停止当前思路，并按这个顺序处理：
1. **退后一步**：用一句话总结你想达成的目标，以及为什么当前路径无效。
2. **换工具/换粒度**：如果一直在 grep 找不到，换 glob 列文件、或用 read 读 README/index 等总览文件；如果一直在 read 同一文件，尝试 grep 缩小定位范围。
3. **放宽匹配**：grep 没结果时，去掉 path 限定、用更短的 pattern、或加 case_insensitive；read 失败时检查文件是否真的存在（先用 glob/ls）。
4. **诚实兜底**：如果反复确认目标文件/函数不存在，直接告诉用户"未找到"，不要继续无效搜索。

如果你其实在对**同一个文件的不同部分**做合法的分段读取、多点编辑或迭代验证（这是正常的开发行为），请明确说明你的当前进展，然后继续完成剩余工作。只有在反复尝试完全相同的参数却无任何进展时才需要换思路。
</system-reminder>`;

/**
 * P1-3：**同参状态轮询**专用的恢复提示。
 *
 * 为什么不复用 `LOOP_RECOVERY_PROMPT`：那份提示讲的是"换工具/换粒度/放宽匹配"
 * （grep 找不到就换 glob、read 失败就先 ls），全部是**搜索类**建议——对"反复查同一个
 * 后台任务的状态"一条都不适用。给错的建议等于没给建议，模型只会继续轮询。
 *
 * 文案原则（§3.5 第 2 条）：**给出路而非训话。** 所以三条建议都是可直接执行的动作，
 * 且第一条就是本次新增的阻塞等待原语——轮询的根因是"没有阻塞等待手段"，
 * 那么拦下轮询时的第一件事就该是告诉模型这个手段现在有了。
 */
export const LOOP_RECOVERY_POLLING_PROMPT = `<system-reminder>
你已连续多次以**完全相同的入参**查询后台任务状态，且返回的进度没有变化。反复轮询不会让任务更快完成，只会消耗上下文与预算。

请改用下面任一方式：
1. **阻塞等待**（推荐）：\`bg_task_get({ task_id: "...", block: true, timeout: 60000 })\` —— 它会一直等到任务进入终态再返回，你问一次就够。返回的 \`retrieval_status\` 会告诉你是 \`success\`（拿到最终结果）还是 \`timeout\`（还在跑，可以再等）。
2. **先做别的**：去推进**不依赖**该任务产出的部分。任务完成时你会自动收到 \`<task-notification>\`，里面直接带结果正文，不需要你主动查。
3. **确实要放弃**：用 \`task_stop\` 终止它，然后如实告诉用户当前进展和你的判断。

如果你在查询**不同**的任务（入参不同），那不受此限制，照常继续。
</system-reminder>`;

/** 恢复次数耗尽后的「最终提示」（recoveryExhaustedAction = "continue" 时注入）
 *  与 LOOP_RECOVERY_PROMPT 的区别：这是最后一次提醒，语气更重，并明确把"是否停止"的
 *  决定权交还模型——不再由系统强行 return 终止任务。这样真死循环模型会自己 end_turn，
 *  而被误判的正当长任务得以存活，符合「优先保成功、不首先防坏」。
 *  包裹 <system-reminder> 以被 history-adapter 的 isInternalOnlyText 过滤，
 *  防止此仅供 LLM 的内部提示作为 UserMessage 泄漏到 TUI。 */
export const LOOP_RECOVERY_FINAL_PROMPT = `<system-reminder>
系统已多次（达到上限）提示你疑似陷入非生产性循环，但仍检测到等价的重复调用。

这是最后一次提醒，请务必认真对待：
1. **如果你确实卡住了**：停止重复尝试，直接如实告诉用户当前进展、卡在哪里、你判断为什么走不通，由用户决定下一步。不要再用等价参数重复调用同一工具。
2. **如果你在做合法的分段/批量/迭代工作**（不同文件、不同区间、不同编辑点）：用一句话说明当前进展，然后继续完成剩余工作。

系统不会强行终止你——是否继续由你判断。但请不要再无意义地重复同一个无效调用。
</system-reminder>`;

/** 把工具输入规范化为稳定字符串，用于循环检测。
 *  目的：让 {"a":1,"b":2} 和 {"b":2,"a":1} 哈希一致——LLM 输出工具参数顺序经常变化，
 *  原本朴素 JSON.stringify 会把语义相同的调用算成不同 key，导致循环检测被绕过。 */
function canonicalizeToolInput(input: unknown): string {
  return canonicalStringify(input);
}

function canonicalStringify(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonicalStringify).join(",")}]`;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** 工具调用重复检测器 */
export class ToolCallLoopDetector {
  private config: LoopDetectionConfig;
  private lastToolCallKey: string | null = null;
  private repetitionCount = 0;

  constructor(config: LoopDetectionConfig = DEFAULT_LOOP_CONFIG) {
    this.config = config;
  }

  /** 记录一次工具调用，返回是否检测到循环 */
  record(toolName: string, toolInput: unknown): boolean {
    const log = getLogger();

    // 生成工具调用的唯一标识（工具名 + 规范化参数 hash）
    // canonicalizeToolInput 排序对象 key，避免 LLM 调换参数顺序绕过检测
    const inputStr = canonicalizeToolInput(toolInput);
    const hash = createHash("sha256").update(inputStr).digest("hex").slice(0, 16);
    const key = `${toolName}:${hash}`;

    // 方案 C-2: 恢复后给 grace 缓冲，而非立即零容忍
    const grace = this.recoveryGrace.get(key);
    if (grace !== undefined) {
      if (grace > 1) {
        this.recoveryGrace.set(key, grace - 1);
        return false; // 仍在 grace 缓冲期，放过
      }
      // grace 耗尽，删除记录，继续正常检测
      this.recoveryGrace.delete(key);
      // 不 return，继续走下面的正常重复检测逻辑
    }

    if (key === this.lastToolCallKey) {
      this.repetitionCount++;
      log.debug(
        "LOOP_DETECT",
        `工具调用重复: ${toolName}, 计数: ${this.repetitionCount}/${this.config.toolCallThreshold}`,
      );

      if (this.repetitionCount >= this.config.toolCallThreshold) {
        log.warn(
          "LOOP_DETECT",
          `检测到工具调用循环: ${toolName} 连续重复 ${this.repetitionCount} 次`,
        );
        return true;
      }
    } else {
      this.lastToolCallKey = key;
      this.repetitionCount = 1;
    }

    return false;
  }

  /** 重置检测状态（新的用户输入时） */
  reset(): void {
    this.lastToolCallKey = null;
    this.repetitionCount = 0;
    this.recoveryGrace.clear();
  }

  /** 清除检测状态但保留计数（恢复后继续监控）
   *  方案 C-2: 恢复后给 N 次 grace 缓冲，而非之前记录的 key 被零容忍立即触发。
   *  grace 次数 = toolCallThreshold（默认 3），同 key 在 grace 缓冲内重复不会被立即杀。 */
  clearState(): void {
    if (this.lastToolCallKey) {
      this.recoveryGrace.set(this.lastToolCallKey, this.config.toolCallThreshold);
    }
    this.lastToolCallKey = null;
    // 保留 repetitionCount，用于判断是否需要再次恢复
  }

  /** 方案 C-2: 恢复后 grace 缓冲 map（key → 剩余 grace 次数），替代原来的零容忍 Set */
  private recoveryGrace: Map<string, number> = new Map();
}

/** 工具 shape 探测循环检测器（ADR-020 §2.2 落地）
 *  case 来源：hrn_006 — agent 反复 grep 同一 path 但变换 pattern / case_insensitive 等参数
 *  尝试找一个不存在的字符串。
 *  现象：每次参数 value 都不同 → ToolCallLoopDetector 不触发；
 *  但其实是同 shape（toolName + 主结构 key-set + 关键 path/cwd）在反复探测。
 *
 *  策略：
 *  - 对每次工具调用提取一个稳定的 shape key（例如 grep:cwd=/x:keys=case_insensitive,pattern,path）
 *  - 在最近 N 次工具调用滑动窗口内统计同 shape 出现次数
 *  - 出现 ≥ threshold 次即判循环（默认窗口 10 / 阈值 7，见 DEFAULT_LOOP_CONFIG 注释）
 *
 *  与 ToolCallLoopDetector 的关系：互补。ToolCallLoopDetector 看完全相同；
 *  ToolShapeLoopDetector 看"同形状的反复探测"，对参数变体不敏感的探测循环兜底。
 *
 *  已知残余假阳性（差距分析 P1-3）：纯 shape 层面无法区分"反复探测同一个不存在目标"
 *  和"系统性搜索同目录下多个不同 symbol"——两者都是同 toolName + 同 path + 不同 value。
 *  这是 shape 检测固有的精度/召回权衡（CC 选择完全不做此类检测的原因之一）。缓解依赖
 *  两层保护而非试图让 shape 判定本身做到零误报：
 *  1) 阈值/窗口已放宽到给常规 5-6 次探索性搜索留出空间（见上方阈值注释）；
 *  2) 触发后果很轻——recoveryExhaustedAction 默认 "continue"，命中只是注入一条可被
 *     模型说明后忽略的提醒（LOOP_RECOVERY_PROMPT 明确允许"正当分段/多点操作"继续），
 *     不会硬终止任务。误报的代价是一次多余的提醒，不是任务失败。 */
export class ToolShapeLoopDetector {
  private config: LoopDetectionConfig;
  private window: string[] = [];

  constructor(config: LoopDetectionConfig = DEFAULT_LOOP_CONFIG) {
    this.config = config;
  }

  /** 提取工具调用的 shape key —— 反映"在同一目标上重复探测"的语义不变量。
   *  - toolName 进 key
   *  - 顶层对象的 key 集合排序后进 key（结构稳定）
   *  - "锚点字段" path / cwd / file 的 value 进 key（同一目标）
   *  - "分页字段" offset / limit / start_line / end_line / line 的 value 进 key（方案 A：区分翻页与原地探测）
   *  - edit 工具按 old_string hash 区分（方案 B：多点编辑不算循环）
   *  - 其他字段 value 不进 key（让 grep pattern 变化等被算成同 shape） */
  private shapeKey(toolName: string, toolInput: unknown): string {
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
      return `${toolName}:scalar`;
    }
    const obj = toolInput as Record<string, unknown>;
    const keys = Object.keys(obj).sort();

    // 方案 B: edit 工具按 old_string 内容区分 shape —— 改不同地方各算各的
    if (toolName === "edit" && typeof obj.old_string === "string") {
      const editHash = createHash("sha256").update(obj.old_string).digest("hex").slice(0, 8);
      return `${toolName}::file=${obj.file_path ?? "?"}::edit=${editHash}`;
    }

    const anchorFields = ["path", "cwd", "file", "file_path", "dir", "directory"];
    // 方案 A: 分页字段也进 key —— 不同区间是"推进"不是"探测"
    const paginationFields = ["offset", "limit", "start_line", "end_line", "line"];

    const anchors = anchorFields
      .filter((f) => f in obj)
      .map((f) => `${f}=${typeof obj[f] === "string" ? obj[f] : JSON.stringify(obj[f])}`)
      .join("|");
    const pages = paginationFields
      .filter((f) => f in obj)
      .map((f) => `${f}=${typeof obj[f] === "string" ? obj[f] : JSON.stringify(obj[f])}`)
      .join("|");

    return `${toolName}::keys=[${keys.join(",")}]::anchors=${anchors || "(none)"}${pages ? `::pages=${pages}` : ""}`;
  }

  /** 记录一次工具调用，返回是否检测到 shape 循环 */
  record(toolName: string, toolInput: unknown): boolean {
    const log = getLogger();
    const shape = this.shapeKey(toolName, toolInput);

    // 方案 C-2: 恢复后 grace 缓冲，而非立即零容忍
    const graceRemaining = this.recoveryShapeGrace.get(shape);
    if (graceRemaining !== undefined) {
      if (graceRemaining > 1) {
        this.recoveryShapeGrace.set(shape, graceRemaining - 1);
        return false; // 仍在 grace 缓冲期
      }
      this.recoveryShapeGrace.delete(shape);
      // 不 return，继续走正常的滑动窗口检测
    }

    this.window.push(shape);
    if (this.window.length > this.config.toolShapeWindow) {
      this.window.shift();
    }

    let count = 0;
    for (const s of this.window) {
      if (s === shape) count++;
    }

    if (count >= this.config.toolShapeThreshold) {
      log.warn(
        "LOOP_DETECT",
        `检测到工具 shape 探测循环: ${shape} 在 ${this.window.length} 次内出现 ${count} 次`,
      );
      return true;
    }
    return false;
  }

  reset(): void {
    this.window = [];
    this.recoveryShapeGrace.clear();
  }

  /** 方案 C-2: 清除窗口但给最后触发的 shape N 次 grace 缓冲，替代原来的零容忍 */
  clearState(): void {
    if (this.window.length > 0) {
      const last = this.window[this.window.length - 1];
      if (last) this.recoveryShapeGrace.set(last, 3); // 3 次 grace
    }
    this.window = [];
  }

  /** 方案 C-2: 恢复后 grace 缓冲 map（shape → 剩余 grace 次数），替代原来的零容忍 Set */
  private recoveryShapeGrace: Map<string, number> = new Map();
}

/** 内容模式重复检测器 */
export class ContentLoopDetector {
  private config: LoopDetectionConfig;
  private contentHashes: string[] = [];
  private hashCounts = new Map<string, number>();

  constructor(config: LoopDetectionConfig = DEFAULT_LOOP_CONFIG) {
    this.config = config;
  }

  /** 记录一次 LLM 输出，返回是否检测到循环 */
  record(text: string): boolean {
    const log = getLogger();

    // 将文本分块并计算 hash
    const chunks = this.chunkText(text, this.config.contentChunkSize);
    const hashes = chunks.map((chunk) =>
      createHash("sha256").update(chunk).digest("hex").slice(0, 16),
    );

    // 更新 hash 计数
    for (const hash of hashes) {
      const count = (this.hashCounts.get(hash) || 0) + 1;
      this.hashCounts.set(hash, count);

      // 检测是否有 hash 出现次数超过阈值
      if (count >= this.config.contentThreshold) {
        log.warn("LOOP_DETECT", `检测到内容循环: 相同内容块出现 ${count} 次`);
        return true;
      }
    }

    // 保存 hash 到滑动窗口（限制窗口大小，避免内存膨胀）
    this.contentHashes.push(...hashes);
    const maxWindowSize = 1000;
    if (this.contentHashes.length > maxWindowSize) {
      const removed = this.contentHashes.splice(0, this.contentHashes.length - maxWindowSize);
      // 清理被移除的 hash 计数
      for (const hash of removed) {
        const count = this.hashCounts.get(hash);
        if (count !== undefined) {
          if (count <= 1) {
            this.hashCounts.delete(hash);
          } else {
            this.hashCounts.set(hash, count - 1);
          }
        }
      }
    }

    return false;
  }

  /** 重置检测状态 */
  reset(): void {
    this.contentHashes = [];
    this.hashCounts.clear();
  }

  /** 清除检测状态但保留计数 */
  clearState(): void {
    // 内容检测器清空窗口，但保留 hashCounts 用于继续监控
    this.contentHashes = [];
  }

  /** 将文本分块 */
  private chunkText(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
  }
}

/** LLM 认知检测配置 */
const LLM_CHECK_AFTER_TURNS = 30;
const LLM_CHECK_INTERVAL = 10;
const LLM_CONFIDENCE_THRESHOLD = 0.9;

/** LLM 认知检测提示词 */
export const LOOP_DETECTION_PROMPT = `你是一个对话模式分析器。判断 AI 助手是否陷入了非生产性循环。

区分：
- 生产性重复：跨文件批量操作（不同文件路径）、增量编辑 → 不是循环
- 非生产性循环：语义等价的重复调用、反复尝试相同方案 → 是循环

返回 JSON：{ "is_loop": boolean, "confidence": number, "reason": string }`;

/** LLM 认知检测结果 */
export interface LLMLoopCheckResult {
  is_loop: boolean;
  confidence: number;
  reason: string;
}

/** 豁免工具集合：这些工具的连续调用是合法的并发/分派行为，不应被判定为循环
 *  - sub_agent: 每次 description/prompt 不同，hash 必然不同，但 shape detector 可能误判
 *  - task_output/task_stop/task_list/send_message: 任务管理/通信工具，操作不同 task/代理
 *  - todo_write: 状态更新工具，内容自然变化
 *  - enter_plan_mode/exit_plan_mode: 模式切换工具
 *
 *  ⚠️ P2-3（豁免白名单维护机制）：本集合是循环检测豁免的**运行时事实源**，但它不再是
 *  唯一事实源——每个应豁免的工具在自身定义处（*.ts 类字段）自报 `exemptFromLoopDetection
 *  = true`（见 src/tool/types.ts ToolCapabilityFields.exemptFromLoopDetection 的豁免标准）。
 *  两侧由 `tests/agent/loop-detection-exemption-audit.test.ts` **双向对账**：
 *    - 工具自报豁免但此集合缺失 → 审计测试失败（提醒把新工具加进这里）
 *    - 此集合列了某名但没有工具自报（或拼错） → 审计测试失败（提醒清理/纠错）
 *  这样"新增工具时忘记评估豁免"从静默漂移变成 CI 可见的硬错误。
 *  修改本集合时，务必同步在对应工具类上增删 `exemptFromLoopDetection` 字段。 */
export const EXEMPT_TOOLS = new Set([
  "sub_agent",
  "task_output",
  "task_stop",
  "send_message",
  "todo_write",
  "enter_plan_mode",
  "exit_plan_mode",
  "bg_task_list",
  "bg_task_get",
  // 结构化任务清单：连续 create/update/list 是正当的清单维护而非循环
  "task_create",
  "task_update",
  "task_list",
  "task_get",
  // P1-3 团队通信：连续给不同成员发消息是正当的协作编排（与 send_message 同理）
  "team_message",
]);

/**
 * P1-3：**有条件**豁免的状态查询类工具——豁免只覆盖它声称的那个语义。
 *
 * ## 病灶：豁免的语义前提没错，但实现是无条件的
 *
 * 这三个工具原本的豁免理由是"连续查询**不同**后台任务是正当轮询"——**理由本身成立**。
 * 但实现是 `EXEMPT_TOOLS.has(name) → return false`，于是：入参完全相同（`{}`）、
 * 返回体除时间戳外无变化的**49 次**调用同样被放过（实测 2026-08-11 会话，
 * 占全部工具调用 18.8%，间隔约 5.7s，进度字段纹丝不动）。
 *
 * ```
 * 13:51:59  <progress tools="17" tokens="169174">  last_activity: read ink.d.ts
 * 13:52:03  <progress tools="17" tokens="169174">  last_activity: read ink.d.ts   ← 无变化
 * 13:52:08  <progress tools="17" tokens="169174">  last_activity: read ink.d.ts   ← 无变化
 * ```
 *
 * ## 收窄后的判据：**入参不同才豁免**
 *
 * - 入参**不同** → 豁免（这才是"查询不同任务"的真实形态）；
 * - 入参**相同**且连续达 `toolCallThreshold` 次 → 交给正常循环检测拦下。
 *
 * 为什么不直接把它们从 EXEMPT_TOOLS 移除：移除后 shape detector 也会开始管它们，
 * 而 `bg_task_get({task_id:"a"})` / `bg_task_get({task_id:"b"})` 是**同 shape 不同 value**
 * 的典型形态——那正是 shape detector 会误判的东西。收窄成"按入参判"既拦住同参轮询，
 * 又不会误杀"轮流查 3 个子代理"这种正当行为。
 *
 * ⚠️ 改这个集合时必须同步 `EXEMPT_TOOLS` 与对应工具类的 `exemptFromLoopDetection` 字段
 * （见上方 EXEMPT_TOOLS 的 P2-3 说明与 `tests/agent/loop-detection-exemption-audit.test.ts`
 * 的双向对账）——本集合是 EXEMPT_TOOLS 的**子集**，不是平行名单。
 */
export const CONDITIONALLY_EXEMPT_TOOLS = new Set(["bg_task_list", "bg_task_get", "task_output"]);

/** 循环检测器（组合工具调用和内容检测） */
export class LoopDetector {
  private config: LoopDetectionConfig;
  private toolCallDetector!: ToolCallLoopDetector;
  private toolShapeDetector!: ToolShapeLoopDetector;
  private contentDetector!: ContentLoopDetector;
  private recoveryAttempts = 0;
  private turnCount = 0;
  private lastLLMCheckTurn = 0;
  /** 循环检测是否已禁用（默认全局关闭对齐 CC，仅 SID_ENABLE_LOOP_DETECTION=1 可显式开启） */
  private _disabled = false;

  constructor(config: LoopDetectionConfig = resolveLoopConfig()) {
    if (!isLoopDetectionEnabled()) {
      this._disabled = true;
      this.config = config;
      return;
    }
    this.config = config;
    this.toolCallDetector = new ToolCallLoopDetector(config);
    this.toolShapeDetector = new ToolShapeLoopDetector(config);
    this.contentDetector = new ContentLoopDetector(config);
  }

  /**
   * P1-3：最近一次触发循环判定的**成因**。
   *
   * 存在的唯一目的是让恢复提示能选对文案：同参状态轮询要给"改用阻塞等待"，
   * 而搜索类死循环要给"换工具/放宽匹配"。此前只有一个布尔返回值，调用方
   * 无法分辨，只能一律注入搜索类建议——对轮询场景一条都不适用（见
   * LOOP_RECOVERY_POLLING_PROMPT 注释）。
   */
  private _lastTrigger: "polling" | "generic" | null = null;

  /**
   * 上一次 `recordToolCall` 返回 true 时的成因。null 表示尚未触发过。
   * 调用方据此在 `LOOP_RECOVERY_POLLING_PROMPT` 与 `LOOP_RECOVERY_PROMPT` 之间选择。
   */
  get lastTrigger(): "polling" | "generic" | null {
    return this._lastTrigger;
  }

  /** 记录工具调用，返回是否检测到循环（任一检测器命中即触发） */
  recordToolCall(toolName: string, toolInput: unknown): boolean {
    if (this._disabled) return false;
    // P1-3：状态查询类工具改为**有条件**豁免——入参不同才放过（见
    // CONDITIONALLY_EXEMPT_TOOLS 注释：无条件豁免会把 49 次同参 `{}` 轮询一起放过）。
    // 只走精确检测（exact）不走 shape：同 shape 不同 value 正是"轮流查多个任务"的
    // 正当形态，交给 shape detector 会误杀。
    if (CONDITIONALLY_EXEMPT_TOOLS.has(toolName)) {
      const hit = this.toolCallDetector.record(toolName, toolInput);
      if (hit) this._lastTrigger = "polling";
      return hit;
    }
    // 豁免工具：合法并发/分派行为不应被判定为循环
    if (EXEMPT_TOOLS.has(toolName)) return false;
    const exact = this.toolCallDetector.record(toolName, toolInput);
    const shape = this.toolShapeDetector.record(toolName, toolInput);
    const hit = exact || shape;
    if (hit) this._lastTrigger = "generic";
    return hit;
  }

  /** 记录内容输出，返回是否检测到循环 */
  recordContent(text: string): boolean {
    if (this._disabled) return false;
    return this.contentDetector.record(text);
  }

  /** 记录一轮对话 */
  recordTurn(): void {
    if (this._disabled) return;
    this.turnCount++;
  }

  /** 是否应该运行 LLM 认知检测 */
  shouldRunLLMCheck(): boolean {
    if (this._disabled) return false;
    if (this.turnCount < LLM_CHECK_AFTER_TURNS) return false;
    if (this.turnCount - this.lastLLMCheckTurn < LLM_CHECK_INTERVAL) return false;
    this.lastLLMCheckTurn = this.turnCount;
    return true;
  }

  /** 构建 LLM 认知检测提示词 */
  buildLLMCheckPrompt(recentMessages: Message[]): string {
    if (this._disabled) return "";
    const toolCalls: string[] = [];
    for (const msg of recentMessages) {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolCalls.push(`${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
        }
      }
    }
    return `${LOOP_DETECTION_PROMPT}\n\n最近的工具调用序列：\n${toolCalls.join("\n")}`;
  }

  /** 处理 LLM 认知检测结果 */
  processLLMResult(result: LLMLoopCheckResult): boolean {
    if (this._disabled) return false;
    const log = getLogger();
    if (result.is_loop && result.confidence >= LLM_CONFIDENCE_THRESHOLD) {
      log.warn("LOOP_DETECT", `LLM 认知检测: ${result.reason} (置信度: ${result.confidence})`);
      return true;
    }
    return false;
  }

  /** 重置所有检测状态（新的用户输入时） */
  reset(): void {
    if (this._disabled) return;
    this.toolCallDetector.reset();
    this.toolShapeDetector.reset();
    this.contentDetector.reset();
    this.recoveryAttempts = 0;
    this.turnCount = 0;
    this.lastLLMCheckTurn = 0;
  }

  /** 耗尽后继续放行时的软重置：清空各 detector 窗口 + 归零 recoveryAttempts，
   *  但**保留 turnCount**（真实轮次不应因循环恢复而清零，否则打乱 LLM 认知检测节奏）。
   *  用于 recoveryExhaustedAction = "continue"：注入最终提示后让检测器回到干净状态，
   *  避免下一轮立刻又判耗尽而反复刷屏；真死循环会重新累积、再次提示，但永不终止任务。 */
  softResetForContinue(): void {
    if (this._disabled) return;
    this.toolCallDetector.reset();
    this.toolShapeDetector.reset();
    this.contentDetector.reset();
    this.recoveryAttempts = 0;
  }

  /** 尝试恢复，返回是否可以继续（未超过最大恢复次数） */
  tryRecover(): boolean {
    if (this._disabled) return true;
    const log = getLogger();
    this.recoveryAttempts++;

    if (this.recoveryAttempts > this.config.maxRecoveryAttempts) {
      log.warn("LOOP_DETECT", `恢复次数已达上限 (${this.config.maxRecoveryAttempts})，终止循环`);
      return false;
    }

    log.info(
      "LOOP_DETECT",
      `尝试恢复 (${this.recoveryAttempts}/${this.config.maxRecoveryAttempts})`,
    );

    // 清除检测状态但保留计数
    this.toolCallDetector.clearState();
    this.toolShapeDetector.clearState();
    this.contentDetector.clearState();

    return true;
  }

  /** 获取当前恢复尝试次数 */
  getRecoveryAttempts(): number {
    return this._disabled ? 0 : this.recoveryAttempts;
  }

  /** 获取最大恢复次数 */
  getMaxRecoveryAttempts(): number {
    return this._disabled ? 0 : this.config.maxRecoveryAttempts;
  }

  /** 恢复次数耗尽后是否应继续放行（而非终止任务）。
   *  默认 "continue"——把"停不停"交给模型自己，优先保成功。 */
  shouldContinueAfterExhausted(): boolean {
    if (this._disabled) return true;
    return this.config.recoveryExhaustedAction !== "terminate";
  }

  /** 获取当前轮次数 */
  getTurnCount(): number {
    return this._disabled ? 0 : this.turnCount;
  }
}

/** 检查循环检测是否启用（默认全局关闭；仅 SID_ENABLE_LOOP_DETECTION=1 显式开启）。
 *
 *  为什么默认关闭（2026-07-07 决策，推翻此前 P0-1 的"默认全局启用"）：
 *  **主依据是实测误判率，不是"对齐 CC"这个类比**（类比只是旁证，见文末）。
 *  启发式循环检测（尤其 ToolShapeLoopDetector）存在**结构性、无法根治的误判**。
 *  shape 检测把工具调用降维成"toolName + key-set + anchor 字段"的形状指纹，故意丢弃
 *  参数 value——这让它天然无法区分两类语义相反的行为：
 *    - 真死循环："反复用不同 pattern 探测同一个不存在的目标"
 *    - 正当推进："系统性操作同类目标下的多个不同对象"（如 /commit 连跑 git diff/add/
 *      commit/log、系统性 grep 多个不同 symbol、连续跑测试/构建命令）
 *  对 bash 尤其严重：bash 的 command 值不进 shape key、又没有 path/cwd 等 anchor 字段，
 *  于是**所有 bash 调用的 shape key 全退化成同一个字符串**，检测器实际变成"滑动窗口内
 *  bash 调用数 ≥ 阈值就误判循环"，完全无视命令内容。真实案例：session 38428f6e 执行
 *  /commit 时，一串完全不同的 git 命令被判为"bash shape 探测循环"，反复注入恢复提示刷屏。
 *
 *  **实测证据（2026-07-14，scripts/loop-detection-probe.ts + loop-stats-probe.ts）**：
 *    - 探针：8 条语义完全不同的 bash 命令（git status / rm -rf / release.sh …）shape key
 *      全部塌成同一串 `bash::keys=[command]::anchors=(none)`——退化实锤。
 *    - 回放 42 个真实会话：模拟开 shape 检测有 14 个会话命中，抽样 14/14 全是
 *      "git status→diff→log 巡检 / 发布流程 / 系统性 glob"等正当操作——**会话级误判率≈100%**。
 *    - 模拟开 exact 检测仅 1/42 命中，且唯一命中还是低危的 commit 后 status 轮询——**召回≈0**。
 *  两个检测器都拿不到净收益，这是"默认关闭"的**决定性依据**。
 *
 *  旁证（非主依据）：Claude Code 源码也**不做**任何 agent 工具调用循环检测（已核实，
 *  见官方 issue #4277 是"请求新增"检测的 feature request）。但注意 CC 敢不做的前提是
 *  它只跑自家强模型；接入弱模型（如 deepseek-v4-pro）时不能仅凭"对齐 CC"照搬关闭——
 *  真正的兜底是 costLimit/轮次上限/用户 ESC，**而交互模式下 maxTurns 默认 Infinity、
 *  costLimit 默认不设**（loop.ts 的 `config.maxTurns || Infinity`），关掉检测后交互模式
 *  实际只剩用户 ESC 一根兜底。需要重开检测的弱模型场景，用下面的 env 门控显式开启。
 *
 *  代码不删除、仅默认关闭（env 门控），保留可逆性：通过 SID_ENABLE_LOOP_DETECTION=1
 *  可为特定场景（如接入行为不稳定的弱模型）显式开启。 */
export function isLoopDetectionEnabled(): boolean {
  return process.env.SID_ENABLE_LOOP_DETECTION === "1";
}
