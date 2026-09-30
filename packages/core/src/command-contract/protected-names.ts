/**
 * 保护命令名（D7）：非内置来源一律不得占用。
 *
 * 这些名字是「出了问题时的逃生通道」（/help 找出路、/config 改配置、/clear 重置、
 * /q 退出……）。允许任何非内置来源占用它们，一个写坏的扩展就能让用户失去全部自救手段。
 *
 * **为什么下沉到 core 而不是留在 cli/src/command/custom.ts**：修复前名单只在
 * `CustomCommandLoader.loadAll` 里被检查，恰好挡住了优先级最低的那条非内置来源
 * （自定义命令），放过了优先级更高的 Skill（`.sid-code/skills/help/SKILL.md` 随 git 走）
 * 以及 plugin / MCP。检查点现在放在注册表的汇聚点（`UnifiedCommandRegistry` 的
 * `dedupe`），所有来源共用一份实现；放在 core 是为了让 core 侧消费方也能引用同一份名单。
 *
 * 名字与别名都在名单里：`q` / `m` / `h` / `?` / `mem` 分别是 exit / model / help / memory
 * 的别名，UI 层只前置拦截字面 `exit` / `quit`，别名不受那层保护。
 */
export const PROTECTED_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "help",
  "h",
  "?",
  "exit",
  "quit",
  "q",
  "clear",
  "compact",
  "cost",
  "config",
  "model",
  "m",
  "undo",
  "memory",
  "mem",
  "sessions",
  "rewind",
  "stats",
  "init",
  "mcp",
]);

/** 该名字是否为保护命令名（名字或别名都按此判定） */
export function isProtectedCommandName(name: string): boolean {
  return PROTECTED_COMMAND_NAMES.has(name);
}
