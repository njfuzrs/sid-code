/**
 * 权限管理斜杠命令
 * /allow <rule>     — 添加 allow 规则（session 级）
 * /deny <rule>      — 添加 deny 规则（session 级）
 * /permissions      — 查看当前所有权限规则
 */

import type { Command, CommandResult, AppContext } from "./types.ts";
import type { PermissionChecker } from "../permission/checker.ts";
import { detectShadowedRules } from "../permission/shadowed-rules.ts";

export class AllowCommand implements Command {
  name() { return "allow"; }
  aliases() { return []; }
  description() { return "添加 allow 权限规则（当前会话）"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const rule = args.trim();
    if (!rule) {
      return { kind: "error", message: "用法: /allow <规则>\n示例: /allow Bash(npm *)" };
    }

    const checker = this.getChecker(ctx);
    if (!checker) {
      return { kind: "error", message: "权限检查器未初始化" };
    }

    checker.getRuleLoader().addCommandRule("allow", rule);
    // 同步到旧版 rules
    checker.setRules(checker.getRuleLoader().toPermissionRule());

    return { kind: "message", message: `已添加 allow 规则: ${rule}` };
  }

  private getChecker(ctx: AppContext): PermissionChecker | null {
    return (ctx as any).permissionChecker ?? null;
  }
}

export class DenyCommand implements Command {
  name() { return "deny"; }
  aliases() { return []; }
  description() { return "添加 deny 权限规则（当前会话）"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const rule = args.trim();
    if (!rule) {
      return { kind: "error", message: "用法: /deny <规则>\n示例: /deny Bash(rm -rf *)" };
    }

    const checker = this.getChecker(ctx);
    if (!checker) {
      return { kind: "error", message: "权限检查器未初始化" };
    }

    checker.getRuleLoader().addCommandRule("deny", rule);
    checker.setRules(checker.getRuleLoader().toPermissionRule());

    return { kind: "message", message: `已添加 deny 规则: ${rule}` };
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
