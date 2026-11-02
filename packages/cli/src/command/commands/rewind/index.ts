import type { UnifiedCommand } from "../../types.ts";

/** /rewind 命令定义（轻量，启动时加载）。实现在 ./rewind.ts。 */
const rewind: UnifiedCommand = {
  type: "local",
  name: "rewind",
  // P0-B2：`/checkpoint`（单数）作为别名——CC 用户敲这个词期待的是「回退到某个检查点」，
  // 语义落在本命令而非 `/checkpoints`（复数，只列快照，别名 /cp）。不加别名会让 CC 习惯落空。
  aliases: ["checkpoint"],
  description: "回退会话（可选代码/对话/两者），等价 Esc+Esc",
  source: "builtin",
  load: () => import("./rewind.ts").then((m) => new m.RewindCommand()),
};

export default rewind;
