/**
 * 项目级扩展信任确认（B20 / D63 闭环）
 *
 * 为什么需要它：项目级 skill / 命令 / agent 跟仓库走，等于别人写的提示词。此前交互模式的
 * `onUntrusted` 直接返回全部文件并由 loader 持久化信任 —— 打开任何目录都会静默信任它带的
 * 扩展（本机 `trusted-extensions.json` 曾累计 102 个目录，含临时目录与家目录）。
 *
 * 判定全部 fail-closed：没有确认通道（无 TTY）、TUI 已接管 stdin、空回车 / EOF，一律不加载。
 * 只有用户显式答 y 的那一批才返回 —— loader 只持久化返回值，所以「拒绝」天然不落盘，
 * 下次启动会再问；内容 hash 变了也会再问（TrustManager 按 hash 存）。
 */

import { createHash } from "crypto";
import { relative } from "path";
import type { ParsedExtensionFile } from "./types.ts";

export interface TrustPromptOptions {
  /** 当前是否为 -p / headless：维持原语义，直接跳过不加载 */
  print: boolean;
  /** yes/no 确认通道；未提供（无 TTY）即 fail-closed */
  confirm?: (message: string) => Promise<boolean>;
  /** 列表里展示相对路径用 */
  projectDir: string;
  /** 不加载时的告警出口（logger.warn 之类） */
  warn: (message: string) => void;
}

export interface TrustPrompt {
  onUntrusted: (files: ParsedExtensionFile[]) => Promise<ParsedExtensionFile[]>;
  /**
   * TUI 启动后调用：stdin 已归 Ink，再起 readline 会抢输入。此后（热重载 / reload）
   * 遇到的新未信任文件只记日志不加载，下次启动时再问。
   */
  closePrompting: () => void;
}

/** 由路径推断扩展类型，仅用于提示文案 */
function kindOf(filePath: string): string {
  const m = /[/\\]\.(?:sid-code|claude)[/\\](skills|commands|agents)[/\\]/.exec(filePath);
  if (!m) return "扩展";
  return { skills: "skill", commands: "命令", agents: "agent" }[m[1] as "skills"];
}

function keyOf(file: ParsedExtensionFile): string {
  return `${file.filePath}\0${createHash("sha256").update(file.rawContent, "utf-8").digest("hex")}`;
}

export function createTrustPrompt(opts: TrustPromptOptions): TrustPrompt {
  let promptingOpen = true;
  // 本次进程内已拒绝的（路径 + 内容 hash）：skills 会被 discover / reload 多次扫描，
  // 拒绝过的不在同一会话里反复问。
  const rejected = new Set<string>();

  const onUntrusted = async (files: ParsedExtensionFile[]): Promise<ParsedExtensionFile[]> => {
    if (opts.print) return [];

    const pending = files.filter((f) => !rejected.has(keyOf(f)));
    if (pending.length === 0) return [];

    const list = pending
      .map(
        (f) => `  - [${kindOf(f.filePath)}] ${relative(opts.projectDir, f.filePath) || f.filePath}`,
      )
      .join("\n");

    if (!promptingOpen || !opts.confirm) {
      for (const f of pending) rejected.add(keyOf(f));
      opts.warn(
        `发现 ${pending.length} 个未信任的项目级扩展，${
          opts.confirm ? "会话已开始" : "无交互终端"
        }，本次不加载（下次启动时确认，或在用户级配置设 trust_project_extensions: true）：\n${list}`,
      );
      return [];
    }

    const ok = await opts.confirm(
      `当前项目带有 ${pending.length} 个未信任的项目级扩展（来自仓库，等于别人写的提示词）：\n${list}\n\n` +
        `信任后会加载并记住（内容变化后会再次询问）。`,
    );
    if (ok) return pending;
    for (const f of pending) rejected.add(keyOf(f));
    opts.warn(`已拒绝 ${pending.length} 个项目级扩展，本次不加载`);
    return [];
  };

  return {
    onUntrusted,
    closePrompting: () => {
      promptingOpen = false;
    },
  };
}
