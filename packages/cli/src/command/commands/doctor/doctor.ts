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
import { relative } from "path";
import { getLargeMemoryFiles, MAX_MEMORY_CHARACTER_COUNT } from "@sid-code/core/config/rules.ts";
import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import { SUCCESS_MARK, ERROR_MARK, WARNING_MARK } from "../../../ui/constants/figures.ts";
import { getSidHome, sidPaths } from "@sid-code/core/config/paths.ts";
import { collectDiskUsage, formatBytes } from "@sid-code/core/config/disk-usage.ts";
import { resolveRgCommand } from "@sid-code/core/tool/ripgrep.ts";
import { getVersion } from "@sid-code/shared/version.ts";

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

/**
 * P2-2：检查是否有超过建议上限的规则文件（CLAUDE.md / .claude/rules）。
 *
 * 对齐 CC `doctorContextWarnings.ts:57` —— 只**告警**，绝不截断内容。
 * 超限文件会让每一轮请求都多带这些字节（JIT 注入单调增长、永不移除），
 * 成本曲线是累积量而非单次量，所以值得在 doctor 里显式提醒用户拆分。
 *
 * 数据来自 `rules.ts` 的登记表（启动期主加载与 JIT 按需加载共用同一判定函数），
 * 因此本项只在**本次会话确实加载过**超限文件时才出现 —— 不做额外扫盘。
 */
function checkLargeRuleFiles(cwd: string): CheckItem[] {
  const large = getLargeMemoryFiles();
  if (large.length === 0) return [];
  return large.map(({ path, chars }) => {
    let shown = path;
    try {
      const rel = relative(cwd, path);
      if (rel && !rel.startsWith("..")) shown = rel;
    } catch {
      /* 相对化失败就用绝对路径 */
    }
    return {
      status: "warn" as const,
      label: "规则文件过大",
      detail:
        `${shown} 有 ${chars} 字符，超过建议上限 ${MAX_MEMORY_CHARACTER_COUNT}。` +
        `内容未被截断（全部生效），但会推高每轮请求成本，建议拆分到 .claude/rules/ 下按主题分文件。`,
    };
  });
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
    return {
      status: "ok",
      label: "工作目录",
      detail: `git 仓库${branch ? `，分支 ${branch}` : ""}`,
    };
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
    items.push({
      status: "fail",
      label: "模型",
      detail: "未配置（settings.json 无 model / 无 availableModels）",
    });
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

/**
 * `/doctor --disk`：按目录报 ~/.sid-code/ 的占用 + 各自保留策略 + 超期未回收量。
 *
 * 单独一个子视图而不并进主诊断，理由是它要扫盘（几千个文件，实测百毫秒级），
 * 而 `/doctor` 是常用的快速自检 —— 让每次自检都付这个代价不划算。
 *
 * **只读**：`collectDiskUsage()` 一个字节都不删。刻意先做可观测、不做自动删 ——
 * 让人能看见，比让程序替人决定删什么更安全（上一轮方案 §P2-12 否决过统一总量管理）。
 */
function renderEntries(report: ReturnType<typeof collectDiskUsage>): string[] {
  const lines: string[] = [];
  // 只列前 12 项 + 其余合并成一行。全列会把几十个小文件铺满屏，
  // 而这个视图的用途是"哪块在涨"，不是完整清单。
  const SHOWN = 12;
  const shown = report.entries.slice(0, SHOWN);
  const rest = report.entries.slice(SHOWN);
  const nameWidth = Math.max(...shown.map((e) => e.name.length));

  for (const e of shown) {
    const size = formatBytes(e.bytes).padStart(6);
    const name = e.name.padEnd(nameWidth);
    const cnt = e.isDir ? ` ${String(e.count).padStart(5)} 项` : "        ";
    // 未登记策略显式标成"未登记"而非留空——留空看着像"没问题"，
    // 而它的真实含义是"这块没人管"，恰恰是最该被看见的状态。
    const policy = e.retention ?? "⚠ 未登记（无人管理）";
    let staleNote = "";
    if (e.staleBytes != null && e.staleCount != null && e.staleCount > 0) {
      staleNote = `\n      └ 超期未回收 ${formatBytes(e.staleBytes)} / ${e.staleCount} 项`;
    }
    lines.push(`  ${size}${cnt}  ${name}  ${policy}${staleNote}`);
  }

  if (rest.length > 0) {
    const restBytes = rest.reduce((a, b) => a + b.bytes, 0);
    lines.push(`  ${formatBytes(restBytes).padStart(6)}         其余 ${rest.length} 项`);
  }
  return lines;
}

function renderDiskUsage(): string {
  const report = collectDiskUsage();
  const lines = [`~/.sid-code/ 磁盘占用（${report.root}）`, ""];

  // 空目录也要走到末尾的页脚（只读声明 + 与 du 的口径差异）。
  // 早退会让这两条说明在"首次运行/空目录"时凭空消失 —— 而那恰恰是最需要
  // 「这命令不会删我东西」这句保证的时候。
  if (report.entries.length === 0) {
    lines.push("  配置目录为空或不存在。");
  } else {
    lines.push(`  合计 ${formatBytes(report.totalBytes)}`, "");
    lines.push(...renderEntries(report));
  }

  if (report.unreadable.length > 0) {
    // 如实报出读不了的路径：静默当 0 会让用户以为占用不在那里
    lines.push("", `  ${WARNING_MARK} ${report.unreadable.length} 个路径无法读取（统计已跳过）`);
  }

  lines.push(
    "",
    `  ${SUCCESS_MARK} 本视图只读，不删除任何数据。过期数据由各模块策略与启动期兜底清理回收。`,
    // 用户拿这个数去和 du 对比是必然的，差异必须先说清楚，否则会被当成 bug
    `    统计的是逻辑字节（stat size）；du 报已分配块，会更大（小文件的块开销）。`,
  );
  return lines.join("\n");
}

const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    // --disk / disk：磁盘占用子视图（要扫盘，故不并进主诊断）
    if (/(^|\s)(--disk|disk)(\s|$)/.test(args ?? "")) {
      return { type: "text", value: renderDiskUsage() };
    }

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

    // P2-2：规则文件体积告警（只告警不截断，对齐 CC doctorContextWarnings）
    items.push(...checkLargeRuleFiles(ctx.cwd));

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
      lines.push(
        `${ERROR_MARK} 发现 ${failCount} 项异常${warnCount > 0 ? `、${warnCount} 项警告` : ""}，请按提示修复。`,
      );
    } else if (warnCount > 0) {
      lines.push(`${WARNING_MARK} ${warnCount} 项警告，核心功能可用。`);
    } else {
      lines.push(`${SUCCESS_MARK} 一切正常。`);
    }

    return { type: "text", value: lines.join("\n") };
  },
};

export default mod;
