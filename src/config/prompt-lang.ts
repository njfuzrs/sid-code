/**
 * 输出语言偏好的单一事实源。
 *
 * 「中文优先」是 sid-code 的产品特性，但特性不等于**硬锁**：用户显式要求换语言时
 * 必须能换得动，这是本模块存在的理由。三档语义各不相同，不是同义词：
 *
 * | 取值 | 语义 | 提示词表现 |
 * | --- | --- | --- |
 * | `zh` | 中文优先（缺省档） | 强约束「必须中文」，但保留「用户显式要求可穿透」条款 |
 * | `en` | 英文优先 | 强约束「必须英文」，同样保留穿透条款 |
 * | `auto` | 跟随用户输入语言 | 不预设语言，按用户当轮语言应答；判定不了时回落系统 locale |
 *
 * 缺省（`undefined`）等价 `zh`——这是刻意的向后兼容 + 产品定位选择，不要改成 `auto`。
 *
 * 优先级链（高 → 低）：`--language` CLI 参数 > `SID_LANGUAGE` 环境变量 >
 * `settings.json` 的 `language` > 缺省（zh）。与 `--model` 的分层语义一致。
 */

/** 语言偏好取值（含 auto 档） */
export type LanguagePref = "zh" | "en" | "auto";

/** 归一化后的实际输出语言（auto 已被解析掉） */
export type ResolvedLanguage = "zh" | "en";

/** 合法偏好值（命令补全 / 校验 / 文档生成共用，避免多处手写漂移） */
export const LANGUAGE_PREFS: readonly LanguagePref[] = ["zh", "en", "auto"] as const;

/**
 * 解析任意外部输入为合法偏好值。
 *
 * 容错面刻意放宽（大小写、`zh-CN` / `en_US` 这类 locale 串、`chinese` / `english`
 * 这类自然语言说法），因为这个函数同时服务 CLI 参数、环境变量、settings.json 三个
 * 入口，用户在任一处写 `--language zh-CN` 都属于合理预期。
 *
 * 无法识别时返回 `undefined`（表示「没有有效偏好」），由调用方决定是报错（CLI 显式
 * 传参写错，应当告知）还是静默忽略（环境变量残留，不该打断启动）。
 */
export function normalizeLanguagePref(value: unknown): LanguagePref | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (!v) return undefined;

  // 显式回退默认的几种说法，统一归到 auto 之外的「无偏好」——注意 unset/default 与 auto
  // 语义不同：前者是「删掉偏好回落缺省(zh)」，后者是「跟随用户输入语言」。
  if (v === "unset" || v === "default" || v === "none") return undefined;
  if (v === "auto" || v === "detect" || v === "follow") return "auto";

  // locale 串取主语言子标签：zh-CN / zh_TW / zh.UTF-8 → zh
  const primary = v.split(/[-_.@]/)[0];
  if (primary === "zh" || primary === "cn" || primary === "chinese" || primary === "zho" || primary === "cmn") return "zh";
  if (primary === "en" || primary === "eng" || primary === "english") return "en";
  return undefined;
}

/**
 * 从系统 locale 猜测语言（仅供 `auto` 档兜底）。
 *
 * 只在无法从用户输入判定语言时使用（比如首轮还没有用户消息、或用户只发了一个
 * 纯代码片段）。读取顺序对齐 POSIX：`LC_ALL` > `LC_MESSAGES` > `LANG`。
 * 判定不了一律回落 `zh`——「中文优先」是产品缺省，不确定时不该漂到英文。
 */
export function detectSystemLanguage(env: Record<string, string | undefined> = process.env): ResolvedLanguage {
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const pref = normalizeLanguagePref(env[key]);
    if (pref === "zh" || pref === "en") return pref;
  }
  return "zh";
}

/**
 * 把偏好解析为实际输出语言。`auto` 走系统 locale 探测，缺省走 `zh`。
 *
 * 注意：**提示词构建不要用这个函数**。提示词需要区分「强制某语言」与「跟随用户
 * 输入」两种措辞，把 auto 提前压成 zh/en 会丢掉后者的语义（这正是旧实现里 auto
 * 沦为 zh 别名的根因）。这个函数服务的是那些必须二选一的场合——例如子代理的
 * 结论输出约束、UI 状态展示。
 */
