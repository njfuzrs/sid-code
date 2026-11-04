/**
 * 扩展管理命令
 * 支持 skills/agents/commands 的列表查看和启用/禁用
 */

import { errorText } from "../../result.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import { ArgParser } from "../../args.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import {
  getSettings,
  getSettingsForSource,
  patchSettingsFile,
} from "@sid-code/core/config/settings/index.ts";

/** /skills 命令 */
export class SkillsCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    // 无参数 → 打开交互式 Skills 浏览面板
    if (!args.trim()) {
      return { type: "dialog", dialog: "skills" };
    }
    // 有参数 → 走子命令（list/enable/disable）
    return new SkillsListCommand().call(args, ctx);
  }
}

/** /skills list - 列出所有 skills */
export class SkillsListCommand implements LocalCommandModule {
  async call(args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    const parser = new ArgParser(args);
    const showAll = parser.flag("all");
    void showAll;

    // 走 SkillManager（含 builtin 释放+加载），与运行时实际加载链一致，
    // 否则会漏掉 builtin skill（旧实现自建 ExtensionLoader.scan 只扫 user/project）。
    const { SkillManager } = await import("@sid-code/core/skill/manager.ts");
    const manager = new SkillManager();
    await manager.discover(process.cwd());
    const skills = manager.getAllSkills();

    if (skills.length === 0) {
      return {
        type: "text",
        value:
          "未找到 skills\n在 .sid-code/skills/ 或 ~/.sid-code/skills/ 目录添加 .md 文件，或使用内置 skills",
      };
    }

    // 读取禁用列表
    const disabled = this.getDisabledSkills();

    const lines = ["Skills 列表:"];
    // 分组维度必须包含插件一档（缺陷 41）：插件 skill 的 loadedFrom 是 "plugin"
    // （buildNamespacedSkill 设置），source 也是 "plugin"（scanSingleDir 的来源标记）。
    // 旧实现按 source === "project" 分组、且插件的 source 被硬编码成 project，
    // 于是插件 skill 全部混进「项目级」—— 用户会去 .sid-code/skills/ 找它们，找不到。
    const builtinSkills = skills.filter((s) => s.loadedFrom === "builtin" || s.isBuiltin);
    const pluginSkills = skills.filter(
      (s) => s.loadedFrom === "plugin" || (s.source as string) === "plugin",
    );
    const userSkills = skills.filter(
      (s) =>
        s.loadedFrom !== "builtin" &&
        !s.isBuiltin &&
        s.loadedFrom !== "plugin" &&
        s.source === "user",
    );
    const projectSkills = skills.filter(
      (s) =>
        s.loadedFrom !== "builtin" &&
        !s.isBuiltin &&
        s.loadedFrom !== "plugin" &&
        s.source === "project",
    );

    const renderGroup = (title: string, group: typeof skills) => {
      if (group.length === 0) return;
      lines.push(`\n${title}`);
      for (const skill of group) {
        const status = disabled.includes(skill.name) ? "○ 已禁用" : "✓ 已启用";
        const desc = skill.description || "";
        lines.push(`  ${status} ${skill.name}${desc ? ` - ${desc}` : ""}`);
      }
    };

    renderGroup("内置 (builtin):", builtinSkills);
    renderGroup("插件 (plugin):", pluginSkills);
    renderGroup("用户级 (~/.sid-code/skills/):", userSkills);
    renderGroup("项目级 (.sid-code/skills/):", projectSkills);

    lines.push("\n提示:");
    lines.push("  /skills enable <name>  - 启用 skill");
    lines.push("  /skills disable <name> - 禁用 skill");

    return { type: "text", value: lines.join("\n") };
  }

  private getDisabledSkills(): string[] {
    try {
      const { settings } = getSettings();
      return settings.disabledSkills || [];
    } catch {
      return [];
    }
  }
}

/**
 * W1：把合并后的生效禁用列表推给当前会话（与 /skills 面板同一路径）。
 *
 * 旧实现只写盘、回复「已禁用」，当前会话里 /<skill> 与模型调用照常可用，重启才生效。
 * 返回是否真的热生效——拿不到注册表 / manager 时（headless 等）如实告诉用户要重启。
 */
function applyDisabledSkillsLive(ctx: CommandContext): boolean {
  const eff = getSettings().settings?.disabledSkills ?? [];
  if (ctx.unifiedRegistry) {
    ctx.unifiedRegistry.setDisabledSkills(eff);
    return true;
  }
  if (ctx.skillManager) {
    ctx.skillManager.setDisabledSkills(eff);
    return true;
  }
  return false;
}

/** /skills enable - 启用 skill */
export class SkillsEnableCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const parser = new ArgParser(args);
    const name = parser.get(0);

    if (!name) {
      return errorText("用法: /skills enable <name> [--scope user|project]");
    }

    const scope = parser.string("scope", "user") as "user" | "project";

    try {
      this.updateSkillStatus(name, "enable", scope);
      const live = applyDisabledSkillsLive(ctx);
      return {
        type: "text",
        value: `Skill "${name}" 已在 ${scope} 配置中启用${live ? "，当前会话已生效" : "，重启会话后生效"}`,
      };
    } catch (err: any) {
      return errorText(`启用失败: ${err.message}`);
    }
  }

  private updateSkillStatus(
    name: string,
    action: "enable" | "disable",
    scope: "user" | "project",
  ): void {
    const log = getLogger();

    // user → 用户全局 settings.json；project → 项目 .sid-code/settings.json
    const source = scope === "project" ? "projectSettings" : "userSettings";

    // 读取该来源的现有内容（仅为拿到 disabledSkills 当前值做增删；
    // 不能整体写回——见 patchSettingsFile 说明：writeSettingsFile 会经 Zod
    // 有损 round-trip + env 明文展开，抹掉密钥字段）。
    const { settings } = getSettingsForSource(source);
    const disabled = new Set(settings?.disabledSkills ?? []);

    if (action === "enable") {
      disabled.delete(name);
    } else {
      disabled.add(name);
    }

    // 外科式补丁：只改 disabledSkills 单字段，其余原样保留。
    patchSettingsFile(source, "disabledSkills", [...disabled]);
    log.info("SKILLS", `已更新 ${scope} settings.json: ${name} → ${action}`);
  }
}

/** /skills disable - 禁用 skill */
export class SkillsDisableCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const parser = new ArgParser(args);
    const name = parser.get(0);

    if (!name) {
      return errorText("用法: /skills disable <name> [--scope user|project]");
    }

    const scope = parser.string("scope", "user") as "user" | "project";

    try {
      new SkillsEnableCommand()["updateSkillStatus"](name, "disable", scope);
      const live = applyDisabledSkillsLive(ctx);
      return {
        type: "text",
        value: `Skill "${name}" 已在 ${scope} 配置中禁用${live ? "，当前会话已生效" : "，重启会话后生效"}`,
      };
    } catch (err: any) {
      return errorText(`禁用失败: ${err.message}`);
    }
  }
}
