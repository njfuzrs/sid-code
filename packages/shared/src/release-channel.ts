/**
 * 发布通道标识（stable / beta / dev）—— 让用户在 `--version`、TUI 首屏与状态栏上看得出自己跑的是哪种构建
 *
 * ## 三种通道怎么判
 *
 * | 通道 | 判据 | 展示 |
 * | --- | --- | --- |
 * | dev | 构建身份 `origin ≠ release`（`make build` 的 sc-dev、`bun run` 源码运行、CI 产物） | `dev 本地开发版` |
 * | beta | `origin = release` 且二进制旁 `.channel` 标记为 beta | `beta 预发布版` |
 * | stable | 其余（`origin = release` 且无 beta 标记） | 不显示任何标签 |
 *
 * dev 先判：本地构建与发布产物的区别**编在字节里**（`build-info.ts` 的 origin），不依赖安装方式；
 * 拿 sc-dev 去复现线上问题时，最怕的就是看不出自己跑的不是线上那份。
 *
 * ## 为什么 beta 是「二进制旁的标记文件」而不是编进字节
 *
 * beta 与 stable 共用同一批版本目录、同一份字节（promote 是纯指针操作，见 install-template.sh
 * 「通道 → 指针文件」一节）。给 beta 单独构建就会让 promote 时用户拿到的字节与 beta 期被测的
 * 不再是同一份，通道机制的唯一价值当场失效。所以 beta 只能在**安装时**落盘：install.sh 每次安装
 * 都在 `versions/<ver>/.channel` 覆盖写一次（同一版本先以 beta 装、promote 后以 stable 再装时
 * 目录被复用，标记必须跟着变回 stable）。
 *
 * 发布产物读不到标记（老版本 install.sh 装的、手动解压的）按 stable 处理：
 * 没有证据就不打 beta 标，误标 beta 比漏标更误导。
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBuildInfo, type BuildOrigin } from "./build-info.ts";

export type ReleaseChannel = "stable" | "beta" | "dev";

/** install.sh 写入的标记文件名（与 scripts/install-template.sh 保持一致） */
export const CHANNEL_MARKER_FILE = ".channel";

/** 从二进制所在目录读 beta 标记（只区分 beta / stable，dev 由构建身份判）。 */
export function readChannelMarker(binDir: string): "stable" | "beta" {
  try {
    const raw = readFileSync(join(binDir, CHANNEL_MARKER_FILE), "utf8").trim();
    return raw === "beta" ? "beta" : "stable";
  } catch {
    return "stable";
  }
}

/** 纯函数判定：先看构建来源，再看安装标记。供单测直接喂参数。 */
export function resolveReleaseChannel(origin: BuildOrigin, binDir: string): ReleaseChannel {
  if (origin !== "release") return "dev";
  return readChannelMarker(binDir);
}

let cached: ReleaseChannel | undefined;

/** 当前进程的发布通道（进程内缓存）。 */
export function getReleaseChannel(execPath: string = process.execPath): ReleaseChannel {
  if (cached) return cached;
  let real = execPath;
  try {
    // ~/.local/bin/sid-code 是指向 versions/<ver>/sid-code 的软链，标记在后者旁边
    real = realpathSync(execPath);
  } catch {
    /* 解析失败就按原路径找，找不到即 stable */
  }
  cached = resolveReleaseChannel(getBuildInfo().origin, dirname(real));
  return cached;
}

/** 给人看的通道标签；stable 返回 undefined（正式版不显示任何标签）。 */
export function getChannelLabel(channel: ReleaseChannel = getReleaseChannel()): string | undefined {
  if (channel === "beta") return "beta 预发布版";
  if (channel === "dev") return "dev 本地开发版";
  return undefined;
}

/** 仅供测试：清掉进程内缓存 */
export function _resetReleaseChannelCache(): void {
  cached = undefined;
}
