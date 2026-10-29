/**
 * 系统服务封装（缺口 C1-5）
 *
 * 把 `sid-code daemon` 注册为开机自启的系统服务，由 OS 负责拉起/重启：
 *   - macOS:  launchd user agent（~/Library/LaunchAgents/<label>.plist）
 *   - Linux:  systemd user unit（~/.config/systemd/user/<name>.service）
 *
 * 设计：仅生成/安装服务描述文件并调用 OS 的 load/enable 命令；
 * 守护进程本体仍是 `sid-code daemon start`（前台运行，由 OS 接管其生命周期）。
 *
 * 安全：服务以当前用户身份运行（非 root），不写系统级 /Library 或 /etc。
 */

import { writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolveExecutable } from "../bootstrap/resolve-executable.ts";
import { sidPaths } from "../config/paths.ts";
import {
  resolveWebhookSecret,
  writeWebhookSecretFile,
  webhookSecretFile,
} from "./webhook-secret.ts";

/**
 * launchd 服务标签（同时是 plist 文件名）。
 *
 * 反向 DNS 取项目自己的公开域名 `sid-code.cc`。此前用的是内部域名派生的
 * `cc.ruishan.sid-code.daemon`，那会把内部域名写进每台机器的
 * `~/Library/LaunchAgents/` 文件名里，也写进公开仓库。
 */
const SERVICE_LABEL = "cc.sid-code.daemon";

/**
 * 改名前用过的标签。**只用于卸载**，绝不用于安装。
 *
 * 必须保留：`uninstallLaunchd` 认的是 `plistPath()`，改名后它只会去找新文件，
 * 旧 plist 会永久留在 `~/Library/LaunchAgents/` 里继续被 launchd 拉起 ——
 * 用户执行 `daemon uninstall` 看到"已卸载"，实际还有一个守护进程在跑，
 * 而且再也没有任何代码路径能删掉它。
 */
const LEGACY_SERVICE_LABELS = ["cc.ruishan.sid-code.daemon"] as const;

function legacyPlistPaths(): string[] {
  return LEGACY_SERVICE_LABELS.map((label) =>
    join(homedir(), "Library", "LaunchAgents", `${label}.plist`),
  );
}

/**
 * 卸载/顶掉改名前安装的旧服务。安装与卸载路径都要调：
 * 安装时不清旧的，会出现新旧两个 agent 同时开机自启（两个守护进程抢同一份状态）。
 */
function removeLegacyLaunchd(): void {
  for (const path of legacyPlistPaths()) {
    if (!existsSync(path)) continue;
    try {
      execFileSync("launchctl", ["unload", path], { stdio: "ignore" });
    } catch {
      /* 没加载过，忽略 */
    }
    try {
      unlinkSync(path);
      console.log(`已移除旧标签的 launchd 服务: ${path}`);
    } catch {
      /* 删不掉（权限/竞态）不阻塞主流程 */
    }
  }
}

interface ServiceInstallOptions {
  webhook?: boolean;
  interval?: number;
  maxConcurrent?: number;
  allowedTools?: string[];
}

/** 定位 bun 可执行路径（用于服务启动命令） */
function bunPath(): string {
  return process.execPath; // 当前 bun 解释器
}

/** 拼 daemon start 的参数（注入到服务命令） */
function daemonArgs(opts: ServiceInstallOptions): string[] {
  const { baseArgs } = resolveExecutable();
  // 编译二进制：baseArgs 为空；开发模式：baseArgs=["run", "<bootstrap.ts>"]
  // plist/systemd 的 ProgramArguments 第一项由 bunPath()（=process.execPath）提供
  const args = [...baseArgs, "daemon", "start"];
  if (opts.webhook) args.push("--webhook");
  if (opts.interval) args.push("--interval", String(opts.interval));
  if (opts.maxConcurrent) args.push("--max-concurrent", String(opts.maxConcurrent));
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowed-tools", opts.allowedTools.join(","));
  }
  return args;
}

// ── macOS launchd ──

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

