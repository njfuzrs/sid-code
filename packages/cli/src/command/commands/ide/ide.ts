/**
 * /ide 命令 — IDE 集成管理
 * 子命令：status / connect / disconnect
 *
 * 曾有 install 子命令（经 IDE CLI 装 sid-code 扩展），已撤掉：扩展本体已裁决不做、
 * 两个市场都查不到，执行必然失败。留着它等于给用户一条兑现不了的下一步。
 */

import { errorText } from "../../result.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import { getIDEIntegration } from "@sid-code/core/ide/integration.ts";
import { detectIDEs } from "@sid-code/core/ide/detect.ts";
import {
  detectRunningIDEs,
  DETECTABLE_IDE_DISPLAY_NAME,
  type DetectableIDE,
} from "@sid-code/core/ide/process-tree.ts";

/** /ide 主命令 */
export class IDECommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    // 默认显示状态
    return new IDEStatusCommand().call(args, ctx);
  }
}

/** /ide status - 显示 IDE 连接状态 */
export class IDEStatusCommand implements LocalCommandModule {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    if (!ctx.mcpManager) {
      return { type: "text", value: "MCP 管理器未初始化，无法管理 IDE 连接" };
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

    return { type: "text", value: lines.join("\n") };
  }
}

/** /ide connect - 手动连接 IDE */
export class IDEConnectCommand implements LocalCommandModule {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    if (!ctx.mcpManager) {
      return errorText("MCP 管理器未初始化");
    }

    const integration = getIDEIntegration(ctx.mcpManager, process.cwd());
    if (!integration) {
      return errorText("无法初始化 IDE 集成");
    }

    const detected = await detectIDEs(process.cwd());
    if (detected.length === 0) {
      return { type: "text", value: await explainNoLockfile() };
    }
    if (detected.length > 1) {
      const list = detected.map((i) => `  - ${i.name} (${i.url})`).join("\n");
      return {
        type: "text",
        value: `发现多个 IDE，请关闭多余实例后重试：\n${list}`,
      };
    }

    const ok = await integration.connectToIDE(detected[0]!);
    return ok
      ? { type: "text", value: `已连接到 ${detected[0]!.name}` }
      : errorText(`连接 ${detected[0]!.name} 失败`);
  }
}

/** /ide disconnect - 断开 IDE 连接 */
export class IDEDisconnectCommand implements LocalCommandModule {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    if (!ctx.mcpManager) {
      return errorText("MCP 管理器未初始化");
    }
    const integration = getIDEIntegration(ctx.mcpManager, process.cwd());
    await integration?.disconnect();
    return { type: "text", value: "已断开 IDE 连接" };
  }
}

/**
 * lockfile 缺失时的提示文案。
 *
 * 故意不导出：它的唯一消费者就是本文件的 explainNoLockfile，
 * 而命令体系门禁把「零生产调用的导出」算死代码，导出会让基线 +1。
 * 空列表（没检测到，或检测本身失败）必须退回通用文案 —— 一条提示不该点名一个不存在的 IDE。
 */
function noLockfileMessage(running: readonly DetectableIDE[]): string {
  if (running.length > 0) {
    // 必须经显示名映射：枚举值是内部判据，直接拼会输出小写的 `vscode`
    const names = running.map((ide) => DETECTABLE_IDE_DISPLAY_NAME[ide]).join("、");
    return `检测到 ${names} 正在运行，但没有发现 sid-code 扩展（~/.sid-code/ide/ 下没有 lockfile）\n需要 IDE 侧有实现 lockfile 协议的扩展在运行，sid-code 才能发现并连接`;
  }
  return "未发现可用 IDE\n需要 IDE 侧有实现 lockfile 协议的扩展在运行（~/.sid-code/ide/ 下写 <port>.lock）";
}

async function explainNoLockfile(): Promise<string> {
  return noLockfileMessage(await detectRunningIDEs());
}
