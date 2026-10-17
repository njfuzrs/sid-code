/**
 * 「承诺未兑现」的 end_turn —— 形态判定 + 续跑决策（S1 L1 / L2，单一事实源）
 *
 * ## 它拦的是什么
 *
 * 事故会话 `20261016-124310-ebff882b` call 41：模型跑完一串工具后以 `end_turn` 返回一句
 * 「继续。先读取 website 安装的输出，确认安装成功，然后开始逐处修改。」（37 字符、无 tool_use），
 * harness 当成正常收尾进入空闲，TUI 无任何提示，静默约 3 小时。收尾闸门链每一道的前置条件
 * 都不满足（未答复检测只认空文本 / 超长漂移；todo gate 要有清单；无 goal / 假设 / hook）。
 *
 * ## 两层
 *
 * - **L1 可见性**（零行为风险）：每次 end_turn 都落一条形态事实（`EndTurnShape`），
 *   短文本收尾时 TUI 常驻一句提示。见 {@link classifyEndTurnShape}。
 * - **L2 续跑一次**（有行为、封顶）：结构信号全 AND + 词面二次消歧命中时，注入一次合成用户
 *   消息再续一轮。见 {@link decidePromiseNudge}。
 *
 * ## 为什么判据不写进 `detectUnansweredEndTurn`
 *
 * 子代理以纯文本收尾是**正常形态**（最后一条文本就是返回值）。`detectUnansweredEndTurn`
 * 一旦被子代理路径接入，承诺判据就会错误续跑。所以本模块只被 `query/loop.ts` 主循环收尾链调用。
 *
 * ## 阈值与词表的依据（回放，弱保证）
 *
 * 全库按可见文本长度重跑结构候选（end_turn ∧ 无 tool_use ∧ 上一次含 tool_use）：
 * `text_len ≤ 80` 命中 9 条，事故段 37 字符；其余 8 条是完成陈述 / 等后台子代理 / 向用户求助 /
 * 向用户提问。词表在这 9 条上的命中**恰为事故段**。只有 8 个负样本、且全是中文，
 * 这是弱保证：英文分支没有回放依据，**只发 L1 事实、不触发 L2**（先度量）。
 * 真正的验收是真实会话里的 `PromiseNudge` 事件。
 *
 * 阈值按**可见文本**而非 `output_tokens`：OpenAI 族 `outputTokens` 含 reasoning
 * （事故会话 call 35–40 output 与 reasoning 只差 206–501），「长推理 + 短承诺」按 output 判必然漏判。
 */

/** 短文本收尾的可见文本长度上限（字符数，含标点）。回放依据见文件头。 */
export const PROMISE_NUDGE_MAX_TEXT_LEN = 80;

/** 每个 queryLoop 调用（≈一条用户 prompt）最多续跑的次数。工具执行不清零。 */
export const MAX_PROMISE_NUDGES = 1;

/** 紧急止血口：设为 `1` 关闭 L2 续跑（L1 事实与提示照常）。不是默认关。 */
export const PROMISE_NUDGE_DISABLE_ENV = "SID_DISABLE_PROMISE_NUDGE";

/** L2 注入的合成用户消息正文（发给模型，TUI 隐藏）。 */
export const PROMISE_NUDGE_MESSAGE =
  "你上一条消息说要继续执行，但没有调用任何工具。请直接调用工具继续；若已完成或被阻塞，请明确说明。";

/** L1 TUI 常驻提示文案。 */
export const PLAIN_TEXT_END_TURN_NOTICE =
  "本轮以纯文本结束（模型未调用工具）。如需继续，直接回复「继续」。";

export type PromiseLang = "zh" | "en";

/**
 * end_turn 形态：
 * - `answered`：正常答复（文本较长，或上一次没调工具 —— 纯问答）；
 * - `empty`：无可见文本（由 `detectUnansweredEndTurn` 那条线负责，这里只记事实）；
 * - `short_after_tools`：跑过工具后用一句短文本收尾，词面不像承诺（完成陈述 / 求助 / 等待）；
 * - `promise_after_tools`：同上且词面像「我接着干」—— L2 的候选。
 */
export type EndTurnShapeKind = "answered" | "empty" | "short_after_tools" | "promise_after_tools";

// ── 词表（保守；改动必须同步 tests/query/promise-nudge.test.ts 的回放样本）──

/** 中文：第一人称承诺继续动作 */
const ZH_PROMISE = [
  /^\s*(好的?[，,。！!]?\s*)?继续/,
  /接着/,
  /接下来/,
  /下一步/,
  /先[^。！？!?\n]{0,40}(然后|再)/,
  /然后(开始|继续)/,
  /我(这就|现在|马上)(去|来|开始)/,
];

/** 中文：向用户的请求 / 完成陈述 / 等待 —— 任一命中即不是「说了不做」 */
const ZH_EXCLUDE = [
  /请你|请把|请在|请执行|请确认|请告诉|请提供|请选择|请贴/,
  /等你|告诉我|你确认|你来|需要我|要不要|是否需要|你看/,
  /[吗呢][？?]|[？?]/,
  /已[^。！？\n]{0,10}完成|都完成了|已写好|已修复|已提交|已合并|已交付|全部完成/,
  /完成后我会|我会告诉你|等它|等它们/,
];

