/**
 * macOS Seatbelt 沙箱管理器
 * 通过 sandbox-exec 限制 bash 命令的文件系统和网络访问
 * 仅 macOS 平台可用，其他平台降级为无沙箱
 *
 * ## 威胁模型（2026-11-05 重写，B2「开启即全挂」修复）
 *
 * 原实现是「读写都白名单」：只放行 cwd + 几个 `/usr/*` 目录。这条在现代 macOS 上
 * **根本跑不起来** —— macOS 11+ 的系统库不在 `/usr/lib` 而在 dyld 共享缓存里，
 * 进程启动还要 `sysctl-read` / `mach-lookup`（libSystem 初始化）与读 `/dev/null`，
 * 于是连 `/bin/echo hi` 都 SIGABRT（exit 134，2026-11-05 本机实测）。
 *
 * 现在的取舍（对齐 Claude Code / Codex CLI 的 macOS 做法）：
 * - **读**：默认放开，显式 deny 敏感目录（`~/.ssh`、`~/.gnupg`、凭据文件、sid home）；
 * - **写**：严格白名单（工作区 + 临时目录 + 用户配置的额外路径 + 几个设备文件）；
 * - **网络**：三档 `localhost`（默认）/ `all` / `none`。
 *
 * 防的是三件事：把秘钥读出来、写到工作区外（`~/.zshrc`、`~/Library/LaunchAgents`）、
 * 把数据外发。放弃的是「工作区外普通文件不可读」—— 它在原实现里也从未生效过
 * （开启即全挂），不是退步；而写与外发才是数据主权的实质。
 *
 * ⚠️ **Seatbelt 不支持按主机名/按 IP 放行外网**。`remote ip` 的 host 部分只接受
 * `*` 或 `localhost`（端口可以是 `*` 或具体数字），写 `"127.0.0.1:*"` 会让
 * sandbox-exec 直接报 `host must be * or localhost in network address` 并 exit 65
 * （2026-11-05 本机实测）。原实现的 `allowedHosts` + DNS 解析链是在为一个
 * Seatbelt 不提供的能力写代码，已整体删除。需要域名级过滤请走「本地过滤代理」方案
 * （独立特性，不在本次范围）。
 */

import { spawnSync } from "child_process";
import { realpathSync } from "fs";
import { homedir } from "os";
import { getSidHome } from "../config/paths.ts";
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
 * 网络档位。
 *
 * - `localhost`（默认）：只放行本机回环。⚠️ **不等于断网** —— 本机若开着
 *   `*_proxy` 之类的系统代理，走代理的外网请求会成功（代理就在 localhost）。
 *   这是刻意的取舍：企业环境几乎不可能没有代理，砍掉它等于让所有包管理器失效。
 * - `all`：不写任何 network 规则之外的限制，等价于放行全部。
 * - `none`：一条 network 规则都不写，`(deny default)` 下即全部拒绝。
 */
export type SandboxNetworkMode = "localhost" | "all" | "none";

/** 沙箱配置 */
export interface SandboxConfig {
  /** 是否启用沙箱 */
  enabled: boolean;
  /**
   * 沙箱启用时自动放行 Bash（减少弹窗）。**默认 false**，见 defaultSandboxConfig 的理由。
   * 放行仍不越过 plan / deny-write 模式硬约束（checker Step 7）。
   */
  autoAllowBashIfSandboxed: boolean;
  /** 允许写入的额外目录（realpath 后写进 profile；不存在则跳过并 warn） */
  allowedWritePaths: string[];
  /** 网络档位，默认 `localhost` */
  network: SandboxNetworkMode;
}

