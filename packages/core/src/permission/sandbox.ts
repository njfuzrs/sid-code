/**
 * macOS Seatbelt 沙箱管理器
 * 通过 sandbox-exec 限制 bash 命令的文件系统和网络访问
 * 仅 macOS 平台可用，其他平台降级为无沙箱
 */

import { homedir } from "os";
import { lookup } from "dns";
import * as net from "net";
import { getLogger } from "../debug/logger.ts";

/**
 * 把字符串安全地放进 Seatbelt profile 的双引号字面量。
 *
 * profile 用 `(subpath "...")` 这种形式，值里的 `"` 会提前闭合引号、
 * 反斜杠与换行会改写规则结构。cwd 与用户配置的额外路径都来自外部，
 * 不转义等于让路径内容能注入一条新的 allow 规则。
 */
function seatbeltQuoted(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "")
    .replace(/\n/g, "");
  return `"${escaped}"`;
}

/**
 * 把网络白名单里的主机名解析成 IP。
 *
 * Seatbelt 的 `remote ip` 过滤只认 IP 地址：写 "localhost" 匹配不到任何连接，
 * 而 profile 开头是 `(deny default)`，于是默认白名单是一条失效的放行，
 * 本意允许的本地网络实际被拒。解析失败的条目丢弃并记一条警告，
 * 而不是原样写进去假装它生效。
 */
/**
 * 主机名 → IP 的解析缓存。
 *
 * profile 生成是同步的，而 DNS 解析只有异步 API，所以解析提前在
 * `prepare()` 里做完放这里，生成时只读缓存。缓存未命中的主机名
 * 不写进 profile（写了也匹配不到），并记一条警告。
 */
const resolvedHostCache = new Map<string, string[]>();

/** 启动时调用：把白名单里的主机名解析成 IP 填进缓存。 */
export async function prepareSandboxHosts(hosts: string[]): Promise<void> {
  await Promise.all(hosts.map((host) => resolveOneHost(host)));
}

function resolveOneHost(host: string): Promise<void> {
  if (net.isIP(host)) {
    resolvedHostCache.set(host, [host]);
    return Promise.resolve();
  }
  if (resolvedHostCache.has(host)) return Promise.resolve();
  return new Promise((resolve) => {
    lookup(host, { all: true }, (err, addrs) => {
      const ips = err || !addrs ? [] : addrs.map((a) => a.address);
      resolvedHostCache.set(host, ips);
      if (ips.length === 0) {
        getLogger().warn("SANDBOX", `网络白名单主机无法解析成 IP，已忽略: ${host}`);
      }
      resolve();
    });
  });
}

function resolveSandboxHosts(hosts: string[]): string[] {
  const out: string[] = [];
  for (const host of hosts) {
    const ips = resolvedHostCache.get(host);
    if (!ips) {
      // 没跑过 prepare()：IP 字面量仍可用，主机名则无法生效。
      if (net.isIP(host)) out.push(host);
      else getLogger().warn("SANDBOX", `网络白名单主机尚未解析，已忽略: ${host}`);
      continue;
    }
    for (const addr of ips) {
      if (!out.includes(addr)) out.push(addr);
    }
  }
  return out;
}

/** 沙箱配置 */
export interface SandboxConfig {
  /** 是否启用沙箱 */
  enabled: boolean;
  /**
   * 沙箱启用时自动放行 Bash（减少弹窗）。**默认 false**，见 defaultSandboxConfig 的理由。
   * 放行仍不越过 plan / deny-write 模式硬约束（checker Step 7）。
   */
  autoAllowBashIfSandboxed: boolean;
  /** 允许写入的额外目录 */
  allowedWritePaths: string[];
  /** 允许读取的额外目录 */
  allowedReadPaths: string[];
  /** 网络白名单主机 */
  allowedHosts: string[];
}

/** 沙箱违规事件 */
export interface SandboxViolation {
  timestamp: string;
  type: "fs_read" | "fs_write" | "network";
  path?: string;
  host?: string;
  command: string;
  blocked: boolean;
}

/**
 * 默认沙箱配置。
 *
 * P2-3（2026-09-22）：`autoAllowBashIfSandboxed` 从 true 改为 **false**。
 *
 * 原设计是「开了沙箱就别再弹窗」，它的前提是 Seatbelt 能兜住漏出去的东西。
 * 实际 profile 里 `(allow file-write* (subpath "<cwd>"))` 放开了整个工作区，
 * 于是 `echo x > .git/hooks/pre-commit` 在 OS 层完全合法——
 * 「保护」依赖的那个被保护对象并不存在。
 *
 * 危险命令（checker Step 2）与敏感重定向（P1-4）都在自动放行**之前**，所以改默认值
 * 影响的只是「非危险、但也没有任何人看过」的那批 bash。想回到旧行为，
 * 在 settings.json / SandboxConfig 里显式写 `autoAllowBashIfSandboxed: true`
 * ——「少弹窗」值得是一个显式选择，不该是装上就有的隐式行为。
 */