/**
 * 守护进程日志目录。走 `sidPaths.logs()`（尊重 SID_CONFIG_DIR），不自行拼 homedir()。
 *
 * ⚠ 值会被**写死进 plist / systemd unit 文件**：安装时解析一次，此后由 OS 拉起
 * 守护进程时不再重算。所以在非默认 `SID_CONFIG_DIR` 下装的服务，日志固定落在
 * 安装当时那个目录 —— 这是"安装快照"语义，与 `sid-code daemon` 的其他参数
 * （interval / max-concurrent，见 daemonArgs）一致，不是缺陷。
 */
function logDir(): string {
  return sidPaths.logs();
}

/**
 * 要写进服务文件的环境变量。
 *
 * `SID_CONFIG_DIR`：日志目录在安装时被写死（见 logDir），但服务进程里 getSidHome() 会回落到
 * ~/.sid-code——非默认配置目录下装的服务，日志在 A、锁/任务注册表/webhook secret 文件在 B。
 * 所以安装时设了就原样带进去，让服务进程和安装时看到同一个配置根。
 *
 * **不带 SID_CODE_WEBHOOK_SECRET**：服务文件通常 644，secret 走 0600 文件（webhook-secret.ts）。
 */
export function serviceEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.SID_CONFIG_DIR) out.SID_CONFIG_DIR = env.SID_CONFIG_DIR;
  return out;
}

export function buildPlist(opts: ServiceInstallOptions): string {
  const args = [bunPath(), ...daemonArgs(opts)];
  const argXml = args.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  const outLog = join(logDir(), "daemon.launchd.out.log");
  const errLog = join(logDir(), "daemon.launchd.err.log");
  const envEntries = Object.entries(serviceEnv());
  const envXml =
    envEntries.length === 0
      ? ""
      : `  <key>EnvironmentVariables</key>
  <dict>
${envEntries.map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`).join("\n")}
  </dict>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(homedir())}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errLog)}</string>
${envXml}</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function installLaunchd(opts: ServiceInstallOptions): void {
  // 先清掉改名前的旧 agent，否则新旧两个都会开机自启（两个守护进程抢同一份状态）。
  removeLegacyLaunchd();
  mkdirSync(dirname(plistPath()), { recursive: true });
  mkdirSync(logDir(), { recursive: true });
  writeFileSync(plistPath(), buildPlist(opts));
  console.log(`已写入 launchd plist: ${plistPath()}`);

  // 先卸载旧的（幂等），再加载
  try {
    execFileSync("launchctl", ["unload", plistPath()], { stdio: "ignore" });
  } catch {
    /* 旧服务不存在，忽略 */
  }
  try {
    execFileSync("launchctl", ["load", plistPath()], { stdio: "inherit" });
    console.log("✅ launchd 服务已加载并启动（开机自启）");
    console.log(`   查看状态: launchctl list | grep ${SERVICE_LABEL}`);
  } catch (err: any) {
    console.error(`launchctl load 失败: ${err?.message ?? err}`);
    process.exit(1);
  }
}

function uninstallLaunchd(): void {
  // 旧标签的 plist 必须一并清掉，否则"已卸载"是假的：旧 agent 还在被 launchd 拉起。
  // 放在 existsSync 判断**之前** —— 只装过旧版的用户，新 plist 根本不存在。
  removeLegacyLaunchd();
  if (!existsSync(plistPath())) {
    console.log("launchd 服务未安装");
    return;
  }
  try {
    execFileSync("launchctl", ["unload", plistPath()], { stdio: "ignore" });
  } catch {
    /* 忽略 */
  }
  try {
    unlinkSync(plistPath());
  } catch {
    /* 忽略 */
  }
  console.log("✅ launchd 服务已卸载");
}

// ── Linux systemd user unit ──

function systemdUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", "sid-code-daemon.service");
}

