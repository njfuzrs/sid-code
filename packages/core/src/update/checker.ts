/**
 * 自动更新 — 拉取并解析 latest.txt
 *
 * 5s 超时，失败返回 null（静默，不抛错）
 */

import { RELEASE_ORIGIN } from "./config.ts";
import { isValidVersion } from "./versions.ts";
import { getLogger } from "../debug/logger.ts";

const log = () => getLogger();

const LATEST_TXT_URL = `${RELEASE_ORIGIN}/releases/sid-code/latest.txt`;

/**
 * 拉取 latest.txt 并解析版本号
 * @returns 版本号字符串（如 "0.1.603"）如果成功，null 如果失败
 */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(LATEST_TXT_URL, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      log().warn(
        "AUTO_UPDATE",
        `拉取 latest.txt 失败: HTTP ${response.status} ${response.statusText}`,
      );
      return null;
    }

    const text = await response.text();
    const version = text.trim();

    if (!isValidVersion(version)) {
      log().warn("AUTO_UPDATE", `latest.txt 内容格式非法: "${version}"，期望 x.y.z`);
      return null;
    }

    return version;
  } catch (err) {
    log().warn("AUTO_UPDATE", `拉取 latest.txt 异常: ${err}`);
    return null;
  }
}
