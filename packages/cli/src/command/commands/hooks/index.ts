import type { UnifiedCommand } from "../../types.ts";

/** /hooks 命令定义（轻量，启动时加载）。实现在 ./hooks.ts。 */
const hooks: UnifiedCommand = {
  type: "local",
  name: "hooks",
  aliases: [],
  description: "管理 Hook (list/enable/disable/enable-all/disable-all，-p 持久化)",
  argumentHint: "[list|enable|disable|enable-all|disable-all] [name] [-p]",
  source: "builtin",
  // 只放 list（A2 档，D13）：enable/disable 带 -p 会写 settings.json，
  // enable-all/disable-all 更是会话级全量开关，无头脚本静默改它没有场景。无参放行会返回
  // dialog（交互面板），分发层明确报错（非 0），不是假成功。
  headless: { subcommands: ["list"] },
  outputPanel: true,
  load: () => import("./hooks.ts").then((m) => new m.HooksCommand()),
};

export default hooks;
