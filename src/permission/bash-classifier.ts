/**
 * LLM 命令风险分类器（对标 claude-code yoloClassifier.ts，取核心分类逻辑的简化版）
 *
 * 设计要点（见 docs/bugfixes/todo/p0-3/LLM命令风险分类器+路径安全-补齐分析.md §6.3）：
 *  - 硬编码正则是「枚举负方法」，易被编码/混淆/间接执行绕过；LLM 理解命令意图作为第二道防线。
 *  - 单次调用即可（不做 claude 的两阶段 XML —— 那是 Haiku 成本优化产物，sid 主模型质量足够）。
 *  - 失败兜底原则：任何解析失败/网络错误/超时 → classifierUnavailable=true，调用方回退硬编码兜底；
 *    分类器**不存在「放过」的故障模式**（safe 仅在明确解析成功且模型判定安全时才为 true）。
 *  - 只对「硬编码未判为 critical」的命令调用，避免对 ls/cat 等显然安全命令浪费 LLM 调用。
 */

import type { Provider } from "../llm/provider.ts";
import type { Message } from "../llm/types.ts";
import { getCapabilities } from "../llm/provider.ts";
import { getLogger } from "../debug/logger.ts";
import { recordSideCall } from "../trace/side-call-sink.ts";

/** 风险等级（由低到高） */
export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

/** 分类请求 */
export interface BashClassifyRequest {
  /** 待分类的 shell 命令 */
  command: string;
  /** 当前工作目录（提供上下文，帮助区分意图） */
  cwd: string;
  /** 来自工具调用的 description（若有，极大提升判断准确度） */
  description?: string;
  /** 最近 N 轮对话摘要（可选，提供更丰富上下文） */
  recentContext?: string;
  /** 取消信号 */
  signal?: AbortSignal;
}

/** 分类结果 */
export interface BashClassifyResult {
  /** true = 允许执行（仅当解析成功且模型判定安全时为 true） */
  safe: boolean;
  /** 风险等级 */
  risk: RiskLevel;
  /** 判断理由（供日志、调试、权限对话框展示） */
  reason: string;
  /**
   * true 表示分类器不可用（未启用/无 provider/网络错误/解析失败/超时）。
   * 为 true 时 safe 字段无意义，调用方必须回退到硬编码兜底逻辑。
   */
  classifierUnavailable?: boolean;
  /** 分类耗时（毫秒），用于成本/性能监控 */
  latencyMs?: number;
}

/** 分类器配置 */
export interface BashClassifierConfig {
  /** 是否启用 LLM 命令风险分类器（默认 false，保守） */
  enabled: boolean;
  /** 分类器使用的模型（默认复用主循环模型，传空则用 provider 默认模型） */
  model?: string;
  /** 单次分类的超时（毫秒，默认 8000） */
  timeoutMs?: number;
  /** 分类输出 token 上限（默认 512，理由 + JSON 足够） */
  maxTokens?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_TOKENS = 512;

/**
 * 构建分类器系统提示词（关键资产，对标 yolo-classifier-prompts/auto_mode_system_prompt.txt）。
 * 教模型「理解命令意图」而非「关键字匹配」。
 */
export function buildClassifierSystemPrompt(): string {
  return `你是一个严格的 Shell 命令安全分类器。你的唯一职责是分析给定命令的潜在风险，并输出结构化的风险判断。

风险分级（risk 字段取值）：
- none: 纯信息查询，无副作用（ls, cat, grep, find -name, git status, pwd）
- low: 有边界但常规安全的操作（npm install, pip install, git clone, mkdir, touch）
- medium: 需要用户确认的有副作用操作（sudo, chmod, 非递归 rm, mv 覆盖, git push）
- high: 高风险，默认应拒绝（curl|bash, rm -rf 某目录, chmod -R 777, 数据外传, 修改系统配置）
- critical: 绝不允许（rm -rf /, dd if=/dev/zero of=/dev/sda, mkfs, fork bomb, 擦除磁盘）

判断时必须穿透表层语法、理解真实意图，重点考量以下维度：
1. 系统影响：是否删除文件、格式化磁盘、修改权限、写入块设备
2. 数据安全：是否向外部服务器发送文件内容或凭证（数据外传）
3. 持久化风险：是否修改 crontab / .bashrc / .zshrc / systemd 服务 / 开机自启
4. 提权风险：是否尝试获取 root 权限（sudo, su, pkexec）
5. 混淆/编码绕过：是否用 base64 / xxd / printf / \\x 十六进制 / 变量拼接 / eval / $IFS 等手段隐藏真实意图——一旦发现混淆迹象，按其解码后的真实意图评级，并至少提升到 high
6. 间接执行：是否通过 python -c / node -e / perl -e / make / 解释器调用危险操作
7. 供应链风险：是否从不可信源下载并执行代码（管道到 sh/bash、安装未验证的包）
8. 同形字：命令中是否含与 ASCII 形似的 Unicode 字符（可能伪装合法命令）

结合工作目录与命令描述理解上下文：同一命令在不同上下文风险不同（例如 rm 在清理临时产物 vs 删除证据）。

输出要求（严格遵守）：
- 只输出一个 JSON 对象，不要任何额外文字、不要 markdown 代码围栏。
- 格式：{"safe": <boolean>, "risk": "<none|low|medium|high|critical>", "reason": "<一句话中文解释>"}
- safe 与 risk 必须一致：risk 为 none/low 时 safe=true；medium/high/critical 时 safe=false。
- 拿不准时从严：宁可判高一档，也不放过潜在危险。`;
}

/**
 * 构建分类器用户提示词（注入具体命令 + 上下文）。
 */
export function buildClassifierUserPrompt(req: BashClassifyRequest): string {
  const lines = [
    `请分析以下 Shell 命令的风险：`,
    ``,
    `命令: ${req.command}`,
    `工作目录: ${req.cwd}`,
  ];
  if (req.description) {
    lines.push(`命令描述（来自调用方）: ${req.description}`);
  }
  if (req.recentContext) {
    lines.push(`最近上下文: ${req.recentContext}`);
  }
  lines.push(``, `输出 JSON：`);
  return lines.join("\n");
}

/**
 * 解析分类器响应（容错：剥离可能的 markdown 围栏、提取首个 JSON 对象）。
 * 解析失败返回 null（调用方据此走兜底）。
 */
export function parseClassifierResponse(text: string): { safe: boolean; risk: RiskLevel; reason: string } | null {
  if (!text || typeof text !== "string") return null;

  // 剥离 markdown 代码围栏
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // 提取首个 {...} JSON 对象（模型可能在 JSON 前后夹带文字）
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }

