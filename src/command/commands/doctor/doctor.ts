/**
 * /doctor 命令实现
 * 环境自检诊断，输出一份健康报告。
 *
 * 检查项：sid-code 版本、运行时（Bun/平台）、配置目录与 settings.json、
 * 当前工作目录是否 git 仓库、ripgrep 可用性、当前模型 provider 配置完整性、
 * MCP server 连接状态。
 *
 * 视觉遵循 src/ui/CLAUDE.md：状态用 figures.ts 单色字形（✔/✘/⚠），禁彩色 emoji。
 * 绝不打印任何密钥值，api_key 只报「已配置/未配置」。
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import { SUCCESS_MARK, ERROR_MARK, WARNING_MARK } from "../../../ui/constants/figures.ts";
import { getSidHome, sidPaths } from "../../../config/paths.ts";
import { resolveRgCommand } from "../../../tool/ripgrep.ts";
import { getVersion } from "../../../version.ts";

/** 诊断项状态：ok=✔ / warn=⚠ / fail=✘ */
type CheckStatus = "ok" | "warn" | "fail";

interface CheckItem {
  status: CheckStatus;
  label: string;
  detail?: string;
}

function mark(status: CheckStatus): string {
  if (status === "ok") return SUCCESS_MARK;
  if (status === "warn") return WARNING_MARK;
  return ERROR_MARK;
}

/** 检查 cwd 是否 git 仓库。 */
function checkGitRepo(cwd: string): CheckItem {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    let branch = "";
    try {
      branch = execFileSync("git", ["branch", "--show-current"], {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      }).trim();
    } catch {
      branch = "(未知分支)";
    }
    return { status: "ok", label: "工作目录", detail: `git 仓库${branch ? `，分支 ${branch}` : ""}` };
  } catch {
    return { status: "warn", label: "工作目录", detail: "非 git 仓库（部分功能不可用）" };
  }
}

