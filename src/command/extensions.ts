/**
 * 扩展管理命令
 * 支持 skills/agents/commands 的列表查看和启用/禁用
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import { ArgParser } from "./args.ts";
import { ExtensionLoader } from "../extension/loader.ts";
import { getLogger } from "../debug/logger.ts";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import YAML from "yaml";

/** /skills 命令 */
export class SkillsCommand implements Command {
  name() { return "skills"; }
  aliases() { return []; }
  description() { return "Skills 管理"; }

  subCommands(): Command[] {
    return [
      new SkillsListCommand(),
      new SkillsEnableCommand(),
      new SkillsDisableCommand(),
    ];
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    // 默认显示列表
    return new SkillsListCommand().execute(args, ctx);
  }
}

/** /skills list - 列出所有 skills */
class SkillsListCommand implements Command {
  name() { return "list"; }
  aliases() { return ["ls"]; }
  description() { return "列出所有 skills"; }

  async execute(args: string, _ctx: AppContext): Promise<CommandResult> {
    const parser = new ArgParser(args);
    const showAll = parser.flag("all");

    const loader = new ExtensionLoader();
    const files = await loader.scan("skills", process.cwd());

    if (files.length === 0) {
      return {
        kind: "message",
        message: "未找到 skills\n在 .sid-code/skills/ 或 ~/.sid-code/skills/ 目录添加 .md 文件",
      };
    }

    // 读取禁用列表
    const disabled = this.getDisabledSkills();

    const lines = ["Skills 列表:"];
    const userSkills = files.filter(f => f.source === "user");
    const projectSkills = files.filter(f => f.source === "project");

    if (userSkills.length > 0) {
      lines.push("\n用户级 (~/.sid-code/skills/):");
      for (const skill of userSkills) {
        const status = disabled.includes(skill.name) ? "○ 已禁用" : "✓ 已启用";
        const desc = skill.frontmatter.description || "";
        lines.push(`  ${status} ${skill.name}${desc ? ` - ${desc}` : ""}`);
      }
    }

    if (projectSkills.length > 0) {
      lines.push("\n项目级 (.sid-code/skills/):");
      for (const skill of projectSkills) {
        const status = disabled.includes(skill.name) ? "○ 已禁用" : "✓ 已启用";
        const desc = skill.frontmatter.description || "";
        lines.push(`  ${status} ${skill.name}${desc ? ` - ${desc}` : ""}`);
      }
    }

    lines.push("\n提示:");
    lines.push("  /skills enable <name>  - 启用 skill");
    lines.push("  /skills disable <name> - 禁用 skill");

    return { kind: "message", message: lines.join("\n") };
  }

  private getDisabledSkills(): string[] {
    const configPath = resolve(homedir(), ".sid-code", "config.yaml");
    if (!existsSync(configPath)) return [];

    try {
      const content = readFileSync(configPath, "utf-8");
      const config = YAML.parse(content) || {};
      return config.disabled_skills || [];
    } catch {
      return [];
    }
  }
}

/** /skills enable - 启用 skill */
class SkillsEnableCommand implements Command {
  name() { return "enable"; }
  aliases() { return []; }
  description() { return "启用 skill"; }

  async execute(args: string, _ctx: AppContext): Promise<CommandResult> {
    const parser = new ArgParser(args);
    const name = parser.get(0);

    if (!name) {
      return { kind: "error", message: "用法: /skills enable <name> [--scope user|project]" };
    }

    const scope = parser.string("scope", "user") as "user" | "project";

    try {
      this.updateSkillStatus(name, "enable", scope);
      return {
        kind: "message",
        message: `Skill "${name}" 已在 ${scope} 配置中启用`,
      };
    } catch (err: any) {
      return { kind: "error", message: `启用失败: ${err.message}` };
    }
  }

  private updateSkillStatus(name: string, action: "enable" | "disable", scope: "user" | "project"): void {
    const log = getLogger();

    if (scope === "project") {
      // 项目级配置（.sid-code/config.yaml）
      const configPath = resolve(process.cwd(), ".sid-code", "config.yaml");
      let config: any = {};

      if (existsSync(configPath)) {
        const content = readFileSync(configPath, "utf-8");
        config = YAML.parse(content) || {};
      }

      if (!config.disabled_skills) config.disabled_skills = [];

      if (action === "enable") {
        config.disabled_skills = config.disabled_skills.filter((s: string) => s !== name);
      } else {
        if (!config.disabled_skills.includes(name)) {
          config.disabled_skills.push(name);
        }
      }

      writeFileSync(configPath, YAML.stringify(config), "utf-8");
      log.info("SKILLS", `已更新 ${configPath}`);
    } else {
      // 用户级配置
      const configPath = resolve(homedir(), ".sid-code", "config.yaml");
      let config: any = {};

      if (existsSync(configPath)) {
        const content = readFileSync(configPath, "utf-8");
        config = YAML.parse(content) || {};
      }

      if (!config.disabled_skills) config.disabled_skills = [];

      if (action === "enable") {
        config.disabled_skills = config.disabled_skills.filter((s: string) => s !== name);
      } else {
        if (!config.disabled_skills.includes(name)) {
          config.disabled_skills.push(name);
        }
      }

      writeFileSync(configPath, YAML.stringify(config), "utf-8");
      log.info("SKILLS", `已更新 ${configPath}`);
    }
  }
}

