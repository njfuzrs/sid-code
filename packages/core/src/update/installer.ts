/**
 * 自动更新 — spawn detached 安装子进程
 *
 * 子进程跑 install.sh（完整下载+校验+冒烟+原子切换链路），输出重定向到 last-update.log
 * 子进程收尾时写 state.json（success/failed + 原因）+ pendingNotice + 释放锁
 *
 * ⚠️ env 净化：显式设 SID_CODE_CHANNEL="stable"（覆盖任何继承值），删除 SID_CODE_VERSION
 * 注入 SID_CODE_AUTO_UPDATE=1（供日志排查，install.sh 不依赖）
 */

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import { getSidHome } from "../config/paths.ts";
import { INSTALL_URL } from "./config.ts";
import { getLogger } from "../debug/logger.ts";

const log = () => getLogger();

/**
 * 获取日志文件路径
 */
function getLogPath(): string {
  return join(getSidHome(), "updates", "last-update.log");
}

/**
 * 获取状态文件路径（子进程写回用）
 */
function getStatePath(): string {
  return join(getSidHome(), "updates", "state.json");
}

/**
 * spawn detached 安装子进程
 * @param targetVersion 目标版本号（latest.txt 内容）
 * @param currentVersion 当前版本号
 * @param lockDir 锁目录路径（子进程释放用）
 */
export function spawnBackgroundInstall(
  targetVersion: string,
  currentVersion: string,
  lockDir: string,
): void {
  const logPath = getLogPath();
  const statePath = getStatePath();

  // 子进程脚本：跑 install.sh，然后根据退出码写 state + pendingNotice + 释放锁
  const childScript = `
set -o pipefail
${INSTALL_URL_CMD} | bash > "${logPath}" 2>&1
code=$?

# 判定成败
if [ $code -eq 0 ]; then
  status=success
  reason=""
else
  status=failed
  reason="install-exit:$code"
fi

# 写 state.json（原子：tmp + rename）
tmp_state="${statePath}.tmp.$$"
cat > "$tmp_state" <<EOF
{
  "lastCheckAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "consecutiveFailures": $([ "$status" = "failed" ] && echo 1 || echo 0),
  "lastAttempt": {
    "at": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
    "fromVersion": "${currentVersion}",
    "toVersion": "${targetVersion}",
    "status": "$status",
    "reason": "$reason"
  },
  "pendingNotice": {
    "type": "$([ "$status" = "success" ] && echo updated || echo failed)",
    "fromVersion": "${currentVersion}",
    "toVersion": "${targetVersion}",
    "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  }
}
EOF
mv -f "$tmp_state" "${statePath}"

# 释放锁
rm -rf "${lockDir}"
`;

  // env 净化：显式设 SID_CODE_CHANNEL="stable"，删除 SID_CODE_VERSION
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.SID_CODE_CHANNEL = "stable"; // 显式覆盖，保证只更新 stable
  delete env.SID_CODE_VERSION; // 允许 install.sh 按 latest.txt 决定版本
  env.SID_CODE_AUTO_UPDATE = "1"; // 标记自动更新来源，供日志排查

  // stdio: redirect 到日志文件（保留 debuggability）
  let logFd: number;
  try {
    logFd = openSync(logPath, "w");
  } catch (err) {
    log().error("AUTO_UPDATE", `打开日志文件失败: ${err}`);
    return;
  }

  try {
    const child = spawn("bash", ["-c", childScript], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env,
    });

    log().info("AUTO_UPDATE", `spawn 子进程 pid=${child.pid}，目标版本 v${targetVersion}`);
    child.unref();
  } catch (err) {
    log().error("AUTO_UPDATE", `spawn 子进程失败: ${err}`);
    try {
      const { closeSync } = require("node:fs");
      closeSync(logFd);
    } catch {}
  }
}

// install.sh 的 URL 命令（curl）
const INSTALL_URL_CMD = `curl -fsSL --connect-timeout 10 --max-time 600 "${INSTALL_URL}"`;