/** 检查配置目录与 settings.json。 */
function checkConfigDir(): CheckItem[] {
  const items: CheckItem[] = [];
  const home = getSidHome();
  if (existsSync(home)) {
    items.push({ status: "ok", label: "配置目录", detail: home });
  } else {
    items.push({ status: "warn", label: "配置目录", detail: `${home}（不存在，首次运行会创建）` });
    return items;
  }

  const settingsPath = sidPaths.settings();
  if (!existsSync(settingsPath)) {
    items.push({ status: "warn", label: "settings.json", detail: "不存在（用内置默认配置）" });
  } else {
    try {
      const raw = readFileSync(settingsPath, "utf-8");
      JSON.parse(raw);
      items.push({ status: "ok", label: "settings.json", detail: "可读，JSON 合法" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      items.push({ status: "fail", label: "settings.json", detail: `解析失败: ${msg}` });
    }
  }
  return items;
}

/** 检查 ripgrep 可用性（复用运行时解析逻辑）。 */
async function checkRipgrep(): Promise<CheckItem> {
  const rg = await resolveRgCommand();
  if (!rg) {
    return {
      status: "warn",
      label: "ripgrep",
      detail: "不可用（降级到系统 grep，搜索较慢）",
    };
  }
  // 区分来源：环境变量指定 / 嵌入释放 / 系统 PATH
  let source = "系统 PATH";
  const override = process.env.SID_RIPGREP_PATH?.trim();
  if (override && rg === override) {
    source = "SID_RIPGREP_PATH";
  } else if (rg.includes(getSidHome())) {
    source = "内嵌释放";
  }
  return { status: "ok", label: "ripgrep", detail: `${rg}（${source}）` };
}

/** 检查当前模型 provider 配置完整性（不打印任何密钥值）。 */
function checkModelProvider(ctx: CommandContext): CheckItem[] {
  const items: CheckItem[] = [];
  const { config } = ctx;

  if (!config.model) {
    items.push({ status: "fail", label: "模型", detail: "未配置（settings.json 无 model / 无 availableModels）" });
    return items;
  }
  items.push({
    status: "ok",
    label: "模型",
    detail: `${config.model}${config.provider ? `  [${config.provider}]` : ""}`,
  });

  // 定位当前模型对应的配置项，判断 api_key 是否配置（只报是否，不打印值）
  const modelConfig = config.availableModels.find((m) => m.name === config.model);
  const hasModelKey = !!(modelConfig?.apiKey && modelConfig.apiKey.trim());
  const hasProviderKey = !!(
    (config.anthropicKey && config.anthropicKey.trim()) ||
    (config.openaiKey && config.openaiKey.trim())
  );

  if (hasModelKey || hasProviderKey) {
    const via = hasModelKey ? "availableModels[].api_key" : "顶层 provider key";
    items.push({ status: "ok", label: "API Key", detail: `已配置（${via}）` });
  } else {
    items.push({
      status: "fail",
      label: "API Key",
      detail: "未配置（无法调用模型，请在 settings.json 填入 api_key）",
    });
  }

  const baseURL = modelConfig?.baseURL || config.baseURL;
  if (baseURL && baseURL.trim()) {
    items.push({ status: "ok", label: "API 地址", detail: baseURL });
  } else {
    items.push({ status: "warn", label: "API 地址", detail: "未配置（用 provider SDK 默认地址）" });
  }
  return items;
}

/** 检查 MCP server 连接状态（若已初始化）。 */
function checkMCP(ctx: CommandContext): CheckItem[] {
  if (!ctx.mcpManager) {
    return [{ status: "ok", label: "MCP", detail: "未配置" }];
  }
  const statuses = ctx.mcpManager.getStatus();
  if (statuses.length === 0) {
    return [{ status: "ok", label: "MCP", detail: "未配置" }];
  }
  const items: CheckItem[] = [];
  for (const s of statuses) {
    let status: CheckStatus = "ok";
    let stateText = "";
    switch (s.status) {
      case "connected":
        status = "ok";
        stateText = `已连接，${s.toolCount} 个工具`;
        break;
      case "connecting":
      case "reconnecting":
        status = "warn";
        stateText = s.status === "connecting" ? "连接中…" : "重连中…";
        break;
      case "disabled":
        status = "ok";
        stateText = "已禁用";
        break;
      case "failed":
        status = "fail";
        stateText = `连接失败${s.error ? `（${s.error}）` : ""}`;
        break;
      default:
        status = "warn";
        stateText = "未连接";
    }
    items.push({ status, label: `MCP · ${s.name}`, detail: stateText });
  }
  return items;
}

const mod: LocalCommandModule = {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const items: CheckItem[] = [];

    // 版本（getVersion 返回形如 "sid-code v0.1.586 (TypeScript)"）
    items.push({ status: "ok", label: "版本", detail: getVersion() });

    // 运行时
    const bunVer =
      typeof Bun !== "undefined" && Bun.version ? `Bun ${Bun.version}` : "（非 Bun 运行时）";
    items.push({
      status: "ok",
      label: "运行时",
      detail: `${bunVer}，Node ${process.version}，${process.platform}/${process.arch}`,
    });

    // 配置目录 + settings.json
    items.push(...checkConfigDir());

    // 工作目录（git）
    items.push(checkGitRepo(ctx.cwd));

    // ripgrep
    items.push(await checkRipgrep());

    // 模型 provider
    items.push(...checkModelProvider(ctx));

    // MCP
    items.push(...checkMCP(ctx));

    // 组装报告：字形靠颜色/形状区分，标签左对齐成列
    const labelWidth = Math.max(...items.map((i) => i.label.length));
    const lines = ["sid-code 环境诊断", ""];
    for (const item of items) {
      const pad = item.label.padEnd(labelWidth);
      const detail = item.detail ? `  ${item.detail}` : "";
      lines.push(`  ${mark(item.status)} ${pad}${detail}`);
    }

    // 汇总
    const failCount = items.filter((i) => i.status === "fail").length;
    const warnCount = items.filter((i) => i.status === "warn").length;
    lines.push("");
    if (failCount > 0) {
      lines.push(`${ERROR_MARK} 发现 ${failCount} 项异常${warnCount > 0 ? `、${warnCount} 项警告` : ""}，请按提示修复。`);
    } else if (warnCount > 0) {
      lines.push(`${WARNING_MARK} ${warnCount} 项警告，核心功能可用。`);
    } else {
      lines.push(`${SUCCESS_MARK} 一切正常。`);
    }

    return { type: "text", value: lines.join("\n") };
  },
};

export default mod;