export function defaultSandboxConfig(): SandboxConfig {
  return {
    enabled: false,
    autoAllowBashIfSandboxed: false,
    allowedWritePaths: [],
    allowedReadPaths: [],
    allowedHosts: ["localhost"],
  };
}

export class SandboxManager {
  private config: SandboxConfig;
  private violations: SandboxViolation[] = [];
  private workspacePath: string;

  constructor(config: SandboxConfig, workspacePath: string) {
    this.config = config;
    this.workspacePath = workspacePath;
  }

  /** 沙箱是否启用 */
  isEnabled(): boolean {
    return this.config.enabled && process.platform === "darwin";
  }

  /** 是否应该自动放行 Bash */
  shouldAutoAllowBash(): boolean {
    return this.isEnabled() && this.config.autoAllowBashIfSandboxed;
  }

  /** 获取违规记录 */
  getViolations(): SandboxViolation[] {
    return [...this.violations];
  }

  /** 记录违规事件 */
  recordViolation(violation: SandboxViolation): void {
    this.violations.push(violation);
    const log = getLogger();
    log.warn(
      "SANDBOX",
      `违规: ${violation.type} ${violation.path || violation.host || ""} (${violation.command.slice(0, 60)})`,
    );
  }

  /**
   * 生成 macOS Seatbelt profile
   * 限制文件系统访问：只允许工作区 + 临时目录 + 系统库
   */
  generateSeatbeltProfile(): string {
    const home = homedir();
    const cwd = this.workspacePath;

    const lines: string[] = [
      "(version 1)",
      "(deny default)",
      "",
      ";; 允许进程执行",
      "(allow process-exec)",
      "(allow process-fork)",
      "",
      ";; 允许读取工作目录",
      `(allow file-read* (subpath ${seatbeltQuoted(cwd)}))`,
      "",
      ";; 允许写入工作目录",
      `(allow file-write* (subpath ${seatbeltQuoted(cwd)}))`,
      "",
      ";; 允许读取系统库和工具链",
      '(allow file-read* (subpath "/usr/lib"))',
      '(allow file-read* (subpath "/usr/bin"))',
      '(allow file-read* (subpath "/usr/local"))',
      '(allow file-read* (subpath "/Library/Developer"))',
      '(allow file-read* (subpath "/Applications/Xcode.app"))',
      "",
      ";; 允许临时目录",
      '(allow file-read* file-write* (subpath "/tmp"))',
      '(allow file-read* file-write* (subpath "/private/tmp"))',
      "",
      ";; 允许读取 HOME 下的工具配置（只读）",
      `(allow file-read* (subpath ${seatbeltQuoted(`${home}/.bun`)}))`,
      `(allow file-read* (subpath ${seatbeltQuoted(`${home}/.nvm`)}))`,
      `(allow file-read* (subpath ${seatbeltQuoted(`${home}/.npm`)}))`,
      `(allow file-read* (subpath ${seatbeltQuoted(`${home}/.cargo`)}))`,
      "",
      ";; 禁止访问敏感目录",
      `(deny file-read* file-write* (subpath ${seatbeltQuoted(`${home}/.ssh`)}))`,
      `(deny file-read* file-write* (subpath ${seatbeltQuoted(`${home}/.gnupg`)}))`,
      `(deny file-read* file-write* (subpath ${seatbeltQuoted(`${home}/.sid-code`)}))`,
    ];

    // 额外允许的读取路径
    for (const p of this.config.allowedReadPaths) {
      lines.push(`(allow file-read* (subpath ${seatbeltQuoted(p)}))`);
    }

    // 额外允许的写入路径
    for (const p of this.config.allowedWritePaths) {
      lines.push(`(allow file-read* file-write* (subpath ${seatbeltQuoted(p)}))`);
    }

    // 网络白名单。
    //
    // Seatbelt 的 `remote ip` 过滤只认 IP 地址，写 "localhost" 匹配不到任何连接，
    // 而 profile 开头是 `(deny default)`——默认白名单等于一条失效的放行，
    // 本意允许的本地网络实际被拒。主机名在这里解析成地址再写入。
    lines.push("");
    lines.push(";; 网络访问");
    for (const host of resolveSandboxHosts(this.config.allowedHosts)) {
      lines.push(`(allow network* (remote ip ${seatbeltQuoted(`${host}:*`)}))`);
    }

    return lines.join("\n");
  }

  /**
   * 包装命令，添加沙箱限制
   * 非 macOS 或未启用时原样返回
   */
  wrapCommand(command: string): string {
    if (!this.isEnabled()) return command;

    const profile = this.generateSeatbeltProfile();
    // 转义单引号
    const escapedProfile = profile.replace(/'/g, "'\\''");
    const escapedCommand = command.replace(/'/g, "'\\''");
    return `sandbox-exec -p '${escapedProfile}' /bin/sh -c '${escapedCommand}'`;
  }
}
