/**
 * /lsp 命令 — LSP 代码智能系统管理
 * 子命令：status / reload
 *
 * ## 为什么需要这个命令（D15）
 *
 * `reinitializeLSP()` 早就实现好了、注释写着「插件刷新时调用」、逻辑完全正确
 * （关旧实例 → 清 registry → `initGeneration++` → 重新初始化），
 * **但生产调用点是 0**。而本该触发它的 `/reload-plugins` 完全不碰 LSP。
 *
 * 后果：改了 `.sid-code/lsp.json`（项目级 LSP 配置）后**无法在会话内生效**，
 * 只能重启进程。
 *
 * 这是「死接线」的第三种形态 —— **实现正确 + 注释声明了调用场景 + 零调用方**，
 * 和 Bridge 那条 `isEligibleForBridge`（D13）形态完全一致：
 * 读代码的人不会从注释里发现问题，因为注释描述的是一个**未完成的计划**，
 * 它读起来完全正常。
 *
 * 所以这里给出**一个显式的用户入口**，而不只是把它挂到 `/reload-plugins` 上：
 * 触发重载的真实场景是"我刚改了 lsp.json"，那和"我刚装了插件"是两件事。
 * （`/reload-plugins` 那条线也一并接上，见 `plugin.ts` —— 插件确实可能带来
 * 新的项目文件，顺手重载 LSP 是合理的；但它不该是**唯一**入口。）
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import {
  getLSPHealth,
  getLSPInitState,
  reinitializeLSP,
  waitForLSPReady,
} from "@sid-code/core/lsp/manager.ts";

/** /lsp 主命令 */
export class LSPCommand implements Command {
  name() {
    return "lsp";
  }
  aliases() {
    return [];
  }
  description() {
    return "LSP 代码智能管理（status/reload）";
  }

  subCommands(): Command[] {
    return [new LSPStatusCommand(), new LSPReloadCommand()];
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    // 默认显示状态
    return new LSPStatusCommand().execute(args, ctx);
  }
}

/** 初始化状态 → 人话 */
function describeInitState(state: string): string {
  switch (state) {
    case "success":
      return "✓ 已就绪";
    case "in-progress":
      return "… 初始化中";
    case "failed":
      return "✗ 初始化失败";
    case "not-started":
      return "— 未启动";
    default:
      return state;
  }
}

/** /lsp status — 显示 LSP 系统与各语言服务器状态 */
class LSPStatusCommand implements Command {
  name() {
    return "status";
  }
  aliases() {
    return ["ls"];
  }
  description() {
    return "显示 LSP 系统与各语言服务器状态";
  }

  async execute(_args: string, _ctx: AppContext): Promise<CommandResult> {
    const health = getLSPHealth();
    const lines = ["LSP 代码智能状态:", `  系统: ${describeInitState(health.initState)}`];

    if (health.initState === "not-started") {
      // 这不是异常：--print / --bridge 形态下 LSP 被刻意跳过（D16），
      // 不说清楚会让用户以为坏了。
      lines.push(
        "",
        "  提示: 无头（--print）与 Bridge 模式不启动 LSP —— 这些形态下没有交互式",
        "        编辑，索引开销是纯浪费。交互式会话里会自动启动。",
      );
      return { kind: "message", message: lines.join("\n") };
    }

    if (health.servers.length === 0) {
      lines.push(
        "",
        "  未注册任何语言服务器。",
        "  内置语言只要对应 language server 在 PATH 中即自动注册（零配置）；",
        "  也可在 .sid-code/lsp.json 或 ~/.sid-code/lsp.json 里手动配置。",
      );
      return { kind: "message", message: lines.join("\n") };
    }

    lines.push("", `  语言服务器（${health.servers.length} 个）:`);
    for (const s of health.servers) {
      const mark =
        s.state === "running"
          ? "✓"
          : s.state === "error" || s.restartsExhausted
            ? "✗"
            : s.state === "starting"
              ? "…"
              : "—";
      const detail: string[] = [s.state];
      if (s.crashCount > 0) detail.push(`崩溃 ${s.crashCount} 次`);
      // 「重启已耗尽」必须显式说出来：它意味着这个语言的智能功能**不会自己恢复**，
      // 而静默降级正是最难排查的一类。
      if (s.restartsExhausted) detail.push("已停止重启");
      lines.push(`    ${mark} ${s.name}（${detail.join("，")}）`);
    }

    return { kind: "message", message: lines.join("\n") };
  }
}

/** /lsp reload — 重新加载 LSP 配置并重启语言服务器 */
class LSPReloadCommand implements Command {
  name() {
    return "reload";
  }
  aliases() {
    return [];
  }
  description() {
    return "重新加载 lsp.json 配置并重启语言服务器";
  }

  async execute(_args: string, _ctx: AppContext): Promise<CommandResult> {
    const before = getLSPInitState();

    // `reinitializeLSP` 在 not-started 时是**空操作**（刻意如此：没起过就没什么可重载）。
    // 但用户敲了 /lsp reload 却什么都没发生会很困惑，所以这里说清楚为什么。
    if (before === "not-started") {
      return {
        kind: "message",
        message: [
          "LSP 未启动，无需重载。",
          "",
          "无头（--print）与 Bridge 模式不启动 LSP（索引开销在这些形态下是纯浪费）。",
          "交互式会话里 LSP 会自动初始化，届时本命令可用于让 lsp.json 的改动生效。",
        ].join("\n"),
      };
    }

    reinitializeLSP(process.cwd());

    // 等一小会儿再报状态：立刻返回会永远显示"初始化中"，用户无法判断成没成。
    // 3 秒是折中 —— 够冷启动一个常见 language server，又不至于让命令看起来卡住。
    const ready = await waitForLSPReady(3000);
    const health = getLSPHealth();

    const lines = [
      ready ? "LSP 已重新加载" : "LSP 重新加载中（尚未就绪，可稍后用 /lsp status 查看）",
      `  配置来源: .sid-code/lsp.json → ~/.sid-code/lsp.json → 内置语言（PATH 探测）`,
      `  语言服务器: ${health.servers.length} 个`,
    ];

    const broken = health.servers.filter((s) => s.state === "error" || s.restartsExhausted);
    if (broken.length > 0) {
      lines.push("", "  异常:");
      for (const s of broken) {
        lines.push(`    ✗ ${s.name}（崩溃 ${s.crashCount} 次）`);
      }
    }

    return { kind: "message", message: lines.join("\n") };
  }
}