/** /skills disable - 禁用 skill */
class SkillsDisableCommand implements Command {
  name() { return "disable"; }
  aliases() { return []; }
  description() { return "禁用 skill"; }

  async execute(args: string, _ctx: AppContext): Promise<CommandResult> {
    const parser = new ArgParser(args);
    const name = parser.get(0);

    if (!name) {
      return { kind: "error", message: "用法: /skills disable <name> [--scope user|project]" };
    }

    const scope = parser.string("scope", "user") as "user" | "project";

    try {
      new SkillsEnableCommand()["updateSkillStatus"](name, "disable", scope);
      return {
        kind: "message",
        message: `Skill "${name}" 已在 ${scope} 配置中禁用`,
      };
    } catch (err: any) {
      return { kind: "error", message: `禁用失败: ${err.message}` };
    }
  }
}

/** /agents 命令 */
export class AgentsCommand implements Command {
  name() { return "agents"; }
  aliases() { return []; }
  description() { return "自定义 Agents 管理"; }

  subCommands(): Command[] {
    return [new AgentsListCommand()];
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    return new AgentsListCommand().execute(args, ctx);
  }
}

/** /agents list - 列出所有自定义 agents */
class AgentsListCommand implements Command {
  name() { return "list"; }
  aliases() { return ["ls"]; }
  description() { return "列出所有自定义 agents"; }

  async execute(_args: string, _ctx: AppContext): Promise<CommandResult> {
    const loader = new ExtensionLoader();
    const files = await loader.scan("agents", process.cwd());

    if (files.length === 0) {
      return {
        kind: "message",
        message: "未找到自定义 agents\n在 .sid-code/agents/ 或 ~/.sid-code/agents/ 目录添加 .md 文件",
      };
    }

    const lines = ["自定义 Agents:"];
    const userAgents = files.filter(f => f.source === "user");
    const projectAgents = files.filter(f => f.source === "project");

    if (userAgents.length > 0) {
      lines.push("\n用户级 (~/.sid-code/agents/):");
      for (const agent of userAgents) {
        const desc = agent.frontmatter.description || "";
        const tools = agent.frontmatter.tools || [];
        const toolsStr = Array.isArray(tools) ? ` [工具: ${tools.join(", ")}]` : "";
        lines.push(`  • ${agent.name}${desc ? ` - ${desc}` : ""}${toolsStr}`);
      }
    }

    if (projectAgents.length > 0) {
      lines.push("\n项目级 (.sid-code/agents/):");
      for (const agent of projectAgents) {
        const desc = agent.frontmatter.description || "";
        const tools = agent.frontmatter.tools || [];
        const toolsStr = Array.isArray(tools) ? ` [工具: ${tools.join(", ")}]` : "";
        lines.push(`  • ${agent.name}${desc ? ` - ${desc}` : ""}${toolsStr}`);
      }
    }

    return { kind: "message", message: lines.join("\n") };
  }
}

/** /commands 命令 */
export class CommandsListCommand implements Command {
  name() { return "commands"; }
  aliases() { return ["cmds"]; }
  description() { return "列出所有自定义命令"; }

  async execute(_args: string, _ctx: AppContext): Promise<CommandResult> {
    const loader = new ExtensionLoader();
    const files = await loader.scan("commands", process.cwd());

    if (files.length === 0) {
      return {
        kind: "message",
        message: "未找到自定义命令\n在 .sid-code/commands/ 或 ~/.sid-code/commands/ 目录添加 .md 文件",
      };
    }

    const lines = ["自定义命令:"];
    const userCommands = files.filter(f => f.source === "user");
    const projectCommands = files.filter(f => f.source === "project");

    if (userCommands.length > 0) {
      lines.push("\n用户级 (~/.sid-code/commands/):");
      for (const cmd of userCommands) {
        const desc = cmd.frontmatter.description || "";
        lines.push(`  /${cmd.name}${desc ? ` - ${desc}` : ""}`);
      }
    }

    if (projectCommands.length > 0) {
      lines.push("\n项目级 (.sid-code/commands/):");
      for (const cmd of projectCommands) {
        const desc = cmd.frontmatter.description || "";
        lines.push(`  /${cmd.name}${desc ? ` - ${desc}` : ""}`);
      }
    }

    return { kind: "message", message: lines.join("\n") };
  }
}
