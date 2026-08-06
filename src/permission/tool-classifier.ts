/**
 * 泛化工具安全分类器（auto 权限模式核心）
 *
 * 基于 BashClassifier 结构扩展,可判断任意工具调用的安全性。
 * - Bash 命令仍走 BashClassifier 的专用 prompt（更精准）
 * - 非 bash 工具走泛化 prompt
 *
 * 推理盲设计：
 * - 不传模型的 description（这是模型自己提供的理由,可能被措辞说服）
 * - 不传 recentContext
 * - 只传: toolName、input（原始参数）、cwd
 */

import type { Provider } from "../llm/provider.ts";
import type { Message, ContentBlock } from "../llm/types.ts";
import { getLogger } from "../debug/logger.ts";
import { recordSideCall } from "../trace/side-call-sink.ts";
import { SIDE_CALL_NO_THINK } from "../llm/side-call-timeout.ts";
import { SIDE_CALL_TIMEOUT_REASON } from "../llm/errors.ts";

/** 风险等级 */
export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

/** 泛化分类请求（推理盲：不含 description / recentContext） */
export interface ToolClassifyRequest {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  signal?: AbortSignal;
  /**
   * G7：工具自报的"精简语义视图"（来自 Tool.toAutoClassifierInput）。
   * - 非空字符串：优先作为分类器输入（替代原始 input，降噪 + 聚焦风险片段）
   * - 空字符串 ""：工具声明与安全无关，分类器直接判安全跳过 LLM
   * - undefined：无自定义视图，分类器回退原始 input
   */
  classifierInput?: string;
}

/** 分类结果 */
export interface ToolClassifyResult {
  /** true = 允许执行（仅当解析成功且模型判定安全时为 true） */
  safe: boolean;
  /** 风险等级 */
  risk: RiskLevel;
  /** 判断理由 */
  reason: string;
  /** true 表示分类器不可用（调用方回退到人工确认） */
  classifierUnavailable?: boolean;
  /** 分类耗时（毫秒） */
  latencyMs?: number;
}

/** 分类器配置 */
export interface ToolClassifierConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 使用的模型（默认复用主模型） */
  model?: string;
  /** 超时（毫秒，默认 8000） */
  timeoutMs?: number;
  /** 最大输出 token（默认 512） */
  maxTokens?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_TOKENS = 512;

/** 三级快速路径：这些工具在工作区内操作时无需调 API
 *
 * ⚠️ 判据是「**工作区内**无外部副作用」——网络出站工具不满足此条，**不得**加入本表。
 * 2026-08-07（SEC-AUDIT-2026-07-19 P1-2 收尾）：`web_fetch` / `web_search` 曾在此表内，
 * 与 checker 的 READ_ONLY_TOOLS 构成两条并行的自动放行路径。当时 ToolClassifier 尚未接线
 * （`setToolClassifier` 无生产调用方），本表形同死代码，故上一轮只摘了 checker 一侧；
 * 此后 `cli.ts:1939-1945` 接线生效，本表复活成**绕过 P1-2 修复的活路径**——
 * `permissionMode === "auto"` 下 web_fetch 会在 Level 1 拿到 `safe: true` 直接放行，
 * 让「网络出站需人类把关」的契约在 auto 模式下静默失效。
 * 教训：**摘除自动放行必须把所有并行路径一次摘干净**，"那条现在是死代码"不是留它的理由。
 */
const AUTO_ALLOW_TOOLS = new Set([
  "read", "read_many", "glob", "grep", "ls", "ripgrep",
  "bg_task_list", "bg_task_get",
  // 结构化任务清单：纯内存态清单读写，无外部副作用，工作区内自动放行
  "task_list", "task_get", "task_create", "task_update",
]);

/** 工具在工作区内执行 write/edit 时自动放行 */
const ACCEPT_EDITS_TOOLS = new Set(["write", "edit"]);

const SYSTEM_PROMPT = `你是一个安全分析引擎。分析以下工具调用，判断它是否安全执行。

判断标准：
- safe=true：操作范围在工作区内、无外部副作用、不涉及敏感路径/凭证
- safe=false：删除/修改系统文件、访问敏感路径(~/.ssh, ~/.aws等)、网络外联下载执行、提权操作

严格输出 JSON，不要输出其他内容：
{"safe": true/false, "risk": "none/low/medium/high/critical", "reason": "一句话理由"}`;

export class ToolClassifier {
  private provider: Provider | null = null;
  private config: ToolClassifierConfig;

  constructor(config: ToolClassifierConfig) {
    this.config = config;
  }

  /** 设置 LLM Provider */
  setProvider(provider: Provider, model?: string): void {
    this.provider = provider;
    if (model) this.config.model = model;
  }

  /** 分类器是否可用 */
  isAvailable(): boolean {
    return this.config.enabled && this.provider !== null;
  }