export function resolveEffectiveLanguage(
  pref: LanguagePref | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedLanguage {
  if (pref === "en" || pref === "zh") return pref;
  if (pref === "auto") return detectSystemLanguage(env);
  return "zh";
}

/** 从环境变量读取语言偏好（`SID_LANGUAGE`，兼容 `SID_CODE_LANGUAGE`）。 */
export function resolveLanguageFromEnv(
  env: Record<string, string | undefined> = process.env,
): LanguagePref | undefined {
  return normalizeLanguagePref(env.SID_LANGUAGE) ?? normalizeLanguagePref(env.SID_CODE_LANGUAGE);
}

/** 人类可读标签（命令回显 / 状态栏共用，避免各处手写不一致）。 */
export function describeLanguagePref(pref: LanguagePref | undefined, lang: ResolvedLanguage = "zh"): string {
  if (lang === "en") {
    if (pref === "zh") return "Chinese-first";
    if (pref === "en") return "English-first";
    if (pref === "auto") return "Auto (follow the user's language)";
    return "Default (Chinese-first)";
  }
  if (pref === "zh") return "中文优先";
  if (pref === "en") return "英文优先";
  if (pref === "auto") return "自动（跟随用户输入语言）";
  return "默认（中文优先）";
}

/**
 * `<internal_en>` 标签的匹配式。
 *
 * 背景：推理语言易漂移的模型（deepseek 全系）走「铁律级」中文约束时，提示词允许它把
 * 英文技术思考包在 `<internal_en>` 里作为泄压阀。但标签只是**给模型的书写协议**，
 * 不该泄漏到用户视野——旧实现定义了标签却没有任何剥离路径，模型一照做，TUI 里就出现
 * 裸标签。这里统一提供剥离能力，展示 / 落盘 / 交付文本三条路径共用。
 *
 * 不用贪婪匹配、允许标签名大小写混写、容忍未闭合（模型被截断时很常见）。
 */
const INTERNAL_EN_BLOCK = /<internal_en>[\s\S]*?<\/internal_en>/gi;
const INTERNAL_EN_UNCLOSED = /<internal_en>[\s\S]*$/i;
const INTERNAL_EN_STRAY_TAG = /<\/?internal_en>/gi;

/**
 * 剥离 `<internal_en>` 包裹的内部思考，返回面向用户的干净文本。
 *
 * 语义是「连标签带内容一起删」而非「只删标签」：标签内是模型的英文内部推理，在中文
 * 铁律模式下把它留给用户看，恰好破坏了这个模式想达成的效果。未闭合的尾部同样删除
 * （模型被 max_tokens 截断在标签中间时，留下的半句英文推理同样不该展示）。
 *
 * 兜底再清一遍游离标签：模型有时只写闭合标签、或嵌套写错，不能让裸标签漏出去。
 */
export function stripInternalEnTags(text: string): string {
  // 判据要覆盖游离闭合标签，否则 `</internal_en>` 单独出现时漏出。
  if (!text || !hasInternalEnTags(text)) return text;
  return text
    .replace(INTERNAL_EN_BLOCK, "")
    .replace(INTERNAL_EN_UNCLOSED, "")
    .replace(INTERNAL_EN_STRAY_TAG, "")
    // 剥离后常留下连续空行，压成最多一个空行，避免渲染出大段空白
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 文本中是否含 `<internal_en>` 痕迹（供测试与诊断断言）。 */
export function hasInternalEnTags(text: string): boolean {
  return typeof text === "string" && /<\/?internal_en>/i.test(text);
}

/**
 * 把 `<internal_en>` 块从正文里**提取**出来（而非直接丢弃）。
 *
 * 与 `stripInternalEnTags` 的分工：
 * - 本函数用于 **Provider 解析层**——提取出的内容转成 thinking 块，正文只留标签外的部分。
 *   这样思考过程仍可在 TUI 的思考区展示、仍能回放给下一轮，只是不混进回复正文。
 *   取向与既有的内联 `<think>` 处理完全一致（见 openai.ts extractInlineThinkTags）：
 *   **归位，不是删除**。删掉等于丢失模型的推理链，调试时会很难受。
 * - `stripInternalEnTags` 用于**展示/落盘的最后一道防线**：万一没走 Provider 解析路径
 *   （或模型把标签写在了奇怪的位置），兜底保证裸标签不泄漏给用户。
 *
 * 与 `<think>` 的一个关键差异：`<think>` 几乎总在文本开头且只有一块，而 `<internal_en>`
 * 是"想用英文思考时随时可以包一段"，**可能出现多次、且在中间位置**。所以这里全局匹配、
 * 收集所有块，而不是只取开头第一块。
 */
export function extractInternalEnTags(content: string): { thinking: string; text: string } {
  // 快速退出的判据必须覆盖**闭合**标签：模型有时只写 `</internal_en>`（开标签丢了/被
  // 截断在前一个 chunk）。早先只探测 `<internal_en` 前缀，游离闭合标签就直接漏进正文。
  if (!content || !hasInternalEnTags(content)) {
    return { thinking: "", text: content };
  }

  const parts: string[] = [];
  let text = content.replace(INTERNAL_EN_BLOCK, (block) => {
    parts.push(block.replace(INTERNAL_EN_STRAY_TAG, "").trim());
    return "";
  });

  // 未闭合的尾部（模型被 max_tokens 截断在标签中间）：同样算思考内容，别留半句英文在正文。
  const unclosed = text.match(INTERNAL_EN_UNCLOSED);
  if (unclosed) {
    parts.push(unclosed[0].replace(INTERNAL_EN_STRAY_TAG, "").trim());
    text = text.replace(INTERNAL_EN_UNCLOSED, "");
  }

  return {
    thinking: parts.filter(Boolean).join("\n\n"),
    // 游离标签兜底清理 + 压缩剥离后留下的连续空行
    text: text.replace(INTERNAL_EN_STRAY_TAG, "").replace(/\n{3,}/g, "\n\n").trim(),
  };
}
