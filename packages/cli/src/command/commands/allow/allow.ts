/**
 * 权限管理斜杠命令
 * /allow <rule> [-p] [--scope user|project]  — 添加 allow 规则（默认 session 级，-p 持久化）
 * /deny  <rule> [-p] [--scope user|project]  — 添加 deny 规则（默认 session 级，-p 持久化）
 * /permissions                                — 查看当前所有权限规则
 */

import { errorText } from "../../result.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import type { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { parseRuleArgs, persistPermissionRule } from "../shared/permissions.ts";

export class AllowCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const { rule, persist, scope } = parseRuleArgs(args);
    if (!rule) {
      return errorText(
        "用法: /allow <规则> [-p] [--scope user|project]\n示例: /allow Bash(npm *)\n      /allow Bash(npm *) -p          持久化到 user settings.json\n      /allow Read(*) -p --scope project  持久化到项目 settings.json",
      );
    }

    const checker = this.getChecker(ctx);
    if (!checker) {
      return errorText("权限检查器未初始化");
    }

    checker.getRuleLoader().addCommandRule("allow", rule);
    // 同步到旧版 rules
    checker.setRules(checker.getRuleLoader().toPermissionRule());

    const persistNote = persist
      ? persistPermissionRule("allow", rule, scope)
      : "（仅当前会话，加 -p 可持久化）";
    return { type: "text", value: `已添加 allow 规则: ${rule}${persistNote}` };
  }

  private getChecker(ctx: CommandContext): PermissionChecker | null {
    return (ctx as any).permissionChecker ?? null;
  }
}
