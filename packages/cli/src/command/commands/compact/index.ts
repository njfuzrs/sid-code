import type { UnifiedCommand } from "../../types.ts";

/**
 * /compact 命令定义（轻量，启动时加载）
 * 实现代码在 ./compact.ts，通过 load() 按需加载
 *
 * 无参：全量压缩；带参 `<比例|下标>`：G22 部分压缩（只压前半段，保留后半段原文）。
 */
const compact: UnifiedCommand = {
  type: "local",
  name: "compact",
  description: "压缩对话历史（无参全量 / 数字只压前半段 / 文本 focus 保留重点）",
  argumentHint: "[比例|下标|focus 指令]",
  source: "builtin",
  // 价值依赖形态（T6）：压缩只改内存态（compact.ts 的 ctxMgr.setMessages），收益要靠
  // **同进程的后续轮**读到压缩后的上下文才存在。`-p` 单轮压完即退出，结果随进程销毁，
  // 净效果是多付一次摘要 LLM 费用 + 往历史里多写一条文本（方案的 D4）。所以单轮拒绝、
  // 长驻放行。拒绝条件是形态而不是「第几轮」：stream-json 第一轮压的也是给后续轮用的。
  headless: {
    modes: ["stream-json", "bridge"],
    reason:
      "-p 单轮没有后续轮消费压缩结果：结果只改内存、不落盘，压完即随进程销毁，" +
      "只会多付一次摘要费用。要在长驻会话里压缩，请用 --input-format stream-json 或 Bridge。",
  },
  load: () => import("./compact.ts").then((m) => m.default),
};

export default compact;
