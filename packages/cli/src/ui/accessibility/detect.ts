/**
 * 屏幕阅读器探测 — LY2（自建，新引擎无 useIsScreenReaderEnabled）
 *
 * 终端环境无法像浏览器那样可靠探测辅助技术（无 prefers-reduced-motion / aria）。
 * 我们采用「环境信号 + 显式开关」组合判定，对齐 claude-code 在终端的务实做法：
 *
 * 1. 显式环境变量（最高优先级）：
 *    - SID_ACCESSIBILITY=1 / SID_SCREEN_READER=1 → 强制开启
 *    - SID_ACCESSIBILITY=0 → 强制关闭
 * 2. 常见辅助技术 / CI 环境信号：
 *    - 部分屏幕阅读器或无障碍终端会设置相关环境变量。
 * 3. 默认关闭。
 *
 * 探测结果用于驱动「无障碍模式」：动画降级为静态文本、增加语义前缀、避免纯色区分等。
 */

/** 判定是否应启用无障碍模式。纯函数，注入 env 便于单测。 */
export function detectScreenReader(env: Record<string, string | undefined> = process.env): boolean {
  // 1. 显式开关优先。
  const explicit = env.SID_ACCESSIBILITY ?? env.SID_SCREEN_READER;
  if (explicit !== undefined) {
    const v = explicit.trim().toLowerCase();
    if (v === "0" || v === "false" || v === "off" || v === "no") return false;
    if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  }

  // 2. 常见辅助技术环境信号（保守白名单，命中即认为需要无障碍）。
  //    NVDA / JAWS / Orca 等屏幕阅读器在某些终端集成下会注入标记。
  if (env.ACCESSIBILITY_ENABLED === "1") return true;
  if (env.SCREEN_READER === "1") return true;

  // 3. 默认关闭。
  return false;
}
