/**
 * 自动更新 — 版本号比较与校验
 *
 * 版本号格式：`x.y.z`（纯数字三段，如 `0.1.603`）
 * - 不含前缀 `v`
 * - 不含 prerelease 标记（如 `-beta.1`）—— 自动更新不处理 prerelease 版本
 *
 * 关键函数：
 * - `isValidVersion(s)`：严格匹配 `^\d+\.\d+\.\d+$`
 * - `compareVersions(a, b)`：返回 -1 / 0 / 1（a < b / a == b / a > b）
 * - `isPrereleaseVersion(s)`：检测是否含 `-`（如 `0.2.0-beta.1`）
 *
 * ⚠️ 自动更新必须用 `getRawVersion()`（裸 x.y.z），不是 `getVersion()`（带前后缀）
 */

const VERSION_REGEX = /^\d+\.\d+\.\d+$/;

/**
 * 校验版本号格式是否合法（严格 x.y.z 三段数字）
 */
export function isValidVersion(version: string): boolean {
  return VERSION_REGEX.test(version);
}

/**
 * 检测版本号是否为 prerelease / dev 构建（含 `-` 标记，如 `0.2.0-beta.1`）
 */
export function isPrereleaseVersion(version: string): boolean {
  return version.includes("-");
}

/**
 * 比较两个版本号
 * @returns -1 如果 a < b，0 如果 a == b，1 如果 a > b
 * @throws 如果任一版本号格式非法
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  if (!isValidVersion(a)) throw new Error(`Invalid version format: ${a}`);
  if (!isValidVersion(b)) throw new Error(`Invalid version format: ${b}`);

  const [aMajor, aMinor, aPatch] = a.split(".").map(Number);
  const [bMajor, bMinor, bPatch] = b.split(".").map(Number);

  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
}