/**
 * 曾经的 `SandboxViolation` / `violations` / `getViolations()` / `recordViolation()`
 * 已于 2026-10-20 删除，**不要加回来**。
 *
 * 它们描述的是「哪条命令撞了哪条规则、撞的路径/主机是什么」，而 macOS 根本不把这些
 * 交给应用层：Seatbelt 的 denial 明细只写内核统一日志
 * （`kernel[0] (Sandbox) Sandbox: <cmd>(pid) deny(1) file-read-data <path>`），
 * 子进程 stderr 里只有它自己被拒后的 `Operation not permitted`（2026-10-20 本机实测，
 * 加 `(debug deny)` 也一样）。于是这几个字段没有任何真实数据来源，只能恒空——
 * 全仓零调用点，却让读代码/写文档的人以为存在「违规列表」这个可用能力。
 *
 * 现在的口径见下方 `noteCommandFailure()`：只做启发式归因日志，不虚构规则级明细。
 *
 * 同一理由，本模块也**不再提供** `allowedReadPaths`：读默认放开后它没有语义，
 * 留着只会让配置面看起来有一个不生效的旋钮。
 */

/**
 * stderr 里「权限拒绝」的可见特征。
 *
 * macOS 不会把 Seatbelt 的 denial 明细写进子进程 stderr（那是内核统一日志里的
 * `kernel[0] (Sandbox) Sandbox: <cmd>(pid) deny(1) ...`，2026-10-20 本机实测，
 * profile 里加 `(debug deny)` 也一样）。子进程能看到的只是被拒系统调用返回
 * EPERM/EACCES 后它自己的报错文本，所以这两个词是应用层唯一可用的信号。
 *
 * 它们同样出现在文件权限不足、只读文件系统等非沙箱场景，因此只能做「可能相关」的
 * 提醒，不能当成「沙箱拦截」的事实。
 */
const SANDBOX_DENIAL_STDERR_RE = /operation not permitted|permission denied/i;

/**
 * 读默认放开下仍然要挡住的 home 子目录（相对 `$HOME`）。
 *
 * 选的都是「拿到就等于拿到长期凭据」的位置：SSH/GPG 私钥、云厂商凭据、k8s 配置、
 * GitHub CLI token。**刻意不列入** `~/.npmrc` / `~/.gitconfig` / `~/.config/git`：
 * 私有源与提交身份依赖它们，deny 掉会让沙箱里的 `npm install` / `git commit`
 * 直接不可用（A2 用例会验证 `npm config get registry` 在沙箱内仍可读）。
 */
const SENSITIVE_HOME_DIRS = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".config/gh"] as const;

/** 单文件形态的敏感凭据（相对 `$HOME`，用 `literal` 精确到文件）。 */
const SENSITIVE_HOME_FILES = [".docker/config.json", ".netrc"] as const;

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
    network: "localhost",
  };
}

/**
 * 启动探针结果。
 *
 * 为什么要有它：`enableSandbox: true` 只说明「用户想开」，不说明「这台机器上真能跑」。
 * 原实现只看 `isEnabled()` 就打「已启用」，于是 profile 写坏时用户看到的是
 * 「已启用 + 每条 bash 都失败」，两条信息互相矛盾（2026-11-05 的实际状态）。
 */
export interface SandboxProbeResult {
  ok: boolean;
  /** 探针失败时的 stderr 首行（通常是 sandbox-exec 的语法/语义错误） */
  error?: string;
}

/**
 * 启动时写入轨迹的初始化报告。
 *
 * 为什么记这一条：B2 这个缺陷坏了两三个月没人发现，直接原因是
 * 「开了沙箱的会话里到底有没有命令真的进了沙箱」在轨迹上分辨不出来。
 * 有了 `enabled` / `probe_ok` / `sandboxed` 三个字段，
 * 「开了但降级」与「开了且在跑」才能从事件流里分开数。
 */
export interface SandboxInitReport {
  enabled: boolean;
  platform: string;
  probe_ok: boolean;
  probe_error?: string;
  network: SandboxNetworkMode;
  write_paths_count: number;
}

/** 轨迹事件名（`events.jsonl` 里的 `event` 字段）。 */
export const SANDBOX_INIT_EVENT_NAME = "sandbox_init";

