import type { UnifiedCommand } from "../../types.ts";

/** /memory 命令定义（轻量，启动时加载）。实现在 ./memory.ts。 */
const memory: UnifiedCommand = {
  type: "local",
  name: "memory",
  aliases: ["mem"],
  description: "管理记忆（无参打开交互面板）",
  argumentHint: "[auto|external|set|get|delete|list|search|show|reload] [参数]",
  source: "builtin",
  // T5：无头 cmdCtx 已注入 setAutoMemory/getAutoMemoryState/setExternalImportsApproved/
  // getExternalImportsState（memory.ts 里原本就有 `if (!ctx.xxx)` 的诚实拒绝分支，
  // 补上后走真实实现，不是假成功）。无参返回 dialog（面板）= 明确失败非 0。
  headless: true,
  outputPanel: true,
  load: () => import("./memory.ts").then((m) => new m.MemoryCommand()),
};

export default memory;
