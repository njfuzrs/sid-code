/**
 * sid-code update — 自更新子命令
 *
 * 用法：
 *   sid-code update       下载并安装最新版本（复用 install.sh 全部流程）
 *
 * 实现上直接复用 scripts/install-template.sh 生成的发布版 install.sh：
 * 该脚本全程非交互（团队默认配置采用"仅当 settings.json 不存在才写入"的
 * 纯拷贝语义，见 docs/install-guide.md），所以 `curl | bash` 消耗 stdin
 * 不是问题；不在这里用 TS 重新实现下载/校验/切换逻辑，避免和 install.sh
 * 出现两份要长期保持同步的实现。
 */

import * as childProcess from "node:child_process";
import { INSTALL_URL } from "@sid-code/core/update/config.ts";
import { isValidVersion } from "@sid-code/core/update/versions.ts";
function printHelp(): void {
  console.log(`sid-code update — 更新到最新版本

用法:
  sid-code update                       下载并安装最新版本
  sid-code update --version x.y.z       安装指定稳定版本
  sid-code update -h                    显示帮助

说明:
  缺省从稳定版通道更新。指定版本也可以使用：
    SID_CODE_VERSION=x.y.z sid-code update
  当前不支持 --list；服务器只提供稳定版和 beta 通道指针。

发布通道:
  缺省更新到稳定版（服务器 latest.txt）。想留在抢先版通道要显式带上：
    SID_CODE_CHANNEL=beta sid-code update
  通道不写进本地配置，所以不带这个变量就会回到稳定版。
  已有的 ~/.sid-code/ 配置与会话数据不受影响，只替换二进制本身。`);
}

function parseVersion(args: string[]): string | undefined {
  let version: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--version") {
      if (version !== undefined || !args[index + 1]) {
        throw new Error("--version 需要传入一个 x.y.z 版本号");
      }
      version = args[++index];
      if (!isValidVersion(version)) {
        throw new Error(`版本号非法: ${version}，期望 x.y.z`);
      }
      continue;
    }
    if (arg === "--list") {
      throw new Error("当前不支持 --list；服务器没有版本清单接口");
    }
    throw new Error(`未知参数: ${arg}`);
  }
  return version;
}

export async function handleUpdateCommand(
  args: string[],
  execute: typeof childProcess.execFileSync = childProcess.execFileSync,
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const version = parseVersion(args);
  const channel = process.env.SID_CODE_CHANNEL?.trim();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (version) env.SID_CODE_VERSION = version;
  else delete env.SID_CODE_VERSION;

  console.log(
    `正在更新 sid-code（${INSTALL_URL}${channel ? `，通道: ${channel}` : ""}${version ? `，版本: ${version}` : ""}）...`,
  );
  try {
    execute("bash", ["-c", 'curl -fsSL "$1" | bash', "sid-code-update", INSTALL_URL], {
      stdio: "inherit",
      env,
    });
  } catch (err: any) {
    throw new Error(`更新失败: ${err?.message ?? err}`);
  }
}
