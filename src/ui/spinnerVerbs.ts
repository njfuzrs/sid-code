/**
 * Spinner 加载动词库
 *
 * 对标 claude-code 的 spinnerVerbs：用一个较大的动词池随机抽取，
 * 替代固定 8 短语的顺序循环，让等待文案更有变化、不机械重复。
 *
 * 设计：
 * - 纯中文词库，带省略号后缀，风格轻松。
 * - 分两类：通用思考类（无工具时）与可按需扩展的语气词。
 * - 提供 pickSpinnerVerb()，可传入一个「上一个词」避免连续重复同一词。
 */

/** 通用加载动词池（思考 / 处理阶段，无具体工具时使用） */
export const SPINNER_VERBS: readonly string[] = [
  "思考中",
  "盘算中",
  "琢磨中",
  "推敲中",
  "梳理中",
  "构思中",
  "分析代码",
  "搜索文件",
  "翻阅资料",
  "整理思路",
  "编写代码",
  "检查逻辑",
  "优化方案",
  "组织语言",
  "权衡取舍",
  "拆解问题",
  "查漏补缺",
  "对照需求",
  "理顺脉络",
  "斟酌措辞",
  "回溯上下文",
  "校验细节",
  "归纳要点",
  "演算推导",
  "比对差异",
  "勾勒框架",
  "打磨实现",
  "复盘思路",
  "酝酿方案",
  "捋清依赖",
] as const;

/**
 * 从动词池随机抽取一个动词（带省略号后缀）。
 *
 * @param previous 上一个返回的动词（含后缀），用于避免连续重复同一词。
 * @param random   随机数生成器，默认 Math.random，便于测试注入。
 * @returns 形如 "思考中..." 的字符串。
 */
export function pickSpinnerVerb(
  previous?: string | null,
  random: () => number = Math.random,
): string {
  if (SPINNER_VERBS.length === 0) return "思考中...";

  // 仅一个候选时直接返回，避免死循环。
  if (SPINNER_VERBS.length === 1) {
    return `${SPINNER_VERBS[0]}...`;
  }

  const prevVerb =
    previous && previous.endsWith("...")
      ? previous.slice(0, -3)
      : previous ?? null;

  let verb = SPINNER_VERBS[Math.floor(random() * SPINNER_VERBS.length)];
  // 最多重试几次以避开与上一个相同；超出则接受，保证有界。
  for (let i = 0; i < 5 && verb === prevVerb; i++) {
    verb = SPINNER_VERBS[Math.floor(random() * SPINNER_VERBS.length)];
  }
  return `${verb}...`;
}
