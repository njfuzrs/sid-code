/**
 * 产出量停滞检测（P2-1，对齐 claude-code diminishing-returns 设计哲学）
 *
 * CC 的核心哲学："diminishing returns 是从产出量角度检测停滞。比语义重复检测更简单、
 * 更快、误报率更低。" sid-code 已有 ContentLoopDetector（内容 hash 重复）、
 * ToolCallLoopDetector/ToolShapeLoopDetector（行为/模式重复），但缺一个从"产出量"
 * 角度检测——模型每轮都在产出，但产出越来越少、越来越没有实质内容。
 *
 * 与 ContentLoopDetector 的区别：内容检测抓"说了同样的话"，本检测器抓"话（和操作）
 * 本身分量很小"——两者互补，不要求重复，只要求持续低产出。
 *
 * 结构照抄 thinking-divergence.ts（measure/isXxx/push/build 四件套 + LoopState 字段 +
 * loop.ts 调用点），但判定逻辑不同：思考发散是"严格单调递增"，这里是"连续 WINDOW 轮
 * 全部低于阈值"（不要求单调——只要持续低产出，无论是否有波动，都算停滞）。
 *
 * 保守设计（吸取 P1-3 ToolShapeLoopDetector 假阳性教训）：只作软提醒，不占用
 * LoopDetector 的恢复计数、不会 terminate；命中次数上限 MAX_OUTPUT_STALL_INTERVENTIONS，
 * 且命中后清空历史，避免连续多轮反复刷屏同一个提醒。
 */

/** 检测窗口：观察最近 N 轮产出量 */
export const OUTPUT_STALL_WINDOW = 5;

/**
 * 单轮产出量阈值：低于此值视为"本轮几乎没有实质产出"。
 * 正常一次工具调用（哪怕文本很短）也会超过此值，只有连续多轮"既没什么文本、
 * 也没有工具调用"才会持续低于阈值。
 */
export const OUTPUT_STALL_VOLUME_THRESHOLD = 60;

/** 熔断最多介入次数（避免每轮刷屏；超过说明模型确实卡死，交由其他兜底处理） */
export const MAX_OUTPUT_STALL_INTERVENTIONS = 2;

/**
 * 每次工具调用为"产出量"贡献的固定权重。
 *
 * 2026-07-07 约束型误伤修复（Top 1）：权重从 40 提到 60，使**任意一次工具调用**
 * （60 ≥ OUTPUT_STALL_VOLUME_THRESHOLD）都不再低于阈值。此前 40 < 60，导致"单工具、
 * 无文本"的正常串行探索（逐个 read 文件、逐步单点 edit）连续 5 轮被误判"停滞"——
 * 而这正是日常最高频的合法工作流。提权后，只有**连续多轮既没什么文本、也完全没有
 * 工具调用**（纯空转 / 极短闲聊）才会持续低于阈值，与注释自述的语义对齐。
 */
const TOOL_USE_WEIGHT = 60;

/**
 * 产出停滞检测是否启用（默认关闭，对齐 Claude Code——CC 无此机制）。
 *
 * 为什么默认关闭 + 独立 env 门控（2026-07-07 决策，约束型误伤排查清单发现一）：
 * 产出停滞是启发式"纠偏"类约束，拦的是"模型可能走的弯路"而非"不可逆危害"。随模型
 * 能力提升，这类启发式正从"保护"退化成"负担"。更关键的是：此前它是 loop.ts 里独立的
 * state 字段逻辑，**绕过了 `SID_ENABLE_LOOP_DETECTION` 全局 gate**——用户以为关掉循环
 * 检测就关掉了所有启发式纠偏，实际它仍每轮在跑。现纳入独立、可逆的 env 开关，与
 * 循环检测样板一致：代码不删、仅默认关，需要时（如接入行为不稳定的弱模型）显式开启。
 *
 * 复用 SID_ENABLE_LOOP_DETECTION 作为总开关的一部分：开启循环检测时一并开启产出停滞
 * 检测（二者同属"防跑偏"启发式）；也可用 SID_ENABLE_OUTPUT_STALL=1 单独开启。
 */
export function isOutputStallDetectionEnabled(): boolean {
  return (
    process.env.SID_ENABLE_OUTPUT_STALL === "1" || process.env.SID_ENABLE_LOOP_DETECTION === "1"
  );
}

/**
 * 计算本轮的产出量：assistant 文本长度（trim 后）+ 工具调用数 × 固定权重。
 * 只要有工具调用，产出量通常就会显著超过阈值——本检测器主要捕捉"既没输出多少文本、
 * 也没调用工具"或"反复调用但每次调用都很轻量"的持续低产出场景。
 */
export function measureTurnOutputVolume(responseText: string, toolUseCount: number): number {
  return responseText.trim().length + toolUseCount * TOOL_USE_WEIGHT;
}

/**
 * 判断给定的产出量历史是否构成"停滞"：
 * 至少积累满 WINDOW 轮，且窗口内每一轮都低于 OUTPUT_STALL_VOLUME_THRESHOLD。
 * 不要求单调（区别于思考发散的严格递增判定）——只要持续低产出即可，哪怕轮次间有小幅波动。
 *
 * @param history 产出量历史（时间正序，最后一个是最新轮）
 */
export function isOutputStalling(history: ReadonlyArray<number>): boolean {
  if (history.length < OUTPUT_STALL_WINDOW) return false;
  const window = history.slice(-OUTPUT_STALL_WINDOW);
  return window.every((v) => v < OUTPUT_STALL_VOLUME_THRESHOLD);
}

/**
 * 把本轮产出量并入历史，滚动保留最近 WINDOW 轮。
 * 返回更新后的数组（不修改入参，便于 state 直接赋值）。
 */
export function pushOutputVolume(
  history: ReadonlyArray<number> | undefined,
  volume: number,
): number[] {
  const next = [...(history ?? []), volume];
  if (next.length > OUTPUT_STALL_WINDOW) {
    return next.slice(-OUTPUT_STALL_WINDOW);
  }
  return next;
}

/** 构造产出停滞提醒（回注给模型，引导它确认是否卡住、需要换思路）。 */
export function buildOutputStallMessage(history: ReadonlyArray<number>): string {
  const trail = history.slice(-OUTPUT_STALL_WINDOW).join(", ");
  return `<system-reminder>
检测到你最近 ${OUTPUT_STALL_WINDOW} 轮的产出量都很小（产出量：${trail}），这可能意味着陷入了停滞——
比如反复做同一件影响很小的事、或不确定下一步该做什么。
请确认一下：
1. 如果任务已经完成，直接说明并结束，不要为了"继续"而继续。
2. 如果卡在某个问题上，明确说出卡点是什么，换一种思路或工具去验证。
3. 如果任务确实需要很多轮小步操作才能完成，可以忽略本提醒，按计划继续。
请勿向用户提及本提醒。
</system-reminder>`;
}
