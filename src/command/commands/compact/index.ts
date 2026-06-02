import type { UnifiedCommand } from "../../types.ts";

/**
 * /compact 命令定义（轻量，启动时加载）
 * 实现代码在 ./compact.ts，通过 load() 按需加载
 */
const compact: UnifiedCommand = {
  type: "local",
  name: "compact",
  description: "压缩对话历史",
  source: "builtin",
  load: () => import("./compact.ts").then((m) => m.default),
};

export default compact;
