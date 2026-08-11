import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import { homedir, platform } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "fs";
import { getLogger } from "../../../debug/logger.ts";

/**
 * /terminal-setup 命令实现（按需加载）。P2-3。
 *
 * 目标：让不原生支持 Shift+Enter 换行的终端也能换行。三类分支：
 * 1) VSCode 系（TERM_PROGRAM=vscode，含 Cursor/Windsurf）：往用户 keybindings.json 注入
 *    shift+enter → workbench.action.terminal.sendSequence（发送 ESC+CR = \r）。
 * 2) 原生 CSI-u / Kitty 键盘协议终端（iTerm2/WezTerm/Ghostty/Kitty/Warp）：无需配置，直接换行可用。
 * 3) 其它终端：无法自动配置，提示用 `\`+Enter 兜底换行。
 *
 * 安全：写 keybindings.json 前先备份（.bak）；已存在同款绑定则不重复写。
 */

/** 原生支持 CSI-u / Kitty 键盘协议的终端（$TERM_PROGRAM → 展示名）。这些无需本命令。 */
const NATIVE_CSIU_TERMINALS: Record<string, string> = {
  ghostty: "Ghostty",
  kitty: "Kitty",
  "iterm.app": "iTerm2",
  wezterm: "WezTerm",
  warpterminal: "Warp",
};

/** VSCode 系终端（$TERM_PROGRAM=vscode 时进一步按 IDE CLI/配置目录名区分变体）。 */
interface VSCodeVariant {
  /** 展示名 */
  label: string;
  /** 用户配置目录名（~/Library/Application Support/<dir> 或 ~/.config/<dir> 或 %APPDATA%\<dir>） */
  configDir: string;
}

/** VSCode 键绑定条目结构。 */
interface VSCodeKeybinding {
  key: string;
  command: string;
  args?: { text: string };
  when?: string;
}

/** 极简 JSONC 解析：剥离 // 行注释与 /* *​/ 块注释后 JSON.parse。用户 keybindings.json 常带注释。 */
function parseJSONC(text: string): unknown {
  // 去掉块注释（非贪婪），再去行注释。字符串内的 // 场景极少见于 keybindings，容忍。
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const trimmed = stripped.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

/** 猜测 VSCode 变体：优先按 TERM_PROGRAM_VERSION/相关 env，回退到 __CFBundleIdentifier / 默认 Code。 */
function detectVSCodeVariant(): VSCodeVariant {
  const env = process.env;
  // Cursor / Windsurf 会设置各自的 env 或 bundle id。
  const bundleId = (env.__CFBundleIdentifier ?? "").toLowerCase();
  const appName = (env.TERM_PROGRAM ?? "").toLowerCase();
  const cursorHint = bundleId.includes("cursor") || !!env.CURSOR_TRACE_ID;
  const windsurfHint = bundleId.includes("windsurf") || !!env.WINDSURF_TRACE_ID;

  if (cursorHint) return { label: "Cursor", configDir: "Cursor" };
  if (windsurfHint) return { label: "Windsurf", configDir: "Windsurf" };
  // VSCode 变体默认。Insiders 单独目录。
  if (bundleId.includes("insiders") || appName.includes("insiders")) {
    return { label: "VSCode Insiders", configDir: "Code - Insiders" };
  }
  return { label: "VSCode", configDir: "Code" };
}

/** 求 VSCode 系用户 keybindings.json 路径（按平台）。 */
function getVSCodeKeybindingsPath(variant: VSCodeVariant): string {
  const home = homedir();
  const plat = platform();
  if (plat === "darwin") {
    return join(home, "Library", "Application Support", variant.configDir, "User", "keybindings.json");
  }
  if (plat === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, variant.configDir, "User", "keybindings.json");
  }
  // linux 及其它
  const xdg = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(xdg, variant.configDir, "User", "keybindings.json");
}

/**
 * 往 VSCode 系 keybindings.json 注入 Shift+Enter 换行绑定。
 * 返回面向用户的结果文本。幂等：已存在同款绑定则不重复写。
 */