let pendingInitReport: SandboxInitReport | null = null;
let initTraceSink: ((data: SandboxInitReport) => void) | null = null;

/**
 * 记一次沙箱初始化结果。
 *
 * 时序上 cli.ts 的沙箱初始化早于 app.ts 的 TraceCollector（后者要等 hookSystem），
 * 所以这里先存下来，等 sink 注入时补发一次 —— 与 `trace/jit-telemetry.ts`
 * 同一套「延迟接线」范式，不新建管道。
 */
export function recordSandboxInit(report: SandboxInitReport): void {
  pendingInitReport = report;
  flushSandboxInit();
}

/**
 * 注入轨迹写入通道（由 app.ts 在 collector 就绪后调用）。
 *
 * 传 null 表示没有轨迹采集；此时报告只是被丢弃，不影响沙箱行为本身。
 */
export function setSandboxInitTraceSink(sink: ((data: SandboxInitReport) => void) | null): void {
  initTraceSink = sink;
  flushSandboxInit();
}

function flushSandboxInit(): void {
  if (!initTraceSink || !pendingInitReport) return;
  const report = pendingInitReport;
  // 只补发一次：重复发送会让「开了沙箱的会话数」这个分母被同一会话重复计数。
  pendingInitReport = null;
  try {
    initTraceSink(report);
  } catch {
    /* 埋点失败不影响主流程 */
  }
}

/** 仅供测试：清空模块级 pending 状态，避免测试间互相污染。 */
export function __resetSandboxInitForTest(): void {
  pendingInitReport = null;
  initTraceSink = null;
}

export class SandboxManager {
  private config: SandboxConfig;
  private workspacePath: string;
  /**
   * 本会话的 shell 快照文件（realpath 后写进 profile 的 literal 放行）。
   *
   * 为什么必须放行：内层 shell 的第一条命令就是 `source <快照>`，
   * 而快照落在 `~/.sid-code/shell-snapshots/`，恰好被 sid home 的 deny 覆盖。
   * POSIX mode 的 shell 里 `source` 一个读不了的文件是**特殊内建致命错误**
   * （`|| true` 救不回来，shell 直接退出），用户命令一行都不会执行（D3）。
   */
  private snapshotPath: string | undefined;
  /** profile 生成结果缓存（cwd / 配置 / 快照在会话内不变，避免每条 bash 重算 + 刷 warn） */
  private cachedProfile: string | null = null;

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

  /**
   * 注册本会话的 shell 快照路径（BashTool 在快照就绪后调用）。
   *
   * 值没变时不失效缓存：BashTool 在 execute 里会兜底重复注入（覆盖
   * 「setSandboxManager 早于快照就绪」与反向两种时序），重复失效只会让 profile 重算。
   */
  setSnapshotPath(path: string | undefined): void {
    if (this.snapshotPath === path) return;
    this.snapshotPath = path;
    this.cachedProfile = null;
  }

  /** 本次 profile 实际放行的写路径数量（进 `sandbox_init` 事件，便于判断配置是否生效） */
  writePathsCount(): number {
    return this.collectWritePaths().length;
  }

  /**
   * 命令失败时的沙箱归因日志（启发式，不做规则级归属）。
   *
   * 为什么不记违规对象：denial 的路径/主机/规则只在内核统一日志里，应用层拿不到；
   * 强行记录只能靠猜，而且会重新造出一个没人读的列表。这里只回答「这条失败可能与
   * 沙箱有关」，给排查 profile 过紧/过松留一个 `[SANDBOX]` grep 锚点。
   *
   * @returns 是否打了一条归因日志。返回值供单测断言，不参与业务判断。
   */
  noteCommandFailure(command: string, stderr: string): boolean {
    if (!this.isEnabled()) return false;
    if (!SANDBOX_DENIAL_STDERR_RE.test(stderr)) return false;
    getLogger().warn(
      "SANDBOX",
      `命令在沙箱内失败，stderr 出现权限拒绝（可能是沙箱拦截，也可能是文件权限/只读文件系统）: ${command.slice(0, 80)}`,
    );
    return true;
  }

