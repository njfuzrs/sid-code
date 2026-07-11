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
  description: "压缩对话历史（可选 <比例|下标> 只压前半段）",
  argumentHint: "[比例|下标]",
  source: "builtin",
  load: () => import("./compact.ts").then((m) => m.default),
};

export default compact;
