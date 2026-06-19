import type { UnifiedCommand } from "../../types.ts";

/**
 * /loop 命令定义（缺口 A：会话内调度的自然语言糖衣，轻量，启动时加载）
 *
 * 对标 claude-code 的 /loop，三种用法：
 * 1. 固定间隔：/loop 5m <prompt>  → 转 cron → 创建循环任务
 * 2. 动态间隔：/loop <prompt>      → 引导模型用 schedule_wakeup 自适应轮询
 * 3. 空跑：    /loop               → 列出当前定时任务
 *
 * 实现代码在 ./loop.ts，按需 load()。仅用户可调用（模型用底层 cron/wakeup 工具）。
 */
const loop: UnifiedCommand = {
  type: "local",
  name: "loop",
  description: "按间隔重复运行 prompt：/loop 5m <任务>（固定节奏）或 /loop <任务>（自适应轮询）",
  argumentHint: "[间隔如 5m] <要重复的任务>",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  load: () => import("./loop.ts").then((m) => m.default),
};

export default loop;
