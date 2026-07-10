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

/**
 * /add-dir <目录> — 运行时把一个目录加入当前会话的可访问白名单（对标 claude-code /add-dir）。
 *
 * 这是**用户主动交互授权**：仅当前会话生效、不落盘、不扩大项目配置白名单，
 * 与 security.ts 禁止的"项目配置自动扩大目录白名单"性质不同。
 * /add-dir --list 查看当前白名单，/add-dir --remove <目录> 移除。
 */
export class AddDirCommand implements Command {
  name() { return "add-dir"; }
  aliases() { return []; }
  description() { return "运行时把目录加入当前会话可访问白名单（用户级授权，仅本会话）"; }
  argumentHint() { return "<目录路径> | --list | --remove <目录>"; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const checker = this.getChecker(ctx);
    if (!checker) {
      return { kind: "error", message: "权限检查器未初始化" };
    }
    // 运行时增删仅 PermissionChecker 实现（子代理 checker 等不一定有），做能力探测。
    if (typeof (checker as any).addAllowedDirectory !== "function") {
      return { kind: "error", message: "当前权限检查器不支持运行时目录白名单增删" };
    }

    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const first = tokens[0];

    // /add-dir --list：展示当前白名单
    if (!first || first === "--list" || first === "-l") {
      const dirs = checker.getAllowedDirectories();
      if (dirs.length === 0) {
        return {
          kind: "message",
          message: "当前会话未配置目录白名单（未限制到特定目录）。\n用法: /add-dir <目录路径>  将目录加入白名单（仅本会话生效）",
        };
      }
      return {
        kind: "message",
        message: `当前会话可访问目录白名单（${dirs.length} 个）:\n${dirs.map((d) => `  · ${d}`).join("\n")}`,
      };
    }

    // /add-dir --remove <目录>：移除
    if (first === "--remove" || first === "-r") {
      const target = tokens.slice(1).join(" ");
      if (!target) {
        return { kind: "error", message: "用法: /add-dir --remove <目录路径>" };
      }
      const removed = checker.removeAllowedDirectory(target);
      return removed
        ? { kind: "message", message: `已从当前会话白名单移除目录: ${target}` }
        : { kind: "message", message: `目录不在白名单中（未移除）: ${target}` };
    }

    // /add-dir <目录>：新增（args 整体作为路径，容许路径含空格）
    const dir = args.trim();
    const { existsSync, statSync } = require("fs");
    const { resolve } = require("path");
    const resolved = resolve(dir);
    if (!existsSync(resolved)) {
      return { kind: "error", message: `目录不存在: ${resolved}` };
    }
    try {
      if (!statSync(resolved).isDirectory()) {
        return { kind: "error", message: `不是目录: ${resolved}` };
      }
    } catch (e) {
      return { kind: "error", message: `无法访问目录: ${resolved}（${(e as Error)?.message}）` };
    }

    checker.addAllowedDirectory(resolved);
    return {
      kind: "message",
      message: `✓ 已将目录加入当前会话可访问白名单: ${resolved}\n（用户级运行时授权，仅本会话生效，不写入配置文件）`,
    };
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