  const validRisks: RiskLevel[] = ["none", "low", "medium", "high", "critical"];
  const risk: RiskLevel = validRisks.includes(parsed?.risk) ? parsed.risk : "high"; // 缺失/非法 → 从严按 high

  // safe 与 risk 一致性校验：以 risk 为准派生 safe，杜绝模型自相矛盾（risk=critical 却 safe=true）
  const safeByRisk = risk === "none" || risk === "low";
  const safe = typeof parsed?.safe === "boolean" ? (parsed.safe && safeByRisk) : safeByRisk;

  const reason = typeof parsed?.reason === "string" && parsed.reason.trim()
    ? parsed.reason.trim()
    : "（分类器未提供理由）";

  return { safe, risk, reason };
}

/**
 * Bash 命令风险分类器。
 *
 * 通过 setProvider() 注入 LLM 调用能力（解耦：权限层不直接依赖 registry）。
 * 未注入 provider 或未启用时，classify() 始终返回 classifierUnavailable=true。
 */
export class BashClassifier {
  private config: BashClassifierConfig;
  private provider: Provider | null = null;
  /** 分类器实际使用的模型名（注入时确定） */
  private modelName: string | null = null;

  constructor(config: BashClassifierConfig) {
    this.config = config;
  }

  /** 注入 LLM Provider 与模型名（在 cli/app 初始化阶段调用） */
  setProvider(provider: Provider | null, modelName?: string): void {
    this.provider = provider;
    this.modelName = modelName ?? this.config.model ?? null;
  }