/** 英文：第一人称承诺继续动作 */
const EN_PROMISE = [
  /\bI'll (continue|proceed|now|start|go ahead)\b/i,
  /\bI will (continue|proceed|now|start)\b/i,
  /\bnext,? I(?:'ll| will)\b/i,
  /\bnow I(?:'ll| will)\b/i,
  /^\s*let me\b/i,
  /^\s*continuing\b/i,
];

/** 英文：向用户的请求 / 完成陈述 */
const EN_EXCLUDE = [
  /\bplease\b/i,
  /\blet me know\b/i,
  /\b(could|can|would) you\b/i,
  /\?/,
  /\b(done|completed|finished|all set)\b/i,
];

const CJK = /[㐀-鿿]/;

/**
 * 词面二次消歧：这句短文本是不是「第一人称承诺继续、且不求用户、不报完成」。
 * 只在结构信号已成立时调用（裸子串是最弱的信号，不能单独做触发前提）。
 */
export function classifyPromiseText(text: string): { lang: PromiseLang; isPromise: boolean } {
  const lang: PromiseLang = CJK.test(text) ? "zh" : "en";
  const [promise, exclude] = lang === "zh" ? [ZH_PROMISE, ZH_EXCLUDE] : [EN_PROMISE, EN_EXCLUDE];
  const isPromise = promise.some((re) => re.test(text)) && !exclude.some((re) => re.test(text));
  return { lang, isPromise };
}

export interface EndTurnShapeInput {
  /** 可见文本（仅 text 块拼接，不含 thinking） */
  text: string;
  /** 本次响应是否含 tool_use（走到 end_turn 收尾分支时恒为 false，留着让函数自洽） */
  hasToolUse: boolean;
  /** 上一次模型调用是否含 tool_use（本 prompt 内） */
  prevTurnHadToolUse: boolean;
}

export interface EndTurnShape {
  kind: EndTurnShapeKind;
  textLen: number;
  /** 仅 `promise_after_tools` / `short_after_tools` 有意义 */
  lang?: PromiseLang;
}

/** L1：把一次 end_turn 归成形态。纯函数。 */
export function classifyEndTurnShape(input: EndTurnShapeInput): EndTurnShape {
  const textLen = [...input.text.trim()].length;
  if (input.hasToolUse) return { kind: "answered", textLen };
  if (textLen === 0) return { kind: "empty", textLen };
  if (!input.prevTurnHadToolUse || textLen > PROMISE_NUDGE_MAX_TEXT_LEN) {
    return { kind: "answered", textLen };
  }
  const { lang, isPromise } = classifyPromiseText(input.text);
  return { kind: isPromise ? "promise_after_tools" : "short_after_tools", textLen, lang };
}

/** L2 未触发的原因（进 `PromiseNudge.outcome`，让「为什么没拦」可被统计） */
export type PromiseNudgeSkipReason =
  | "disabled"
  | "capped"
  | "background_running"
  | "pending_notifications"
  | "en_measure_only";

export type PromiseNudgeDecision =
  | { fire: true; lang: PromiseLang }
  | { fire: false; lang: PromiseLang; reason: PromiseNudgeSkipReason };

/**
 * L2：形态为 `promise_after_tools` 时是否续跑。其它形态返回 null（不是候选，不落 PromiseNudge）。
 *
 * 结构信号全 AND：end_turn ∧ 无 tool_use ∧ 上次含 tool_use ∧ text_len ≤ 阈值（已由形态保证）
 * ∧ 无运行中后台任务（合法等待：「子代理已派出，完成后告诉你」）
 * ∧ 无待投递通知（任务刚完成、#313 空闲唤醒正要送通知，交给它续）。
 */
export function decidePromiseNudge(
  shape: EndTurnShape,
  ctx: {
    nudgeCount: number;
    runningBackgroundTasks: boolean;
    pendingNotifications: boolean;
    disabled: boolean;
  },
): PromiseNudgeDecision | null {
  if (shape.kind !== "promise_after_tools") return null;
  const lang = shape.lang ?? "zh";
  if (ctx.disabled) return { fire: false, lang, reason: "disabled" };
  if (ctx.nudgeCount >= MAX_PROMISE_NUDGES) return { fire: false, lang, reason: "capped" };
  if (ctx.runningBackgroundTasks) return { fire: false, lang, reason: "background_running" };
  if (ctx.pendingNotifications) return { fire: false, lang, reason: "pending_notifications" };
  // 英文词表没有回放依据：先度量，不行动
  if (lang === "en") return { fire: false, lang, reason: "en_measure_only" };
  return { fire: true, lang };
}

/** 读 env 止血口 */
export function isPromiseNudgeDisabled(): boolean {
  return process.env[PROMISE_NUDGE_DISABLE_ENV] === "1";
}

/**
 * 推理占比：本 prompt 累计 reasoning ÷ 累计 output。
 * OpenAI 族 reasoning 是 output 的子集；Anthropic 族 reasoning 恒 0（靠 has_thinking 区分），
 * 此时返回 0 —— 是「没有可比数据」，消费侧须按 provider 分组看。
 */
export function reasoningShare(reasoningTokens: number, outputTokens: number): number {
  if (outputTokens <= 0) return 0;
  return Math.round((Math.min(reasoningTokens, outputTokens) / outputTokens) * 1000) / 1000;
}
