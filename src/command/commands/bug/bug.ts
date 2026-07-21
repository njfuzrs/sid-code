import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import { getVersion } from "../../../version.ts";

/**
 * /bug（别名 /feedback）命令实现（按需加载）。对齐 claude-code §4.5。
 *
 * 拼一段 Markdown bug 报告模板（含自动采集的环境信息段 + 问题描述占位），
 * 复制到剪贴板（OSC52，照抄 /copy 的 setClipboard 用法），并打印 GitLab issue 链接
 * 让用户去提。环境信息全部现成：版本号 / 平台 / Bun 版本 / 会话 ID / 模型 / 工作目录。
 *
 * 用法：
 *   /bug                — 生成空白模板
 *   /bug 描述问题的一句话 — 把参数填进「问题描述」段
 */

/** 从 git remote 推导 GitLab issue 新建页 URL。拿不到则回退到仓库主页占位。 */
function deriveIssueUrl(): string {
  try {
    // 同步读 git remote，避免引入异步 spawn 复杂度（命令是 immediate 短流程）。
    const { execSync } = require("child_process") as typeof import("child_process");
    const raw = execSync("git remote get-url origin", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // 归一化：去掉 .git 后缀，ssh 转 http。
    let base = raw.replace(/\.git$/, "");
    const sshMatch = base.match(/^git@([^:]+):(.+)$/);
    if (sshMatch) base = `http://${sshMatch[1]}/${sshMatch[2]}`;
    if (/^https?:\/\//.test(base)) return `${base}/-/issues/new`;
  } catch {
    // 非 git 仓库 / 无 origin / git 不可用 —— 回退。
  }
  return "http://gitlab.example.com/zhourusheng/sid-code/-/issues/new";
}

const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const desc = args.trim();
    const issueUrl = deriveIssueUrl();

    const report = [
      "## 环境信息",
      "",
      `- 版本: ${getVersion()}`,
      `- 平台: ${process.platform} ${process.arch}`,
      `- 运行时: Bun ${process.versions?.bun ?? "?"}`,
      `- 模型: ${ctx.config?.model ?? "未知"}`,
      `- 会话 ID: ${ctx.sessionId ?? "-"}`,
      `- 工作目录: ${ctx.cwd ?? process.cwd()}`,
      "",
      "## 问题描述",
      "",
      desc || "（请描述你遇到的问题：期望行为 vs 实际行为）",
      "",
      "## 复现步骤",
      "",
      "1. ",
      "2. ",
      "3. ",
      "",
    ].join("\n");

    let copied = false;
    try {
      const { setClipboard } = await import("../../../ink/termio/osc.ts");
      const oscSeq = await setClipboard(report);
      if (oscSeq) process.stdout.write(oscSeq);
      copied = true;
    } catch {
      copied = false;
    }

    const lines = [
      copied
        ? "✓ 已生成 bug 报告模板并复制到剪贴板。"
        : "已生成 bug 报告模板（剪贴板写入失败，可手动复制下方内容）。",
      "",
      `提交地址: ${issueUrl}`,
      "",
      "── 报告内容 ──",
      report,
    ];
    return { type: "text", value: lines.join("\n") };
  },
};

export default mod;