  /**
   * 生成 macOS Seatbelt profile（结果按会话缓存）。
   *
   * 规则顺序有意义：Seatbelt 里**后写的规则覆盖先写的**。
   * 所以「先 `(allow file-read*)` 再 deny 敏感目录、最后 allow 快照 literal」
   * 这个顺序不能调 —— 快照的 literal 放行必须在 sid home 的 deny 之后。
   */
  generateSeatbeltProfile(): string {
    if (this.cachedProfile === null) this.cachedProfile = this.buildSeatbeltProfile();
    return this.cachedProfile;
  }

  private buildSeatbeltProfile(): string {
    const lines: string[] = [
      "(version 1)",
      "(deny default)",
      "",
      ";; 进程",
      "(allow process-exec)",
      "(allow process-fork)",
      "(allow signal (target same-sandbox))",
      "",
      ";; 进程启动必需（libSystem / dyld 初始化）：缺任一条命令直接 SIGABRT（exit 134）",
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      "(allow ipc-posix-shm)",
      "(allow file-ioctl)",
      "",
      ";; 读：默认放开，敏感目录显式 deny",
      ";; 为什么不做读白名单：macOS 11+ 的系统库在 dyld 共享缓存里，进程启动还要",
      ";; sysctl / mach 服务，最小可读集合每个 macOS 大版本都变，枚举维护不住。",
      "(allow file-read*)",
    ];

    const home = homedir();
    for (const rel of SENSITIVE_HOME_DIRS) {
      const real = this.realpathForProfile(`${home}/${rel}`, "敏感目录");
      if (real) lines.push(`(deny file-read* (subpath ${seatbeltQuoted(real)}))`);
    }
    for (const rel of SENSITIVE_HOME_FILES) {
      const real = this.realpathForProfile(`${home}/${rel}`, "敏感文件");
      if (real) lines.push(`(deny file-read* (literal ${seatbeltQuoted(real)}))`);
    }
    // 用 getSidHome() 而不是硬编码 ${home}/.sid-code：尊重 SID_CONFIG_DIR，
    // 也让测试能把「配置/轨迹不可读」这条断言跑在临时目录上。
    const sidHome = this.realpathForProfile(getSidHome(), "sid-code 配置目录");
    if (sidHome) lines.push(`(deny file-read* (subpath ${seatbeltQuoted(sidHome)}))`);

    if (this.snapshotPath) {
      const snapshot = this.realpathForProfile(this.snapshotPath, "shell 快照");
      if (snapshot) {
        lines.push("");
        lines.push(";; 例外：本会话的 shell 快照必须可读，否则内层 shell 的 source 会致命退出");
        lines.push(`(allow file-read* (literal ${seatbeltQuoted(snapshot)}))`);
      }
    }

    lines.push("");
    lines.push(";; 写：白名单（不在列表里的一律拒绝）");
    for (const p of this.collectWritePaths()) {
      lines.push(`(allow file-write* (subpath ${seatbeltQuoted(p)}))`);
    }
    // ⚠️ 多条规则分开写，不要合成 `(allow file-write* (literal "/dev/null") (literal "/dev/zero"))`：
    // Seatbelt 里同一条 allow 的多个 filter 是 **AND** 关系，合写会一条都匹配不到。
    lines.push(`(allow file-write* (literal "/dev/null"))`);
    lines.push(`(allow file-write* (literal "/dev/zero"))`);
    lines.push(`(allow file-write* (literal "/dev/tty"))`);
    lines.push('(allow file-write* (regex #"^/dev/fd/"))');
    lines.push('(allow file-write* (regex #"^/dev/ttys"))');

    lines.push("");
    lines.push(";; 网络");
    if (this.config.network === "all") {
      lines.push("(allow network*)");
    } else if (this.config.network === "localhost") {
      // host 部分只能是 `*` 或 `localhost`，端口可以是 `*` 或具体数字。
      // 写 IP 字面量会让 sandbox-exec 直接 exit 65（见文件头注释）。
      lines.push('(allow network* (remote ip "localhost:*"))');
    } else {
      lines.push(";; network: none —— 不写任何 network 规则，(deny default) 下即全部拒绝");
    }

    return lines.join("\n");
  }