function installVSCodeKeybinding(variant: VSCodeVariant): string {
  const log = getLogger();
  const path = getVSCodeKeybindingsPath(variant);
  const dir = join(path, "..");

  let keybindings: VSCodeKeybinding[] = [];
  let existed = false;
  if (existsSync(path)) {
    existed = true;
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = parseJSONC(raw);
      if (Array.isArray(parsed)) keybindings = parsed as VSCodeKeybinding[];
      else return `解析 ${variant.label} keybindings.json 失败（非数组结构），已跳过以免破坏配置。\n路径: ${path}`;
    } catch (e) {
      return `解析 ${variant.label} keybindings.json 失败，已跳过以免破坏配置。\n路径: ${path}\n原因: ${(e as Error)?.message ?? e}`;
    }
  }

  // 幂等检查：已存在等价绑定则不重复。
  const already = keybindings.find(
    (b) =>
      b?.key === "shift+enter" &&
      b?.command === "workbench.action.terminal.sendSequence" &&
      b?.when === "terminalFocus",
  );
  if (already) {
    return `${variant.label} 已存在 Shift+Enter 换行绑定，无需重复安装。\n路径: ${path}`;
  }

  const newBinding: VSCodeKeybinding = {
    key: "shift+enter",
    command: "workbench.action.terminal.sendSequence",
    args: { text: "\r" }, // ESC + CR：终端里被解读为换行而非提交。
    when: "terminalFocus",
  };
  keybindings.push(newBinding);

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 已有文件先备份（时间戳 .bak），坏了可回滚。
    if (existed) {
      const backup = `${path}.sid-code.bak`;
      try {
        copyFileSync(path, backup);
      } catch (e) {
        log.warn("TERMINAL_SETUP", `备份 keybindings.json 失败（继续写入）: ${(e as Error)?.message}`);
      }
    }
    writeFileSync(path, JSON.stringify(keybindings, null, 2), "utf-8");
    return `已为 ${variant.label} 安装 Shift+Enter 换行键绑定。\n路径: ${path}\n提示: 重启或重载 ${variant.label} 终端后生效。`;
  } catch (e) {
    log.error("TERMINAL_SETUP", `写入 keybindings.json 失败: ${(e as Error)?.message}`);
    return `写入 ${variant.label} keybindings.json 失败: ${(e as Error)?.message ?? e}\n路径: ${path}`;
  }
}

const mod: LocalCommandModule = {
  async call(_args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    const termProgram = (process.env.TERM_PROGRAM ?? "").toLowerCase();

    // 1) 原生 CSI-u / Kitty 协议终端：无需配置。
    const nativeName = NATIVE_CSIU_TERMINALS[termProgram];
    if (nativeName) {
      return {
        type: "text",
        value:
          `检测到 ${nativeName}：原生支持 Kitty/CSI-u 键盘协议，Shift+Enter 换行已可直接使用，无需额外配置。\n` +
          `若仍无法换行，可用 \\ + Enter 兜底换行。`,
      };
    }

    // 2) VSCode 系（含 Cursor/Windsurf）：注入 keybindings.json。
    if (termProgram === "vscode") {
      const variant = detectVSCodeVariant();
      const result = installVSCodeKeybinding(variant);
      return { type: "text", value: result };
    }

    // 3) 其它/未知终端：给兜底说明。
    const shown = process.env.TERM_PROGRAM || process.env.TERM || "未知终端";
    return {
      type: "text",
      value:
        `当前终端（${shown}）暂无自动配置方案。\n` +
        `换行方式：\n` +
        `  • 多数现代终端（iTerm2/WezTerm/Ghostty/Kitty）原生支持 Shift+Enter，直接可用。\n` +
        `  • VSCode/Cursor/Windsurf 内置终端请在其中运行 /terminal-setup 自动安装绑定。\n` +
        `  • 任何终端都可用 \\ + Enter 兜底换行。`,
    };
  },
};

export default mod;
export { parseJSONC, detectVSCodeVariant, getVSCodeKeybindingsPath, NATIVE_CSIU_TERMINALS };
