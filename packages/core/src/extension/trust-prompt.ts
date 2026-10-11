/**
 * 项目级扩展信任确认（B20 / D63 闭环）
 *
 * 为什么需要它：项目级 skill / 命令 / agent 跟仓库走，等于别人写的提示词。此前交互模式的
 * `onUntrusted` 直接返回全部文件并由 loader 持久化信任 —— 打开任何目录都会静默信任它带的
 * 扩展（本机 `trusted-extensions.json` 曾累计 102 个目录，含临时目录与家目录）。
 *
 * ## 确认一律在 TUI 里做，不在终端里问
 *
 * 旧实现在 TUI 起来之前用 readline 问 `继续吗？[y/N]`：与 TUI 里的 MCP 审批框是两套样式，
 * 且 TUI 一接管 stdin 就关掉确认通道，会话中途（热重载 / 动态发现）遇到的新扩展只能静默
 * 不加载，整个会话里没有任何地方能批准它。
 *
 * 现在 `onUntrusted` **永不阻塞**：交互模式下把未信任文件记进待确认列表、本次扫描返回空
 * （不加载、不持久化），由 TUI 的「项目扩展信任」对话框读 `getPending()` 展示。
 * 用户批准后调用方负责 `TrustManager.trustBatch` 落盘并重扫，重扫时这批文件已是可信。
 *
 * 判定全部 fail-closed：-p / 无 TUI（Bridge、无 TTY）一律不加载；拒绝只在本进程内记住
 * （同一会话不反复问），不落盘，下次启动会再问；内容 hash 变了也会再问（TrustManager 按 hash 存）。
 */

import { createHash } from "crypto";
import { relative } from "path";
import type { ParsedExtensionFile } from "./types.ts";

export interface TrustPromptOptions {
  /** 当前是否为 -p / headless：维持原语义，直接跳过不加载 */
  print: boolean;
  /**
   * 本进程会不会起 TUI。false（Bridge / 无 TTY）时没有任何地方能批准，fail-closed 只记日志。
   */
  interactive: boolean;
  /** 列表里展示相对路径用 */
  projectDir: string;
  /** 不加载时的告警出口（logger.warn 之类） */
  warn: (message: string) => void;
}

/** TUI 对话框展示用的一条待确认扩展 */
export interface PendingExtension {
  /** skill / 命令 / agent / 扩展 */
  kind: string;
  /** 相对项目目录的路径（展示用） */
  displayPath: string;
  file: ParsedExtensionFile;
}

export interface TrustPrompt {
  onUntrusted: (files: ParsedExtensionFile[]) => Promise<ParsedExtensionFile[]>;
  /** 当前待确认的扩展快照（TUI 对话框读） */
  getPending: () => PendingExtension[];
  /**
   * 用户对当前这批待确认项的决定。返回被批准的文件（调用方负责落盘信任 + 重扫加载）；
   * 拒绝返回空数组，并在本进程内记住，不再重复询问。
   */
  decide: (approved: boolean) => ParsedExtensionFile[];
  /** 待确认列表从空变为非空 / 新增条目时回调（会话中途的热重载靠它把对话框拉起来） */
  onPendingChange: (listener: () => void) => void;
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
  // 本次进程内已拒绝的（路径 + 内容 hash）：skills 会被 discover / reload 多次扫描，
  // 拒绝过的不在同一会话里反复问。
  const rejected = new Set<string>();
  // 待确认：key → 文件。同一文件被 commands / skills 多次扫描时只记一份。
  const pending = new Map<string, ParsedExtensionFile>();
  const listeners: Array<() => void> = [];

  const toDisplay = (f: ParsedExtensionFile): PendingExtension => ({
    kind: kindOf(f.filePath),
    displayPath: relative(opts.projectDir, f.filePath) || f.filePath,
    file: f,
  });

  const onUntrusted = async (files: ParsedExtensionFile[]): Promise<ParsedExtensionFile[]> => {
    if (opts.print) return [];

    const fresh = files.filter((f) => !rejected.has(keyOf(f)) && !pending.has(keyOf(f)));
    if (fresh.length === 0) return [];

    if (!opts.interactive) {
      for (const f of fresh) rejected.add(keyOf(f));
      const list = fresh.map((f) => `  - [${kindOf(f.filePath)}] ${toDisplay(f).displayPath}`);
      opts.warn(
        `发现 ${fresh.length} 个未信任的项目级扩展，当前没有可确认的界面，本次不加载` +
          `（在交互式会话里确认，或在用户级配置设 trust_project_extensions: true）：\n${list.join("\n")}`,
      );
      return [];
    }

    // 交互模式：不阻塞扫描，记进待确认列表交给 TUI。本次返回空 = 不加载、不持久化。
    for (const f of fresh) pending.set(keyOf(f), f);
    for (const l of listeners) {
      try {
        l();
      } catch {
        /* 监听方异常不影响扫描 */
      }
    }
    return [];
  };

  return {
    onUntrusted,
    getPending: () => [...pending.values()].map(toDisplay),
    decide: (approved) => {
      const files = [...pending.values()];
      pending.clear();
      if (approved) return files;
      for (const f of files) rejected.add(keyOf(f));
      if (files.length > 0) opts.warn(`已拒绝 ${files.length} 个项目级扩展，本次不加载`);
      return [];
    },
    onPendingChange: (listener) => {
      listeners.push(listener);
    },
  };
}
