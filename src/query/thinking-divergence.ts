/**
 * 思考发散熔断器（方案③，deepseek-reasoning-leak-as-text-任务中断.md 5.3）
 *
 * 背景：三例中最早、最强的预警信号是"思考量雪崩"——例① 第 7→8→9 轮思考字符
 * `5741 → 12720 → 55468` 单调激增，模型陷入分析瘫痪却无任何告警（STALL_LOG_MS
 * 只在"流无字节"时触发，而发散是"一直吐字节、原地打转"）。
 *
 * 本模块在主循环侧统计每轮思考字符数，检测"连续 N 轮单调递增且末轮超阈值"，
 * 回注一次收敛提示，逼模型换策略（先建 todo 拆解、调工具去验证，而非继续推演）。
 *
 * 定位：真因⓪（reasoning_content 回传）修好后，思考量雪崩本质（思维链断裂的重建
 * 代价）应大幅缓解，故本熔断器从"治本"降级为**早期哨兵 + 回归指标**——若雪崩仍
 * 出现，说明真因未彻底修好或有新诱因。阈值保守，避免误伤正常的深度推理任务。
 */

/** 检测窗口：观察最近 N 轮思考量 */
export const THINKING_DIVERGENCE_WINDOW = 3;

/**
 * 末轮思考字符数阈值：低于此值不视为发散（正常深度推理也可能几千字）。
 * 例① 雪崩末段 12720→55468 远超此值；设 20000 兜住失控独白、放过常规长推理。
 */
export const THINKING_DIVERGENCE_LEN = 20_000;

/** 熔断最多介入次数（避免每轮刷屏烧 token；超过说明模型确实卡死，交由其他兜底处理） */
export const MAX_THINKING_DIVERGENCE_INTERVENTIONS = 2;

/**
 * 思考发散熔断是否启用（默认关闭，对齐 Claude Code——CC 无思考量监控/发散熔断）。
 *
 * 为什么默认关闭 + 独立 env 门控（2026-07-07 决策，约束型误伤排查清单 Top 4 + 发现一）：
 * 本熔断器早已自认从"治本"降级为"早期哨兵 + 回归指标"（真因⓪ reasoning_content 回传修好
 * 后应极少触发）。它拦的是"模型可能走的弯路"（深度推理任务思考量天然递增），属启发式
 * 纠偏而非不可逆危害；措辞"陷入分析瘫痪/立即改变策略"是替模型下判断，随模型能力提升
 * 误伤面扩大。更关键：此前它是 loop.ts 里独立 state 字段逻辑，**绕过了
 * `SID_ENABLE_LOOP_DETECTION` 全局 gate**——用户以为关掉循环检测即关掉所有启发式纠偏，
 * 实际它仍每轮在跑。现纳入独立、可逆 env 开关，与循环检测/产出停滞样板一致：代码不删、
 * 仅默认关；作为回归指标需要观察时，用 SID_ENABLE_THINKING_DIVERGENCE=1 或随
 * SID_ENABLE_LOOP_DETECTION=1 一并开启。
 */
export function isThinkingDivergenceDetectionEnabled(): boolean {
  return (
    process.env.SID_ENABLE_THINKING_DIVERGENCE === "1" ||
    process.env.SID_ENABLE_LOOP_DETECTION === "1"
  );
}

/**
 * 计算一次响应里所有 thinking 块的总字符数。
 * 思考块已由 stream-processor 原地转型为 { type:"thinking", thinking }。
 */
export function measureThinkingLen(
  content: ReadonlyArray<{ type: string; thinking?: string }>,
): number {
  let total = 0;
  for (const b of content) {
    if (b.type === "thinking" && typeof b.thinking === "string") {
      total += b.thinking.length;
    }
  }
  return total;
}

/**
 * 判断给定的思考量历史是否构成"发散"：
 * 1. 至少积累满 WINDOW 轮；
 * 2. 窗口内严格单调递增（每轮都比上一轮多）；
 * 3. 末轮超过 THINKING_DIVERGENCE_LEN。
 *
 * @param history 思考字符数历史（时间正序，最后一个是最新轮）
 */
export function isThinkingDiverging(history: ReadonlyArray<number>): boolean {
  if (history.length < THINKING_DIVERGENCE_WINDOW) return false;
  const window = history.slice(-THINKING_DIVERGENCE_WINDOW);
  for (let i = 1; i < window.length; i++) {
    if (window[i]! <= window[i - 1]!) return false; // 非严格递增 → 不算发散
  }
  return window[window.length - 1]! >= THINKING_DIVERGENCE_LEN;
}

/**
 * 把本轮思考量并入历史，滚动保留最近 WINDOW 轮。
 * 返回更新后的数组（不修改入参，便于 state 直接赋值）。
 */
export function pushThinkingLen(
  history: ReadonlyArray<number> | undefined,
  len: number,
): number[] {
  const next = [...(history ?? []), len];
  if (next.length > THINKING_DIVERGENCE_WINDOW) {
    return next.slice(-THINKING_DIVERGENCE_WINDOW);
  }
  return next;
}

/** 构造思考发散收敛提示（回注给模型，驱动它换策略）。 */
export function buildThinkingDivergenceMessage(history: ReadonlyArray<number>): string {
  const trail = history.slice(-THINKING_DIVERGENCE_WINDOW).join(" → ");
  return `<system-reminder>
检测到你最近几轮的思考量持续激增（思考字符数：${trail}），这通常意味着陷入了反复推演、难以收敛的"分析瘫痪"。
请立即改变策略，不要继续在头脑里推演：
1. 先用 todo_write 把当前卡住的问题拆成几个可验证的小步骤。
2. 用工具去获取事实（读代码 / 跑命令 / 查文档），用证据代替推测。
3. 如果某个判断确实无法靠推理定论，直接执行最小验证动作，或明确说明卡点并给出下一步。
请勿向用户提及本提醒。
</system-reminder>`;
}
