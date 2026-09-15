/**
 * 自动更新 — 配置与 URL 常量
 *
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

export const RELEASE_ORIGIN = (() => {
  const override = process.env.SID_CODE_RELEASE_HOST?.trim();
  if (!override) return DEFAULT_RELEASE_ORIGIN;
  return /^https?:\/\//.test(override) ? override.replace(/\/+$/, "") : `https://${override}`;
})();

export const INSTALL_URL =
  process.env.SID_CODE_INSTALL_URL || `${RELEASE_ORIGIN}/releases/sid-code/install.sh`;

/**
 * 自动更新模式
 */
export type AutoUpdateMode = "off" | "notify" | "auto";

/**
 * 解析自动更新模式（优先级：env > settings > 默认 "auto"）
 *
 * - env `SID_CODE_AUTO_UPDATE` 显式覆盖（CI、临时禁用、企业管控场景）
 * - settings.json 的 `autoUpdate` 字段（用户配置）
 * - 默认值 `"auto"`（自动下载安装）
 *
 * 非法 enum 值（如手抖写 `"always"`）：warn 后回退到默认值 `"auto"`，不抛错
 */
export function resolveAutoUpdateMode(settingsAutoUpdate?: string): AutoUpdateMode {
  // env 优先
  const envMode = process.env.SID_CODE_AUTO_UPDATE?.trim().toLowerCase();
  if (envMode) {
    if (envMode === "off" || envMode === "notify" || envMode === "auto") {
      return envMode;
    }
    // 非法 env 值，warn 后继续往下走（用 settings 或默认值）
    console.warn(
      `[auto-update] 非法 SID_CODE_AUTO_UPDATE="${envMode}"，期望 off|notify|auto，将回退到 settings 或默认值`,
    );
  }

  // settings 次之
  if (settingsAutoUpdate) {
    const mode = settingsAutoUpdate.toLowerCase();
    if (mode === "off" || mode === "notify" || mode === "auto") {
      return mode as AutoUpdateMode;
    }
    console.warn(
      `[auto-update] 非法 settings.autoUpdate="${settingsAutoUpdate}"，期望 off|notify|auto，将回退到默认值`,
    );
  }

  // 默认
  return "auto";
}