export function buildSystemdUnit(opts: ServiceInstallOptions): string {
  const args = [bunPath(), ...daemonArgs(opts)];
  // systemd ExecStart 需绝对路径命令；参数用空格拼（路径无空格场景）
  const execStart = args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
  const extraEnv = Object.entries(serviceEnv())
    .map(([k, v]) => `\nEnvironment="${k}=${v.replace(/(["\\])/g, "\\$1")}"`)
    .join("");
  return `[Unit]
Description=sid-code 本地调度守护进程
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=5
WorkingDirectory=${homedir()}
Environment=NO_COLOR=1${extraEnv}

[Install]
WantedBy=default.target
`;
}

function installSystemd(opts: ServiceInstallOptions): void {
  mkdirSync(dirname(systemdUnitPath()), { recursive: true });
  writeFileSync(systemdUnitPath(), buildSystemdUnit(opts));
  console.log(`已写入 systemd user unit: ${systemdUnitPath()}`);

  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", "sid-code-daemon.service"], {
      stdio: "inherit",
    });
    console.log("✅ systemd 服务已启用并启动（开机自启）");
    console.log("   查看状态: systemctl --user status sid-code-daemon");
    console.log("   提示: 如需登出后仍运行，执行 loginctl enable-linger $USER");
  } catch (err: any) {
    console.error(`systemctl 启用失败: ${err?.message ?? err}`);
    process.exit(1);
  }
}

function uninstallSystemd(): void {
  if (!existsSync(systemdUnitPath())) {
    console.log("systemd 服务未安装");
    return;
  }
  try {
    execFileSync("systemctl", ["--user", "disable", "--now", "sid-code-daemon.service"], {
      stdio: "ignore",
    });
  } catch {
    /* 忽略 */
  }
  try {
    unlinkSync(systemdUnitPath());
  } catch {
    /* 忽略 */
  }
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  } catch {
    /* 忽略 */
  }
  console.log("✅ systemd 服务已卸载");
}

// ── webhook secret ──

/**
 * install 前准备 webhook secret。返回 false = 拒绝安装（已打印原因）。
 *
 * 服务进程拿不到 shell 里 export 的 secret，所以：
 * - 当前环境有 secret → 写进 0600 文件，服务进程从文件读
 * - 没有但文件里已有（之前装过）→ 沿用
 * - 带了 --webhook 却两者都没有 → 拒绝安装。此前会装出一个「已加载并启动」但 3847 不监听的服务，
 *   只在 daemon 日志里留一条 warn，用户要到 GitHub 投递全部 connection refused 才发现。
 */
export function prepareWebhookSecretForInstall(opts: ServiceInstallOptions): boolean {
  const fromEnv = process.env.SID_CODE_WEBHOOK_SECRET ?? "";
  if (fromEnv !== "") {
    const path = writeWebhookSecretFile(fromEnv);
    console.log(`已写入 webhook secret（0600）: ${path}`);
    return true;
  }
  if (!opts.webhook) return true;
  if (resolveWebhookSecret() !== "") {
    console.log(`沿用已有的 webhook secret 文件: ${webhookSecretFile()}`);
    return true;
  }
  console.error(
    "错误: 指定了 --webhook 但当前环境没有 SID_CODE_WEBHOOK_SECRET，也没有已保存的 secret 文件。\n" +
      "系统服务不继承 shell 环境变量，这样装出来的服务 webhook 不会启动。\n" +
      "请先 export SID_CODE_WEBHOOK_SECRET=<secret> 再执行 sid-code daemon install --webhook",
  );
  return false;
}

// ── 入口 ──

export async function handleServiceCommand(
  action: "install" | "uninstall",
  opts: ServiceInstallOptions,
): Promise<void> {
  const platform = process.platform;

  if (action === "install" && (platform === "darwin" || platform === "linux")) {
    if (!prepareWebhookSecretForInstall(opts)) process.exit(1);
  }

  if (platform === "darwin") {
    if (action === "install") installLaunchd(opts);
    else uninstallLaunchd();
  } else if (platform === "linux") {
    if (action === "install") installSystemd(opts);
    else uninstallSystemd();
  } else {
    console.error(`不支持的平台: ${platform}（仅支持 macOS launchd / Linux systemd）`);
    console.error("可手动运行: sid-code daemon start");
    process.exit(1);
  }
}
