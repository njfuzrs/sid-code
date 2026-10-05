/**
 * /ide 命令 — IDE 集成管理
 * 子命令：status / connect / disconnect
 *
 * 曾有 install 子命令（经 IDE CLI 装 sid-code 扩展），已撤掉：扩展本体已裁决不做、
 * 两个市场都查不到，执行必然失败。留着它等于给用户一条兑现不了的下一步。
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import { getIDEIntegration } from "@sid-code/core/ide/integration.ts";
import { detectIDEs } from "@sid-code/core/ide/detect.ts";
import { detectRunningIDEs } from "@sid-code/core/ide/process-tree.ts";

/** /ide 主命令 */
export class IDECommand implements Command {
  name() {
    return "ide";
  }
  aliases() {
    return [];
  }
  description() {
    return "IDE 集成管理";
  }
  argumentHint() {
    return "[status|connect|disconnect]";
  }

  subCommands(): Command[] {
    return [new IDEStatusCommand(), new IDEConnectCommand(), new IDEDisconnectCommand()];
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    // 默认显示状态
    return new IDEStatusCommand().execute(args, ctx);
  }
}

/** /ide status - 显示 IDE 连接状态 */
class IDEStatusCommand implements Command {
  name() {
    return "status";
  }
  aliases() {
    return ["ls"];
  }
  description() {
    return "显示 IDE 连接状态";
  }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    if (!ctx.mcpManager) {
      return { kind: "message", message: "MCP 管理器未初始化，无法管理 IDE 连接" };
    }

    const integration = getIDEIntegration(ctx.mcpManager, process.cwd());
    const { status, ideName } = integration?.getStatus() ?? { status: null, ideName: null };

    const lines = ["IDE 集成状态:"];
    const statusText =
      {
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
      lines.push("", await explainNoLockfile());
    }

    return { kind: "message", message: lines.join("\n") };
  }
}

/** /ide connect - 手动连接 IDE */
class IDEConnectCommand implements Command {
  name() {
    return "connect";
  }
  aliases() {
    return [];
  }
  description() {
    return "手动连接到 IDE";
  }

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
      return { kind: "message", message: await explainNoLockfile() };
    }
    if (detected.length > 1) {
      const list = detected.map((i) => `  - ${i.name} (${i.url})`).join("\n");
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
  name() {
    return "disconnect";
  }
  aliases() {
    return [];
  }
  description() {
    return "断开 IDE 连接";
  }

  async execute(_args: string, ctx: AppContext): Promise<CommandResult> {
    if (!ctx.mcpManager) {
      return { kind: "error", message: "MCP 管理器未初始化" };
    }
    const integration = getIDEIntegration(ctx.mcpManager, process.cwd());
    await integration?.disconnect();
    return { kind: "message", message: "已断开 IDE 连接" };
  }
}

/**
 * lockfile 缺失时的提示文案。
 *
 * 故意不导出：它的唯一消费者就是本文件的 explainNoLockfile，
 * 而命令体系门禁把「零生产调用的导出」算死代码，导出会让基线 +1。
 * 空列表（没检测到，或检测本身失败）必须退回通用文案 —— 一条提示不该点名一个不存在的 IDE。
 */
function noLockfileMessage(running: readonly string[]): string {
  if (running.length > 0) {
    const names = running.join("、");
    return `检测到 ${names} 正在运行，但没有发现 sid-code 扩展（~/.sid-code/ide/ 下没有 lockfile）\n需要 IDE 侧有实现 lockfile 协议的扩展在运行，sid-code 才能发现并连接`;
  }
  return "未发现可用 IDE\n需要 IDE 侧有实现 lockfile 协议的扩展在运行（~/.sid-code/ide/ 下写 <port>.lock）";
}

async function explainNoLockfile(): Promise<string> {
  return noLockfileMessage(await detectRunningIDEs());
}