  /**
   * 本次 profile 实际放行的写路径（全部 realpath，去重）。
   *
   * 为什么必须 realpath：Seatbelt 按**真实路径**匹配。规则写 `/tmp/x`，
   * 在 `/tmp/x` 下写文件会被拒 —— macOS 上 `/tmp`→`/private/tmp`、`/var`→`/private/var`。
   * realpath 失败的路径跳过并 warn，而不是原样写进去假装生效。
   */
  private collectWritePaths(): string[] {
    const out: string[] = [];
    const push = (real: string | undefined) => {
      if (real && !out.includes(real)) out.push(real);
    };
    push(this.realpathForProfile(this.workspacePath, "工作区"));
    push(this.realpathForProfile("/private/tmp", "临时目录"));
    // $TMPDIR 在 /private/var/folders 下（如 /private/var/folders/xx/.../T/）。
    push(this.realpathForProfile("/private/var/folders", "用户临时目录"));
    for (const p of this.config.allowedWritePaths) {
      push(this.realpathForProfile(p, "allowedWritePaths"));
    }
    return out;
  }

  /** realpath 失败（通常是不存在）时 warn 并返回 undefined —— 不写进 profile 假装生效。 */
  private realpathForProfile(p: string, label: string): string | undefined {
    try {
      return realpathSync(p);
    } catch {
      getLogger().warn("SANDBOX", `路径不存在，profile 已跳过 ${label}: ${p}`);
      return undefined;
    }
  }

  /**
   * 启动探针：用**真实生成的 profile** 跑一条 `exit 0`，确认这台机器上真能用。
   *
   * 为什么必须有：`enableSandbox: true` 只代表用户想开。profile 写得能过语法
   * 不代表进程能起来（D2 就是语法合法、dyld 起不来）。一次 ~10ms，只在启动时跑。
   */
  probe(shell: string): SandboxProbeResult {
    if (!this.isEnabled()) {
      return { ok: false, error: `sandbox 未启用或平台不支持（${process.platform}）` };
    }
    try {
      const r = spawnSync(
        "sandbox-exec",
        ["-p", this.generateSeatbeltProfile(), shell, "-c", "exit 0"],
        {
          encoding: "utf8",
          timeout: 5000,
        },
      );
      if (r.status === 0) return { ok: true };
      const firstLine =
        (r.stderr || "")
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.length > 0) ?? `sandbox-exec 退出码 ${r.status}`;
      return { ok: false, error: firstLine };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  /**
   * 包装命令，添加沙箱限制
   * 非 macOS 或未启用时原样返回
   *
   * @param shell 内层 shell，**必须与外层一致**。写死 `/bin/sh` 会让按 zsh 抓的
   *   快照在 POSIX mode 下执行：`source` 读不到文件是致命错误（`|| true` 救不回来），
   *   用户命令一行都不执行（D3，2026-11-05 实测 exit 1/2 且无输出）。
   */
  wrapCommand(command: string, shell: string): string {
    if (!this.isEnabled()) return command;

    const profile = this.generateSeatbeltProfile();
    // 转义单引号
    const escapedProfile = profile.replace(/'/g, "'\\''");
    const escapedShell = shell.replace(/'/g, "'\\''");
    const escapedCommand = command.replace(/'/g, "'\\''");
    return `sandbox-exec -p '${escapedProfile}' '${escapedShell}' -c '${escapedCommand}'`;
  }
}
