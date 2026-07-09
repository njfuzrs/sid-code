/**
 * 权限管理斜杠命令
 * /allow <rule> [-p] [--scope user|project]  — 添加 allow 规则（默认 session 级，-p 持久化）
 * /deny  <rule> [-p] [--scope user|project]  — 添加 deny 规则（默认 session 级，-p 持久化）
 * /permissions                                — 查看当前所有权限规则
 */

import type { Command, CommandResult, AppContext } from "./types.ts";
import type { PermissionChecker } from "../permission/checker.ts";
import { detectShadowedRules } from "../permission/shadowed-rules.ts";

/** 解析 /allow /deny 的参数：剥离 -p/--persist/save 与 --scope，剩余拼回规则文本。 */
function parseRuleArgs(args: string): {
  rule: string;
  persist: boolean;
  scope: "user" | "project";
} {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let persist = false;
  let scope: "user" | "project" = "user";
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-p" || t === "--persist" || t === "save") {
      persist = true;
    } else if (t === "--scope" || t === "-s") {
      // 下一个 token 是 scope 值（user / project）。
      const val = tokens[i + 1];
      if (val === "project" || val === "user") {
        scope = val;
        i++; // 跳过已消费的值
      }
    } else if (t === "--project") {
      scope = "project";
    } else if (t === "--user") {
      scope = "user";
    } else {
      rest.push(t);
    }
  }
  return { rule: rest.join(" "), persist, scope };
}

/**
 * 把 allow/deny 规则持久化到 settings.json 的 permissions.allow / permissions.deny 数组。
 * 复用 /skills 的读-合并-补丁范式：只改 permissions 单顶层字段，其余原样保留
 * （禁整体覆盖 writeSettingsFile——见 settings 有损 round-trip 陷阱）。
 * 返回持久化结果描述（成功/已存在/失败），供命令拼进回显。
 */
function persistPermissionRule(
  behavior: "allow" | "deny",
  rule: string,
  scope: "user" | "project",
): string {
  try {
    const source = scope === "project" ? "projectSettings" : "userSettings";
    const { getSettingsForSource, patchSettingsFile } = require("../config/settings/index.ts");
    const { settings } = getSettingsForSource(source);
    // 保留用户已有的 allow/deny/ask/defaultMode，仅在对应数组里增量追加。
    const perms: Record<string, unknown> = { ...(settings?.permissions ?? {}) };
    const list: string[] = Array.isArray(perms[behavior]) ? [...(perms[behavior] as string[])] : [];
    if (list.includes(rule)) {
      return `（${scope} settings.json 中已存在该 ${behavior} 规则，未重复写入）`;
    }
    list.push(rule);
    perms[behavior] = list;
    patchSettingsFile(source, "permissions", perms);
    return `，并已保存到 ${scope} settings.json（跨会话生效）`;
  } catch (e) {
    return `（⚠ 持久化失败: ${(e as Error)?.message}，仅当前会话生效）`;
  }
}

export class AllowCommand implements Command {
  name() { return "allow"; }
  aliases() { return []; }
  description() { return "添加 allow 权限规则（默认当前会话，-p 持久化）"; }
  argumentHint() { return "<规则> [-p] [--scope user|project]"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const { rule, persist, scope } = parseRuleArgs(args);
    if (!rule) {
      return {
        kind: "error",
        message: "用法: /allow <规则> [-p] [--scope user|project]\n示例: /allow Bash(npm *)\n      /allow Bash(npm *) -p          持久化到 user settings.json\n      /allow Read(*) -p --scope project  持久化到项目 settings.json",
      };
    }

    const checker = this.getChecker(ctx);
    if (!checker) {
      return { kind: "error", message: "权限检查器未初始化" };
    }

    checker.getRuleLoader().addCommandRule("allow", rule);
    // 同步到旧版 rules
    checker.setRules(checker.getRuleLoader().toPermissionRule());

    const persistNote = persist
      ? persistPermissionRule("allow", rule, scope)
      : "（仅当前会话，加 -p 可持久化）";
    return { kind: "message", message: `已添加 allow 规则: ${rule}${persistNote}` };
  }

  private getChecker(ctx: AppContext): PermissionChecker | null {
    return (ctx as any).permissionChecker ?? null;
  }
}

export class DenyCommand implements Command {
  name() { return "deny"; }
  aliases() { return []; }
  description() { return "添加 deny 权限规则（默认当前会话，-p 持久化）"; }
  argumentHint() { return "<规则> [-p] [--scope user|project]"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const { rule, persist, scope } = parseRuleArgs(args);
    if (!rule) {
      return {
        kind: "error",
        message: "用法: /deny <规则> [-p] [--scope user|project]\n示例: /deny Bash(rm -rf *)\n      /deny Bash(rm -rf *) -p          持久化到 user settings.json\n      /deny Bash(curl *) -p --scope project  持久化到项目 settings.json",
      };
    }

    const checker = this.getChecker(ctx);
    if (!checker) {
      return { kind: "error", message: "权限检查器未初始化" };
    }

    checker.getRuleLoader().addCommandRule("deny", rule);
    checker.setRules(checker.getRuleLoader().toPermissionRule());

    const persistNote = persist
      ? persistPermissionRule("deny", rule, scope)
      : "（仅当前会话，加 -p 可持久化）";
    return { kind: "message", message: `已添加 deny 规则: ${rule}${persistNote}` };
  }

  private getChecker(ctx: AppContext): PermissionChecker | null {
    return (ctx as any).permissionChecker ?? null;
  }
}

export class PermissionsCommand implements Command {
  name() { return "permissions"; }
  aliases() { return ["perms"]; }
  description() { return "查看当前权限规则和模式"; }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    // 无参数 → 打开交互式权限管理面板
    if (!_args.trim()) {
      return { kind: "dialog", dialog: "permissions" };
    }

    const checker = this.getChecker(ctx);
    if (!checker) {
      return { kind: "error", message: "权限检查器未初始化" };
    }

    const lines: string[] = [];
    lines.push(`权限模式: ${ctx.config.permissionMode}`);
    lines.push("");

    const loader = checker.getRuleLoader();
    const allRules = loader.getAllRules();

    if (allRules.length === 0) {
      lines.push("当前无权限规则");
    } else {
      // 按来源分组显示
      const bySource = new Map<string, typeof allRules>();
      for (const rule of allRules) {
        const group = bySource.get(rule.source) || [];
        group.push(rule);
        bySource.set(rule.source, group);
      }

      for (const [source, rules] of bySource) {
        lines.push(`[${source}] (${rules.length} 条)`);
        for (const rule of rules) {
          const icon = rule.behavior === "allow" ? "✓" : rule.behavior === "deny" ? "✗" : "?";
          lines.push(`  ${icon} ${rule.behavior}: ${rule.rawRule}`);
        }
        lines.push("");
      }
    }

    // 阴影检测
    if (allRules.length > 1) {
      const shadows = detectShadowedRules(allRules);
      if (shadows.length > 0) {
        lines.push("⚠️ 阴影规则检测:");
        for (const s of shadows) {
          lines.push(`  ${s.description}`);
        }
        lines.push("");
      }
    }

    // denial tracking 状态
    const dt = checker.getDenialTracking();
    if (dt.totalDenials > 0) {
      lines.push(`拒绝追踪: 连续 ${dt.consecutiveDenials} 次, 累计 ${dt.totalDenials} 次`);
    }

    return { kind: "message", message: lines.join("\n") };
  }

  private getChecker(ctx: AppContext): PermissionChecker | null {
    return (ctx as any).permissionChecker ?? null;
  }
}
