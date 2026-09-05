/**
 * WSL 跨边界寻址与路径换算（D8）
 *
 * **这个文件的存在是为了消灭一个「死字段」。** 在此之前 `runningInWindows`
 * 贯穿四层（lockfile 类型 → detect 读出 → integration 传进 MCP 配置 → config 存下），
 * 看起来一路被使用，但**链条末端没有任何消费方** —— 全仓对 WSL 的处理只在一个
 * 无关的地方（`tool/ripgrep.ts` 的超时调整）。
 *
 * 留着这样一个从不生效的字段**比没有它更糟**：它让读代码的人以为 WSL 已经支持了。
 *
 * WSL2 下为什么非改不可：agent 跑在 Linux 子系统里、IDE 跑在 Windows 宿主上时，
 * 两侧的 `127.0.0.1` **不是同一个网络栈**，照着 lockfile 里的端口连本地回环
 * 永远连不上 Windows 侧的扩展。路径格式同理（`/mnt/c/...` vs `C:\...`）。
 *
 * ⚠️ **可验证性边界，必须说清楚**：本模块的地址推导与路径换算都有单测覆盖
 * （注入 `/proc/version`、`/etc/resolv.conf` 内容与各种路径形态），
 * 但**"在真实 WSL 里确实连上了 Windows 侧扩展"这件事没有被验证过** ——
 * 开发机是 macOS。所以这条修复的诚实说法是「死字段已被消费、推导逻辑有单测」，
 * 不是「WSL 已支持」。真实 WSL 环境跑通之前，别把它写成后者。
 */

import { readFileSync } from "fs";

/** 环境变量逃逸阀：推导不对时用户可直接钉死宿主地址 */
const HOST_IP_ENV = "SID_CODE_WSL_HOST_IP";

/** `C:\path` / `c:/path` 形态的 Windows 绝对路径 */
const WINDOWS_ABS_PATH = /^([A-Za-z]):[\\/]/;
/** `/mnt/c/path` 形态的 WSL 挂载路径 */
const WSL_MOUNT_PATH = /^\/mnt\/([a-z])(\/|$)/;

let wslCache: boolean | null = null;
let hostIPCache: string | null | undefined;

/**
 * 是否运行在 WSL 里。
 *
 * 判据用**两个**信号取或：`WSL_DISTRO_NAME` 环境变量（WSL2 一定有，且最便宜），
 * 以及 `/proc/version` 里的 `microsoft` 字样（WSL1 与部分定制发行版靠它）。
 * 只用其中任一个都有已知漏检：env 会被 sudo / 某些 shell 清掉，
 * 而 `/proc/version` 在非 Linux 上根本不存在。
 *
 * 结果缓存：这是进程生命周期内的不变量，而它会在每次建 URL 时被问到。
 */
export function isRunningInWSL(): boolean {
  if (wslCache !== null) return wslCache;

  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    wslCache = true;
    return true;
  }

  if (process.platform !== "linux") {
    wslCache = false;
    return false;
  }

  try {
    wslCache = /microsoft/i.test(readFileSync("/proc/version", "utf-8"));
  } catch {
    wslCache = false;
  }
  return wslCache;
}

/**
 * 解析 Windows 宿主在 WSL 网络里的地址。
 *
 * WSL2 的 `/etc/resolv.conf` 里那个 `nameserver` 就是宿主在 NAT 网段里的地址
 * （WSL 自己生成的），这是社区公认的取法。取不到就返回 null 让调用方降级。
 *
 * 顺序：环境变量覆盖 > resolv.conf 推导。给逃逸阀是因为镜像网络模式
 * （`networkingMode=mirrored`）下 resolv.conf 里是 `127.0.0.1`，
 * 那种模式下本来就该直连回环 —— 见下面对 127.* 的处理。
 */
export function resolveWindowsHostIP(): string | null {
  if (hostIPCache !== undefined) return hostIPCache;

  const override = process.env[HOST_IP_ENV]?.trim();
  if (override) {
    hostIPCache = override;
    return hostIPCache;
  }

  try {
    const conf = readFileSync("/etc/resolv.conf", "utf-8");
    for (const line of conf.split("\n")) {
      const m = line.match(/^\s*nameserver\s+(\S+)/);
      if (!m) continue;
      const ip = m[1]!;
      // 镜像网络模式下这里就是回环 —— 那正是"直连 127.0.0.1 即可"的情形，
      // 当成"没推导出宿主地址"返回 null，让调用方走原路径（而不是绕一圈得到同一个值）。
      if (ip.startsWith("127.")) continue;
      hostIPCache = ip;
      return hostIPCache;
    }
  } catch {
    /* 非 WSL 或读不到：落到下面的 null */
  }

  hostIPCache = null;
  return null;
}

/**
 * 决定连 IDE 时该用哪个 host。
 *
 * 只在**两个条件同时成立**时才偏离 `127.0.0.1`：我们在 WSL 里，
 * 且 lockfile 明说 IDE 跑在 Windows 上。任一不成立就保持原行为字节不变 ——
 * 这条边界上的错误代价是"连不上"，不该由一个猜测引入。
 */
export function resolveIDEHost(ideRunningInWindows?: boolean): string {
  if (!ideRunningInWindows) return "127.0.0.1";
  if (!isRunningInWSL()) return "127.0.0.1";
  return resolveWindowsHostIP() ?? "127.0.0.1";
}

/**
 * Windows 路径 → WSL 路径（`C:\a\b` → `/mnt/c/a/b`）。
 *
 * **非 WSL 环境下是严格的 no-op**，且只认 `<盘符>:` 开头的形态 ——
 * 一个以 `C:\` 开头的字符串在 Linux 上本来就不是合法路径，所以这个判据不会误伤。
 * 这样接进 selection / mention 的入向路径时，非 WSL 用户的行为逐字节不变。
 */
export function windowsPathToWSL(filePath: string): string {
  if (!isRunningInWSL()) return filePath;
  const m = filePath.match(WINDOWS_ABS_PATH);
  if (!m) return filePath;
  const drive = m[1]!.toLowerCase();
  return `/mnt/${drive}/${filePath.slice(3).replace(/\\/g, "/")}`.replace(/\/{2,}/g, "/");
}

/**
 * WSL 路径 → Windows 路径（`/mnt/c/a/b` → `C:\a\b`）。
 *
 * 同样在非 WSL 下是 no-op。用于出向：我们把路径交给跑在 Windows 上的扩展时
 * （如 openDiff 的 `old_file_path`），得说它认得的方言。
 */
export function wslPathToWindows(filePath: string): string {
  if (!isRunningInWSL()) return filePath;
  const m = filePath.match(WSL_MOUNT_PATH);
  if (!m) return filePath;
  const drive = m[1]!.toUpperCase();
  const rest = filePath.slice(`/mnt/${m[1]!}`.length);
  return `${drive}:${rest.replace(/\//g, "\\") || "\\"}`;
}

/** 复位缓存（测试用；生产中这些是进程级不变量） */
export function _resetWSLCacheForTesting(): void {
  wslCache = null;
  hostIPCache = undefined;
}
