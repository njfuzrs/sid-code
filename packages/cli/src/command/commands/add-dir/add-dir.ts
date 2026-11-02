/**
 * 权限管理斜杠命令
 * /allow <rule> [-p] [--scope user|project]  — 添加 allow 规则（默认 session 级，-p 持久化）
 * /deny  <rule> [-p] [--scope user|project]  — 添加 deny 规则（默认 session 级，-p 持久化）
 * /permissions                                — 查看当前所有权限规则
 */

import { errorText } from "../../result.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import type { PermissionChecker } from "@sid-code/core/permission/checker.ts";

/**
 * /add-dir <目录> — 运行时把一个目录加入当前会话的可访问白名单（对标 claude-code /add-dir）。
 *
 * 这是**用户主动交互授权**：仅当前会话生效、不落盘、不扩大项目配置白名单，
 * 与 security.ts 禁止的"项目配置自动扩大目录白名单"性质不同。
 * /add-dir --list 查看当前白名单，/add-dir --remove <目录> 移除。
 */
export class AddDirCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const checker = this.getChecker(ctx);
    if (!checker) {
      return errorText("权限检查器未初始化");
    }
    // 运行时增删仅 PermissionChecker 实现（子代理 checker 等不一定有），做能力探测。
    if (typeof (checker as any).addAllowedDirectory !== "function") {
      return errorText("当前权限检查器不支持运行时目录白名单增删");
    }

    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const first = tokens[0];

    // /add-dir --list：展示当前可访问集合（工作区 + 追加目录）
    //
    // 白名单是**追加**语义，工作区不在 allowedDirectories 数组里也不该被挤出去。
    // 所以列表必须把工作区显式列出来——否则用户看到「只有一个目录」，
    // 会合理推断工作区已经不在了（这正是修复前那次采集事故的现场感受）。
    if (!first || first === "--list" || first === "-l") {
      const dirs = checker.getAllowedDirectories();
      const workspaceLine = `  · ${checker.getWorkspacePath()}  （工作区，始终可访问）`;
      if (dirs.length === 0) {
        return {
          type: "text",
          value:
            `当前会话未追加可访问目录（未限制到特定目录）:\n${workspaceLine}\n` +
            "用法: /add-dir <目录路径>  追加目录（仅本会话生效）",
        };
      }
      return {
        type: "text",
        value:
          `当前会话可访问目录（工作区 + ${dirs.length} 个追加目录）:\n` +
          `${workspaceLine}\n${dirs.map((d) => `  · ${d}`).join("\n")}`,
      };
    }

    // /add-dir --remove <目录>：移除
    if (first === "--remove" || first === "-r") {
      const target = tokens.slice(1).join(" ");
      if (!target) {
        return errorText("用法: /add-dir --remove <目录路径>");
      }
      const removed = checker.removeAllowedDirectory(target);
      return removed
        ? { type: "text", value: `已从当前会话白名单移除目录: ${target}` }
        : { type: "text", value: `目录不在白名单中（未移除）: ${target}` };
    }

    // /add-dir <目录>：新增（args 整体作为路径，容许路径含空格）
    const dir = args.trim();
    const { existsSync, statSync } = require("fs");
    const { resolve } = require("path");
    const resolved = resolve(dir);
    if (!existsSync(resolved)) {
      return errorText(`目录不存在: ${resolved}`);
    }
    try {
      if (!statSync(resolved).isDirectory()) {
        return errorText(`不是目录: ${resolved}`);
      }
    } catch (e) {
      return errorText(`无法访问目录: ${resolved}（${(e as Error)?.message}）`);
    }

    checker.addAllowedDirectory(resolved);
    // Q6：DirectoryAdded——运行时加入会话白名单之后（仅通知，fire-and-forget）
    ctx.hookSystem?.fireDirectoryAddedEvent(resolved).catch(() => {});
    return {
      type: "text",
      value: `✓ 已将目录加入当前会话可访问白名单: ${resolved}\n（用户级运行时授权，仅本会话生效，不写入配置文件）`,
    };
  }

  private getChecker(ctx: CommandContext): PermissionChecker | null {
    return (ctx as any).permissionChecker ?? null;
  }
}