  /**
   * 三级快速路径漏斗（零 API 成本）
   * 返回 null 表示需要调 API
   */
  fastPath(req: ToolClassifyRequest): ToolClassifyResult | null {
    // Level 0（G7）：工具通过 toAutoClassifierInput 返回空串，声明与安全无关 → 跳过 LLM
    if (req.classifierInput === "") {
      return { safe: true, risk: "none", reason: "工具声明无安全关联，跳过分类" };
    }

    // Level 1: 只读工具 → 直接安全
    if (AUTO_ALLOW_TOOLS.has(req.toolName)) {
      return { safe: true, risk: "none", reason: "只读工具，无副作用" };
    }

    // Level 2: write/edit 在工作区内 → 自动放行
    if (ACCEPT_EDITS_TOOLS.has(req.toolName)) {
      const filePath = (req.input as any)?.file_path || "";
      if (filePath && filePath.startsWith(req.cwd)) {
        return { safe: true, risk: "low", reason: "工作区内文件编辑" };
      }
    }

    return null; // 需要 LLM 判断
  }

  /** 分类（含快速路径 + LLM 调用） */
  async classify(req: ToolClassifyRequest): Promise<ToolClassifyResult> {
    const log = getLogger();

    // 快速路径
    const fast = this.fastPath(req);
    if (fast) return fast;

    // 分类器不可用 → 回退
    if (!this.isAvailable()) {
      return { safe: false, risk: "medium", reason: "分类器不可用", classifierUnavailable: true };
    }

    const startTime = Date.now();
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const abortCtl = new AbortController();
      // H10：超时用带 reason 的 abort，与主路径 reason 白名单口径统一（详见 errors.ts）。
      const timer = setTimeout(() => abortCtl.abort(SIDE_CALL_TIMEOUT_REASON), timeoutMs);
      const signal = req.signal
        ? AbortSignal.any([req.signal, abortCtl.signal])
        : abortCtl.signal;

      // 推理盲设计：只传 toolName + input + cwd，不传 description/recentContext
      // G7：工具若提供精简语义视图（classifierInput 非空），优先用它替代原始 input——
      // 降噪、聚焦风险片段，同时仍保持"推理盲"（不含模型自述的 description）。
      const userPrompt = JSON.stringify({
        tool: req.toolName,
        input: req.classifierInput ? req.classifierInput : req.input,
        cwd: req.cwd,
      });

      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: userPrompt }] },
      ];

      const model = this.config.model || "";
      const maxTokens = this.config.maxTokens ?? DEFAULT_MAX_TOKENS;
      const system = SYSTEM_PROMPT;
      // H5：工具分类是「出个 {safe,risk} JSON」的分类任务，关思考。主模型为思考模型时不关会让
      // 每次权限判定都触发完整思考——非流式分类常因此超时（provider 已计费、客户端拿不到响应）。
      const sendParams = { model, messages, system, maxTokens, thinking: SIDE_CALL_NO_THINK };

      let text = "";

      // 优先非流式
      if (typeof this.provider!.sendMessageNonStreaming === "function") {
        const resp = await this.provider!.sendMessageNonStreaming(
          sendParams,
          signal,
        );
        clearTimeout(timer);
        const latencyMs = Date.now() - startTime;
        if (resp.usage) {
          recordSideCall({
            label: "tool-classifier",
            model,
            inputTokens: resp.usage.inputTokens ?? 0,
            outputTokens: resp.usage.outputTokens ?? 0,
            cacheReadTokens: (resp.usage as any).cacheReadInputTokens ?? 0,
            cacheCreationTokens: (resp.usage as any).cacheCreationInputTokens ?? 0,
            durationMs: latencyMs,
          });
        }
        text = resp.content
          .filter((b: ContentBlock): b is ContentBlock & { type: "text"; text: string } => b.type === "text")
          .map((b: ContentBlock & { type: "text"; text: string }) => b.text)
          .join("");
      } else {
        // 流式累积兜底
        for await (const ev of this.provider!.sendMessageStream(sendParams, signal)) {
          if (signal.aborted) throw new Error(String((signal as any).reason ?? SIDE_CALL_TIMEOUT_REASON)); // H10
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            text += ev.delta.text;
          }
        }
        clearTimeout(timer);
      }

      const latencyMs = Date.now() - startTime;

      // 解析响应
      const jsonMatch = text.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) {
        log.warn("CLASSIFIER", `解析失败(无JSON): ${text.slice(0, 100)}`);
        return { safe: false, risk: "medium", reason: "分类器解析失败", classifierUnavailable: true, latencyMs };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.safe !== "boolean") {
        log.warn("CLASSIFIER", `解析失败(无 safe 字段): ${jsonMatch[0]}`);
        return { safe: false, risk: "medium", reason: "分类器解析失败", classifierUnavailable: true, latencyMs };
      }

      return {
        safe: parsed.safe,
        risk: parsed.risk || "medium",
        reason: parsed.reason || "分类器判定",
        latencyMs,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      if (err.name === "AbortError") {
        log.warn("CLASSIFIER", `分类器超时 (${timeoutMs}ms)`);
      } else {
        log.warn("CLASSIFIER", `分类器异常: ${err.message}`);
      }
      return { safe: false, risk: "medium", reason: `分类器异常: ${err.message}`, classifierUnavailable: true, latencyMs };
    }
  }
}
