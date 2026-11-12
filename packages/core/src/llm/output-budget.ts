/**
 * 请求输出预算（request output budget）——「**本次请求**打算预留多少输出」。
 *
 * ## 为什么必须有这个模块
 *
 * 这是两个必须分开的概念，历史上被混成了一个：
 *
 * | 概念 | 含义 | 来源 |
 * |---|---|---|
 * | 物理上限 `maxOutputTokens` | 模型 / 渠道「**最多能**输出多少」 | `availableModels[].maxOutputTokens` > 能力目录 > 内置注册表 |
 * | 请求预算 | 本次请求「**打算**预留多少输出」 | `--max-tokens` / `SID_MAX_OUTPUT_TOKENS` / `CLAUDE_CODE_MAX_OUTPUT_TOKENS` > settings `maxTokens` > 默认常量 |
 *
 * 混用有两个后果，都已在排查报告里核实：
 *  - 发送侧（F1）：注册表里的物理上限（DeepSeek 384k）被原样当作每次请求的 `max_tokens`
 *    发出，而 OpenAI 兼容协议族按「输入 + max_tokens ≤ 窗口」校验，输入超过约 664k
 *    （= 1,048,576 − 384,000）就被 400 拒绝——为一次也没用到的 384k 输出让出 37% 输入空间。
 *  - 压缩侧（F8）：`ContextManager` 的「完成缓冲区」拿同一个物理上限算输出预留，
 *    1M 窗口下把 emergency 门槛抬到 140k（本该 52k），压缩提前触发。
 *
 * ## 本文件的演进
 *
 * 本 PR（F8）先落地「预算基准」这一半：**用户显式值 > 默认常量**，不含任何钳制。
 * 压缩缓冲区要的正是这个量级——它是「本次回复大概要写多少」的预估，不能随真实用量抖动
 * （否则阈值跟着输入量上下漂，压缩会在边缘反复触发）。
 *
 * 发送请求那一侧的完整形态（物理上限钳制 + 窗口剩余钳制 + 窗口不足时拒绝发送 +
 * 思考预算下限）由 F1 在同一文件里扩展，见
 * 《20261112-上下文占用虚高与窗口自学习-排查与根治方案》§5.1。
 */

/** 默认请求输出预算（所有模型通用，**不按模型名 / 模型族分档**）。
 *
 *  取 2^15 的依据（报告 §5.1 与 §7.2）：
 *  - `defaultConfig()` 的兜底值本来就是 `maxTokens: 32768`（`config/config.ts`），
 *    沿用它可以把「默认预算」与「兜底值」收敛成同一个数，不必再引入新的魔法数。
 *  - 全族实测 p99.9 均低于它（DeepSeek 10,995 / Claude 5,129 / GLM 19,616 /
 *    GPT 14,737 / Kimi 2,100），超过 32k 的请求只占 0.005%（2/41,961）。
 *  - 与 Claude Code 的默认输出上限同量级（CC 默认 32k，可经 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
 *    调整，sid-code 已兼容该环境变量）。 */
export const DEFAULT_REQUEST_MAX_TOKENS = 32_768;

/**
 * 解析「本次请求的输出预算」——只回答「打算预留多少」，**不做**物理上限 / 窗口钳制。
 *
 * 优先级：用户显式值（`--max-tokens` / `SID_MAX_OUTPUT_TOKENS` / settings `maxTokens`，
 * 收口在 `config._explicitMaxTokens`）> 默认常量。
 *
 * ⚠️ `availableModels[].maxOutputTokens` 是**物理上限**，不是预算，绝不要传进这里——
 * 用户写了 384k 渠道上限就每次请求发 384k，等于把 F1 原样复发。
 *
 * 非法值（undefined / NaN / ≤0）回退默认常量，绝不返回 0 或负数。
 */
export function resolveRequestBudget(explicitMaxTokens?: number): number {
  if (
    explicitMaxTokens !== undefined &&
    Number.isFinite(explicitMaxTokens) &&
    explicitMaxTokens > 0
  ) {
    return Math.floor(explicitMaxTokens);
  }
  return DEFAULT_REQUEST_MAX_TOKENS;
}
