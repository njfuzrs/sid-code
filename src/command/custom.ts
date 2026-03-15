/**
 * 自定义斜杠命令
 * 从 .sid-code/commands/*.md 加载用户自定义命令
 * 文件名即命令名，支持参数替换 $1 $2 $@
 */

import type { Command, AppContext } from "./types.ts";
import { ExtensionLoader } from "../extension/loader.ts";
import { getLogger } from "../debug/logger.ts";

/** 保护命令名（不允许被自定义命令覆盖） */
const PROTECTED_NAMES = new Set([
  "help", "h", "?",
  "exit", "quit", "q",
  "clear", "compact", "cost",
  "config", "model", "m",
  "undo", "memory", "mem",
  "sessions",
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
 * 替换参数占位符
 * $1, $2, ... 替换为对应位置参数
 * $@ 替换为所有参数
 */
function substituteArgs(template: string, args: string): string {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let result = template;

  // 替换 $@ 为所有参数
  result = result.replace(/\$@/g, args.trim());

  // 替换 $1, $2, ... 为对应位置参数
  result = result.replace(/\$(\d+)/g, (_match, idx) => {
    const i = parseInt(idx) - 1;
    return i >= 0 && i < parts.length ? parts[i] : "";
  });

  return result;
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

  async execute(args: string, ctx: AppContext): Promise<void> {
    const text = substituteArgs(this._body, args);

    if (ctx.sendToLLM) {
      await ctx.sendToLLM(text);
    } else {
      // 降级：直接输出替换后的文本
      console.log(text);
    }
  }
}

/** 自定义命令加载器 */
export class CustomCommandLoader {
  private extensionLoader: ExtensionLoader;

  constructor(extensionLoader?: ExtensionLoader) {
    this.extensionLoader = extensionLoader ?? new ExtensionLoader();
  }

  /** 加载所有自定义命令 */
  async loadAll(projectDir?: string): Promise<CustomCommand[]> {
    const log = getLogger();
    const files = await this.extensionLoader.scan("commands", projectDir ?? process.cwd());
    const commands: CustomCommand[] = [];

    for (const file of files) {
      // 过滤保护命令名
      if (PROTECTED_NAMES.has(file.name)) {
        log.warn("CUSTOM_CMD", `跳过保护命令名: ${file.name}`);
        continue;
      }

      const description = (file.frontmatter.description as string) || extractDescription(file.body);
      commands.push(new CustomCommand(file.name, description, file.body));
    }

    if (commands.length > 0) {
      log.info("CUSTOM_CMD", `加载了 ${commands.length} 个自定义命令`, {
        names: commands.map(c => c.name()),
      });
    }

    return commands;
  }
}
