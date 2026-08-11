/**
 * /ide 命令 — IDE 集成管理
 * 子命令：status / connect / disconnect / install
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import { getIDEIntegration } from "@sid-code/core/ide/integration.ts";
import { detectIDEs } from "@sid-code/core/ide/detect.ts";

/** /ide 主命令 */
export class IDECommand implements Command {
  name() { return "ide"; }
  aliases() { return []; }
  description() { return "IDE 集成管理（status/connect/disconnect/install）"; }

  subCommands(): Command[] {
    return [
      new IDEStatusCommand(),
      new IDEConnectCommand(),
      new IDEDisconnectCommand(),
      new IDEInstallCommand(),
    ];
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    // 默认显示状态
    return new IDEStatusCommand().execute(args, ctx);
  }
}

/** /ide status - 显示 IDE 连接状态 */
class IDEStatusCommand implements Command {
  name() { return "status"; }
  aliases() { return ["ls"]; }
  description() { return "显示 IDE 连接状态"; }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    if (!ctx.mcpManager) {
      return { kind: "message", message: "MCP 管理器未初始化，无法管理 IDE 连接" };
    }

    const integration = getIDEIntegration(ctx.mcpManager, process.cwd());
    const { status, ideName } = integration?.getStatus() ?? { status: null, ideName: null };

    const lines = ["IDE 集成状态:"];
    const statusText = {
      connected: "✓ 已连接",
      pending: "… 连接中",
      disconnected: "✗ 已断开",
    }[status as string] || "○ 未连接";

    lines.push(`  状态: ${statusText}`);
    if (ideName) lines.push(`  IDE: ${ideName}`);

    // 列出当前工作区可发现的 IDE
    const detected = await detectIDEs(process.cwd());
    if (detected.length > 0) {
      lines.push("", "可发现的 IDE:");
      for (const ide of detected) {
        lines.push(`  - ${ide.name} (${ide.url})`);
      }
      if (status !== "connected") {
        lines.push("", "使用 /ide connect 连接");
      }
    } else if (status !== "connected") {
      lines.push("", "未发现可用 IDE（需要 IDE 扩展在 ~/.sid-code/ide/ 写入 lockfile）");
    }

    return { kind: "message", message: lines.join("\n") };
  }
}

/** /ide connect - 手动连接 IDE */
class IDEConnectCommand implements Command {
  name() { return "connect"; }
  aliases() { return []; }
  description() { return "手动连接到 IDE"; }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    if (!ctx.mcpManager) {
      return { kind: "error", message: "MCP 管理器未初始化" };
    }

    const integration = getIDEIntegration(ctx.mcpManager, process.cwd());
    if (!integration) {
      return { kind: "error", message: "无法初始化 IDE 集成" };
    }

    const detected = await detectIDEs(process.cwd());
    if (detected.length === 0) {
      return { kind: "message", message: "未发现可用 IDE\n请确认 IDE 扩展已安装并运行（/ide install 可安装扩展）" };
    }
    if (detected.length > 1) {
      const list = detected.map(i => `  - ${i.name} (${i.url})`).join("\n");
      return {
        kind: "message",
        message: `发现多个 IDE，请关闭多余实例后重试：\n${list}`,
      };
    }

    const ok = await integration.connectToIDE(detected[0]!);
    return ok
      ? { kind: "message", message: `已连接到 ${detected[0]!.name}` }
      : { kind: "error", message: `连接 ${detected[0]!.name} 失败` };
  }
}

/** /ide disconnect - 断开 IDE 连接 */
class IDEDisconnectCommand implements Command {
  name() { return "disconnect"; }
  aliases() { return []; }
  description() { return "断开 IDE 连接"; }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    if (!ctx.mcpManager) {
      return { kind: "error", message: "MCP 管理器未初始化" };
    }
    const integration = getIDEIntegration(ctx.mcpManager, process.cwd());
    await integration?.disconnect();
    return { kind: "message", message: "已断开 IDE 连接" };
  }
}

/** /ide install - 安装 IDE 扩展 */
class IDEInstallCommand implements Command {
  name() { return "install"; }
  aliases() { return []; }
  description() { return "安装 sid-code IDE 扩展"; }

  async execute(_args: string, _ctx: AppContext): Promise<CommandResult> {
    const { getTerminalIDEType, isExtensionInstalled, installExtension } =
      await import("@sid-code/core/ide/extension-install.ts");

    const ideType = getTerminalIDEType();
    if (!ideType) {
      return {
        kind: "message",
        message: "当前终端不在受支持的 IDE 中（VS Code / Cursor / Windsurf）\n无法自动安装扩展",
      };
    }

    if (await isExtensionInstalled(ideType)) {
      return { kind: "message", message: `${ideType} 扩展已安装` };
    }

    const result = await installExtension(ideType);
    return result.installed
      ? { kind: "message", message: `${ideType} 扩展安装成功，请重启 IDE 后使用 /ide connect` }
      : { kind: "error", message: `扩展安装失败: ${result.error ?? "未知错误"}` };
  }
}