  /** 更新配置（运行时 /config 切换开关时调用） */
  setConfig(config: Partial<BashClassifierConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** 分类器当前是否可用（启用 + 已注入 provider） */
  isAvailable(): boolean {
    return this.config.enabled && this.provider !== null;
  }

  /**
   * 对命令做风险分类。
   * 任何不可用/异常路径都返回 classifierUnavailable=true（调用方走硬编码兜底）。
   */
  async classify(req: BashClassifyRequest): Promise<BashClassifyResult> {
    const log = getLogger();

    if (!this.config.enabled) {
      return { safe: false, risk: "none", reason: "分类器未启用", classifierUnavailable: true };
    }
    if (!this.provider) {
      return { safe: false, risk: "none", reason: "分类器无可用 Provider", classifierUnavailable: true };
    }
    if (!this.modelName) {
      return { safe: false, risk: "none", reason: "分类器未指定模型名（需在 setProvider 时传入）", classifierUnavailable: true };
    }

    const startedAt = performance.now();
    try {
      const text = await this.callProvider(req);
      const latencyMs = Math.round(performance.now() - startedAt);

      const parsed = parseClassifierResponse(text);
      if (!parsed) {
        log.warn("BASH_CLASSIFIER", `响应解析失败，回退硬编码兜底: ${text.slice(0, 120)}`);
        return { safe: false, risk: "high", reason: "分类器响应解析失败", classifierUnavailable: true, latencyMs };
      }

      log.info(
        "BASH_CLASSIFIER",
        `命令分类: risk=${parsed.risk} safe=${parsed.safe} (${latencyMs}ms) — ${parsed.reason}`,
      );
      return { ...parsed, latencyMs };
    } catch (err: any) {
      const latencyMs = Math.round(performance.now() - startedAt);
      const aborted = err?.name === "AbortError" || /abort/i.test(err?.message || "");
      log.warn(
        "BASH_CLASSIFIER",
        `分类调用${aborted ? "被中断/超时" : "失败"}，回退硬编码兜底: ${err?.message || err}`,
      );
      return { safe: false, risk: "high", reason: `分类器调用失败: ${err?.message || "未知错误"}`, classifierUnavailable: true, latencyMs };
    }
  }

  /**
   * 调用 LLM（优先非流式接口；不支持则流式累积），叠加超时控制。
   * 返回模型输出的纯文本。
   */
  private async callProvider(req: BashClassifyRequest): Promise<string> {
    const provider = this.provider;
    const modelName = this.modelName;
    // 防御性：classify() 入口已确保非空，此处做局部变量绑定避免后续重构引入空指针
    if (!provider || !modelName) {
      throw new Error("BashClassifier 未初始化：provider 或 modelName 为空");
    }
    const system = buildClassifierSystemPrompt();
    const userPrompt = buildClassifierUserPrompt(req);
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: userPrompt }] },
    ];
    const model = modelName;
    const maxTokens = this.config.maxTokens ?? DEFAULT_MAX_TOKENS;
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // 组合超时信号与外部取消信号
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = combineSignals(req.signal, timeoutController.signal);

    try {
      // 优先非流式（更省、更直接）
      if (typeof provider.sendMessageNonStreaming === "function") {
        const resp = await provider.sendMessageNonStreaming(
          { model, messages, system, maxTokens },
          signal,
        );
        // 记录辅助调用用量
        if (resp.usage) {
          recordSideCall({
            label: "bash-classifier",
            model,
            inputTokens: resp.usage.inputTokens ?? 0,
            outputTokens: resp.usage.outputTokens ?? 0,
            cacheReadTokens: (resp.usage as any).cacheReadInputTokens ?? 0,
            cacheCreationTokens: (resp.usage as any).cacheCreationInputTokens ?? 0,
            durationMs: 0,
          });
        }
        return extractText(resp.content);
      }

      // 流式累积兜底（ollama 等无非流式接口的 provider）
      let text = "";
      let streamUsage: any = null;
      const caps = getCapabilities(provider);
      void caps; // 仅用于显式表明已考虑能力差异
      for await (const ev of provider.sendMessageStream({ model, messages, system, maxTokens }, signal)) {
        // 纵深防御:bash-classifier side-call 检查 signal(已组合超时+外部取消),防止 provider 层超时失效时挂死
        if (signal.aborted) {
          throw new Error("Request aborted");
        }
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          text += ev.delta.text;
        } else if (ev.type === "message_stop" && (ev as any).usage) {
          streamUsage = (ev as any).usage;
        } else if (ev.type === "error") {
          throw new Error(ev.error.message);
        }
      }
      // 记录辅助调用用量（流式兜底路径）
      if (streamUsage) {
        recordSideCall({
          label: "bash-classifier",
          model,
          inputTokens: streamUsage.inputTokens ?? 0,
          outputTokens: streamUsage.outputTokens ?? 0,
          cacheReadTokens: streamUsage.cacheReadInputTokens ?? 0,
          cacheCreationTokens: streamUsage.cacheCreationInputTokens ?? 0,
          durationMs: 0,
        });
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 从内容块数组提取拼接的纯文本 */
function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/**
 * 组合多个 AbortSignal 为一个：任一触发则结果触发。
 * （Node/Bun 的 AbortSignal.any 可能不可用，自行实现以保证兼容。）
 */
function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const valid = signals.filter((s): s is AbortSignal => s != null);
  if (valid.length === 1) return valid[0];

  const controller = new AbortController();
  for (const s of valid) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}
