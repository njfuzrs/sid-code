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

import { execFileSync } from "node:child_process";

/**
 * 发布服务器地址的唯一权威（客户端编译进二进制，用户机器无 deploy.env，故需内置默认值）。
 * 换服务器时改这一处即可；也可用环境变量覆盖：
 *   - SID_CODE_RELEASE_HOST  仅覆盖 host（推荐，路径结构不变）
 *   - SID_CODE_INSTALL_URL   覆盖完整 install.sh URL（需要非标准路径时用）
 *
 * ⚠️ 必须走 https + 域名，不能退回 IP 直连：服务器已签 sid-code.cc 证书并对 80 端口做
 * 301 → https，用 IP 请求会被重定向到 `https://<ip>/`，而证书 CN 不含 IP → TLS 校验失败
 * （curl exit 60），更新链路直接断。SID_CODE_RELEASE_HOST 传裸 host 时默认补 https；
 * 需要 http（如内网自建镜像）就带上完整 scheme，例如 `http://10.0.0.2`。
 */
const DEFAULT_RELEASE_ORIGIN = "https://www.sid-code.cc";
const RELEASE_ORIGIN = (() => {
  const override = process.env.SID_CODE_RELEASE_HOST?.trim();
  if (!override) return DEFAULT_RELEASE_ORIGIN;
  return /^https?:\/\//.test(override) ? override.replace(/\/+$/, "") : `https://${override}`;
})();
const INSTALL_URL =
  process.env.SID_CODE_INSTALL_URL || `${RELEASE_ORIGIN}/releases/sid-code/install.sh`;

function printHelp(): void {
  console.log(`sid-code update — 更新到最新版本

用法:
  sid-code update       下载并安装最新版本
  sid-code update -h    显示帮助

说明:
  等价于重新执行安装命令：
    curl -fsSL ${INSTALL_URL} | bash
  已有的 ~/.sid-code/ 配置与会话数据不受影响，只替换二进制本身。
  更新后首次启动时，会把新增的团队默认配置字段（如 subAgentModels/search/trace 等）
  自动补进 settings.json —— 仅追加你尚未拥有的顶层字段，绝不覆盖你已有的任何配置。
  同时会自动从网关（/api/pricing）刷新一次各端点的模型定价，无需手动执行
  /model discover --pricing（该命令仍保留，供你随时手动强制刷新）。`);
}

export async function handleUpdateCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  console.log(`正在更新 sid-code（${INSTALL_URL}）...`);
  try {
    execFileSync("bash", ["-c", `curl -fsSL ${INSTALL_URL} | bash`], { stdio: "inherit" });
  } catch (err: any) {
    console.error(`更新失败: ${err?.message ?? err}`);
    process.exit(1);
  }
}
