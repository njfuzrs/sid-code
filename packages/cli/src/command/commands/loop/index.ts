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
  // 价值依赖形态（T6）：固定间隔路径建的是**会话级**任务（durable=false，只活在本进程
  // 内存里），`-p` 单轮建完就随进程退出一起丢；动态路径引导模型调 schedule_wakeup，同样
  // 落成会话级任务、没有触发机会。长驻形态才有「下一次检查」这件事本身——触发通道是
  // App 在 stream-json / Bridge 下注册的 promptInjector（见 app.ts 的 runHeadlessSDK/runBridge）。
  headless: {
    modes: ["stream-json", "bridge"],
    reason:
      "-p 单轮建完即退出：定时任务是会话级的（只活在进程内存里），进程一退就丢，" +
      "也不会有下一次触发。要用循环任务请用 --input-format stream-json 或 Bridge。",
  },
  load: () => import("./loop.ts").then((m) => m.default),
};

export default loop;
