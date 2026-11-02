import type { UnifiedCommand } from "../../types.ts";

/** /skills 命令定义（轻量，启动时加载）。实现在 ./skills.ts。 */
const skills: UnifiedCommand = {
  type: "local",
  name: "skills",
  aliases: [],
  description: "Skills 管理",
  source: "builtin",
  outputPanel: true,
  subCommands: () => [
    {
      type: "local",
      name: "list",
      aliases: ["ls"],
      description: "列出所有 skills",
      source: "builtin",
      load: () => import("./skills.ts").then((m) => new m.SkillsListCommand()),
    },
    {
      type: "local",
      name: "enable",
      aliases: [],
      description: "启用 skill",
      source: "builtin",
      load: () => import("./skills.ts").then((m) => new m.SkillsEnableCommand()),
    },
    {
      type: "local",
      name: "disable",
      aliases: [],
      description: "禁用 skill",
      source: "builtin",
      load: () => import("./skills.ts").then((m) => new m.SkillsDisableCommand()),
    },
  ],
  load: () => import("./skills.ts").then((m) => new m.SkillsCommand()),
};

export default skills;
