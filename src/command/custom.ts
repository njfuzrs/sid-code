/**
 * 自定义斜杠命令
 * 从 .sid-code/commands/*.md 加载用户自定义命令
 * 支持：$1/$@/{{args}} 参数替换、@{path} 文件注入、!{cmd} Shell 注入
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import { ExtensionLoader } from "../extension/loader.ts";
import type { ScanOptions } from "../extension/types.ts";
import { getLogger } from "../debug/logger.ts";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";

/** 保护命令名（不允许被自定义命令覆盖） */
const PROTECTED_NAMES = new Set([
  "help", "h", "?",
  "exit", "quit", "q",
  "clear", "compact", "cost",
  "config", "model", "m",
  "undo", "memory", "mem",
  "sessions", "rewind", "stats", "init", "mcp",
]);

/**
 * 从 markdown 第一行 HTML 注释提取描述
 * 格式：<!-- 这是描述 -->
 */
function extractDescription(body: string): string {
  const match = body.trimStart().match(/^<!--\s*(.*?)\s*-->/);
  return match?.[1] ?? "";
}

/**
 * 处理文件注入 @{path}
 * 读取文件内容并替换占位符，文件不存在时抛出错误
 */
async function processFileInjections(template: string): Promise<string> {
  const FILE_PATTERN = /@\{([^}]+)\}/g;
  const matches = [...template.matchAll(FILE_PATTERN)];
  if (matches.length === 0) return template;

  let result = template;
  for (const match of matches) {
    const filePath = match[1].trim();
    try {
      const absPath = resolve(process.cwd(), filePath);
      const content = readFileSync(absPath, "utf-8");
      const ext = filePath.split(".").pop() ?? "";
      const replacement = `以下是文件 \`${filePath}\` 的内容：\n\`\`\`${ext}\n${content}\n\`\`\``;
      result = result.replace(match[0], replacement);
    } catch {
      throw new Error(`文件注入失败：无法读取 "${filePath}"`);
    }
  }
  return result;
}

/**
 * 处理 Shell 注入 !{cmd}
 * 执行 shell 命令并将输出替换到模板中
 * 需要用户通过 ctx.confirmShellCommands 确认（如果提供）
 */
async function processShellInjections(
  template: string,
  ctx: AppContext,
): Promise<{ result: string; confirmed: boolean }> {
  const SHELL_PATTERN = /!\{([^}]+)\}/g;
  const matches = [...template.matchAll(SHELL_PATTERN)];
  if (matches.length === 0) return { result: template, confirmed: true };

  const commands = matches.map((m) => m[1].trim());

  // 如果有确认回调，先请求用户确认
  if (ctx.confirmShellCommands) {
    const confirmed = await ctx.confirmShellCommands(commands);
    if (!confirmed) {
      return { result: template, confirmed: false };
    }
  }

  let result = template;
  for (const match of matches) {
    const cmd = match[1].trim();
    try {
      const output = execSync(cmd, {
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      // 截断超长输出
      const truncated = output.length > 10000
        ? output.slice(0, 10000) + "\n... [输出已截断]"
        : output;
      result = result.replace(match[0], truncated.trimEnd());
    } catch (err: any) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      result = result.replace(match[0], `[命令执行失败: ${errMsg}]`);
    }
  }
  return { result, confirmed: true };
}

/**
 * 处理完整模板：参数替换 → 文件注入 → Shell 注入
 */
async function processTemplate(
  template: string,
  args: string,
  ctx: AppContext,
): Promise<{ text: string; confirmed: boolean }> {
  let result = template;

  // 1. 参数替换（兼容旧语法 $@ 和新语法 {{args}}）
  const parts = args.trim().split(/\s+/).filter(Boolean);
  result = result.replace(/\$@|\$\*/g, args.trim());
  result = result.replace(/\$(\d+)/g, (_match, idx) => {
    const i = parseInt(idx) - 1;
    return i >= 0 && i < parts.length ? parts[i] : "";
  });
  result = result.replace(/\{\{args\}\}/g, args.trim());

  // 2. 文件注入 @{path}
  result = await processFileInjections(result);

  // 3. Shell 注入 !{cmd}（需用户确认）
  const { result: shellResult, confirmed } = await processShellInjections(result, ctx);
  return { text: shellResult, confirmed };
}

/** 自定义命令实现 */
export class CustomCommand implements Command {
  private _name: string;
  private _description: string;
  private _body: string;

  constructor(name: string, description: string, body: string) {
    this._name = name;
    this._description = description;
    this._body = body;
  }

  name(): string { return this._name; }
  aliases(): string[] { return []; }
  description(): string { return this._description || `自定义命令: ${this._name}`; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    let text: string;
    let confirmed: boolean;

    try {
      ({ text, confirmed } = await processTemplate(this._body, args, ctx));
    } catch (err: any) {
      return { kind: "error", message: err.message };
    }

    if (!confirmed) {
      return { kind: "message", message: "已取消：用户拒绝执行 Shell 命令" };
    }

    return { kind: "submit_prompt", prompt: text };
  }
}

/** 自定义命令加载器 */
export class CustomCommandLoader {
  private extensionLoader: ExtensionLoader;

  constructor(extensionLoader?: ExtensionLoader) {
    this.extensionLoader = extensionLoader ?? new ExtensionLoader();
  }

  /**
   * 加载所有自定义命令
   * @param projectDir 项目目录（用于区分 user/project 来源）
   * @param scanOptions 扫描选项（信任检查等）
   */
  async loadAll(projectDir?: string, scanOptions?: ScanOptions): Promise<Array<{ cmd: CustomCommand; source: "user" | "project" }>> {
    const log = getLogger();
    const files = await this.extensionLoader.scan("commands", projectDir ?? process.cwd(), scanOptions);
    const results: Array<{ cmd: CustomCommand; source: "user" | "project" }> = [];

    for (const file of files) {
      if (PROTECTED_NAMES.has(file.name)) {
        log.warn("CUSTOM_CMD", `跳过保护命令名: ${file.name}`);
        continue;
      }

      const description = (file.frontmatter.description as string) || extractDescription(file.body);
      const cmd = new CustomCommand(file.name, description, file.body);
      const source: "user" | "project" = file.source === "user" ? "user" : "project";
      results.push({ cmd, source });
    }

    if (results.length > 0) {
      log.info("CUSTOM_CMD", `加载了 ${results.length} 个自定义命令`, {
        names: results.map((r) => r.cmd.name()),
      });
    }

    return results;
  }
}
