/**
 * Bridge 是否被企业策略关掉。进程内单例，对标 plugin-only-policy.ts。
 *
 * 为什么不读 config.bridge.enabled：
 * loadConfig 读 managed-settings 只取 identity，远程 JSON 的 bridge 键到不了 Config。
 * admission 若继续读 config.bridge?.enabled，管理台写下的 bridgeEnabled:false 是空转。
 *
 * 解析顺序：remote bridgeEnabled > 本机 settings 的 bridge.enabled > undefined。
 * undefined = 未配置 = 不关。远程 false 必须赢过本机 true。
 */

/** 远程策略。undefined = 这次没有远程结论（204 / 没配 endpoint / 非 remote 来源）。 */
let remoteBridgeEnabled: boolean | undefined;
/** 本机 settings.json 的 bridge.enabled。只作默认，盖不过远程 false。 */
let localBridgeEnabled: boolean | undefined;

/**
 * applyLoadedPolicy 调用。
 * - remote 来源：字段省略 → undefined（不关），显式 boolean 照记。
 * - 非 remote / null：清掉远程结论，避免同进程上一次的 false 活到下次。
 */
export function setBridgePolicy(enabled: boolean | undefined, fromRemote: boolean): void {
  if (!fromRemote) {
    remoteBridgeEnabled = undefined;
    return;
  }
  remoteBridgeEnabled = enabled;
}

/** cli 读到用户 settings.json 的 bridge.enabled 后注入。 */
export function setLocalBridgeEnabled(enabled: boolean | undefined): void {
  localBridgeEnabled = enabled;
}

/**
 * admission 用的最终开关。
 * 返回 false = 关；undefined = 不关。没有「远程 true 被本机 false 盖掉」这条——
 * 本机 false 只在远程没表态时生效。
 */
export function isBridgePolicyEnabled(): boolean | undefined {
  if (remoteBridgeEnabled !== undefined) return remoteBridgeEnabled;
  return localBridgeEnabled;
}

/** 测试用。生产路径不要调用。 */
export function __resetBridgePolicy(): void {
  remoteBridgeEnabled = undefined;
  localBridgeEnabled = undefined;
}
