/**
 * 权限管理斜杠命令
 * /allow <rule> [-p] [--scope user|project]  — 添加 allow 规则（默认 session 级，-p 持久化）
 * /deny  <rule> [-p] [--scope user|project]  — 添加 deny 规则（默认 session 级，-p 持久化）
 * /permissions                                — 查看当前所有权限规则
 */

import { errorText } from "../../result.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import type { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { detectShadowedRules } from "@sid-code/core/permission/shadowed-rules.ts";

export class PermissionsCommand implements LocalCommandModule {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    // 无参数 → 打开交互式权限管理面板
    if (!_args.trim()) {
      return { type: "dialog", dialog: "permissions" };
    }

    const checker = this.getChecker(ctx);
    if (!checker) {
      return errorText("权限检查器未初始化");
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

    return { type: "text", value: lines.join("\n") };
  }

  private getChecker(ctx: CommandContext): PermissionChecker | null {
    return (ctx as any).permissionChecker ?? null;
  }
}
