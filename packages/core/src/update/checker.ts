/**
 * 自动更新 — 拉取并解析通道指针（stable → latest.txt / beta → beta.txt）
 *
 * 5s 超时，失败返回 null（静默，不抛错）
 */

import { RELEASE_ORIGIN } from "./config.ts";
import { isValidVersion } from "./versions.ts";
import { getLogger } from "../debug/logger.ts";

const log = () => getLogger();

export type UpdateChannel = "stable" | "beta";

/** 通道 → 指针文件名（与 scripts/install-template.sh 的 CHANNEL_POINTER 保持一致） */
export function channelPointerFile(channel: UpdateChannel): string {
  return channel === "beta" ? "beta.txt" : "latest.txt";
}

/**
 * 拉取通道指针并解析版本号
 * @param channel 缺省 stable（latest.txt）；beta 用户读 beta.txt（T4，一修一号流程）
 * @returns 版本号字符串（如 "0.1.603"）如果成功，null 如果失败
 */
export async function fetchLatestVersion(
  channel: UpdateChannel = "stable",
): Promise<string | null> {
  const pointer = channelPointerFile(channel);
  const url = `${RELEASE_ORIGIN}/releases/sid-code/${pointer}`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      log().warn(
        "AUTO_UPDATE",
        `拉取 ${pointer} 失败: HTTP ${response.status} ${response.statusText}`,
      );
      return null;
    }

    const text = await response.text();
    const version = text.trim();

    if (!isValidVersion(version)) {
      log().warn("AUTO_UPDATE", `${pointer} 内容格式非法: "${version}"，期望 x.y.z`);
      return null;
    }

    return version;
  } catch (err) {
    log().warn("AUTO_UPDATE", `拉取 ${pointer} 异常: ${err}`);
    return null;
  }
}
