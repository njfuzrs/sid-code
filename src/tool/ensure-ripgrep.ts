/**
 * 嵌入 ripgrep 二进制的运行时释放
 *
 * 把编译期嵌入的 rg 二进制（见 rg-embedded.ts）释放到 ~/.sid-code/bin/rg，
 * 并 chmod 0o755 使其可执行。之后 ripgrep.ts 的 resolveRgCommand() 优先用它，
 * 使 sid-code 的搜索能力不再依赖用户系统 PATH 里是否装了 rg。
 *
 * 对标 claude-code「bundled ripgrep 释放到磁盘」的 builtin 模式，
 * 释放范式参照 src/skill/ensure-builtin.ts（哈希幂等 + 失败降级）。
 *
 * 关键设计：
 * - **dev 模式回退系统 rg**：IS_DEV_MODE 为 true（bun run src）时
 *   直接返回 null，不释放、不 import rg-embedded.ts，由调用方回退系统 rg。
 * - **并发单例**：模块级 releasePromise 保证多个 grep/glob 同时首次触发时只释放一次。
 * - **哈希幂等**：.hash 标记记录已释放二进制的内容哈希，一致则跳过；升级二进制后
 *   哈希变化则重新释放。
 * - **原子写**：写到 .tmp 再 rename，避免半截文件被 spawn 执行。
 * - **失败降级**：任何异常（磁盘满 / 只读 HOME / 嵌入为空）都返回 null，
 *   由调用方回退系统 rg，绝不阻断搜索。
 */

import { mkdir, writeFile, readFile, chmod, stat, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";
import { IS_DEV_MODE } from "../bootstrap/resolve-executable.ts";

/** 并发单例：首次触发释放后复用同一个 Promise，避免多路径竞写 */
let releasePromise: Promise<string | null> | null = null;

/**
 * 确保嵌入的 rg 已释放到磁盘，返回可执行 rg 的绝对路径。
 * - 编译产物且嵌入非空：释放到 ~/.sid-code/bin/rg 并返回该路径
 * - dev 模式 / 无嵌入 / 释放失败：返回 null（调用方回退系统 rg）
 */
export function ensureRipgrepReleased(): Promise<string | null> {
  return (releasePromise ??= doRelease());
}

/** 仅供测试：重置并发单例缓存，使下次调用重新走释放逻辑 */
export function __resetRipgrepReleaseCacheForTest(): void {
  releasePromise = null;
}

async function doRelease(): Promise<string | null> {
  const log = getLogger();

  // dev 模式（非编译产物）没有嵌入的 rg → 回退系统 rg
  if (IS_DEV_MODE) {
    return null;
  }

  try {
    // 动态 import：避免 dev 模式静态解析 vendor/rg-embed。守卫已在上方拦住 dev。
    const { rgEmbeddedPath } = await import("./rg-embedded.ts");
    const bytes = await Bun.file(rgEmbeddedPath).bytes();

    // 嵌入为空（仓库占位文件 / 构建时未跑 fetch）→ 回退系统 rg
    if (bytes.byteLength === 0) {
      return null;
    }

    const dest = sidPaths.rgBinary();
    const markerPath = `${dest}.hash`;
    const hash = Bun.hash(bytes).toString(16);

    // 幂等：哈希一致且文件仍在则跳过释放
    let existingHash: string | null = null;
    try {
      existingHash = (await readFile(markerPath, "utf-8")).trim();
    } catch {
      existingHash = null;
    }
    if (existingHash === hash) {
      try {
        await stat(dest);
        return dest;
      } catch {
        // 标记在但文件被删了 → 落到下面重新释放
      }
    }

    // 原子写：.tmp → chmod → rename，避免半截文件被 spawn
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp`;
    await writeFile(tmp, bytes);
    await chmod(tmp, 0o755);
    await rename(tmp, dest);
    await writeFile(markerPath, hash, "utf-8");

    log.info("RIPGREP", `已释放嵌入 rg → ${dest}（hash=${hash}，${bytes.byteLength} 字节）`);
    return dest;
  } catch (err) {
    log.warn(
      "RIPGREP",
      `释放嵌入 rg 失败（降级系统 rg，不影响搜索）: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
