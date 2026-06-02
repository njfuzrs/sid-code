/**
 * Settings 合并语义
 *
 * 对齐 Spec 15 §3.3：读取时拼接，写入时替换。
 * - 读取时拼接：多来源的 deny 规则应叠加（用户 deny + 项目 deny 都生效）
 * - 写入时替换：用户通过命令修改自己的列表时应精确控制内容
 *
 * 不依赖 lodash——本模块自带深度合并实现（结构与 lodash.mergeWith + customizer 等价）。
 */

type AnyRecord = Record<string, unknown>;

function isPlainObject(v: unknown): v is AnyRecord {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

/**
 * 合并数组：
 * - 字符串数组（如权限规则）→ 拼接 + 去重
 * - 对象/混合数组（如 budgetRules）→ 直接拼接
 */
function mergeArrays(target: unknown[], source: unknown[]): unknown[] {
  const allStrings =
    target.every((v) => typeof v === "string") &&
    source.every((v) => typeof v === "string");
  if (allStrings) {
    return [...new Set([...target, ...source])];
  }
  return [...target, ...source];
}

/**
 * 读取合并：深度合并 + 数组拼接去重。
 * 后者（source）覆盖前者（target）的标量，对象递归合并，数组按上面的策略合并。
 * 返回新对象，不修改入参。
 */
export function mergeSettingsRead<T extends AnyRecord>(
  target: T,
  source: AnyRecord,
): T {
  const result: AnyRecord = { ...target };

  for (const [key, srcVal] of Object.entries(source)) {
    if (srcVal === undefined) continue;
    const tgtVal = result[key];

    if (Array.isArray(tgtVal) && Array.isArray(srcVal)) {
      result[key] = mergeArrays(tgtVal, srcVal);
    } else if (isPlainObject(tgtVal) && isPlainObject(srcVal)) {
      result[key] = mergeSettingsRead(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }

  return result as T;
}

/**
 * 写入合并：深度合并 + 数组替换 + undefined 删除。
 * 用于"基于现有 Settings 应用一组补丁后写回文件"的场景。
 * - 数组：直接替换（不拼接），精确控制单个来源
 * - undefined：删除该字段
 * 返回新对象，不修改入参。
 */
export function mergeSettingsWrite<T extends AnyRecord>(
  target: T,
  patch: AnyRecord,
): T {
  const result: AnyRecord = { ...target };

  for (const [key, patchVal] of Object.entries(patch)) {
    if (patchVal === undefined) {
      delete result[key]; // undefined 表示删除
      continue;
    }
    const tgtVal = result[key];

    if (Array.isArray(patchVal)) {
      result[key] = patchVal; // 数组直接替换
    } else if (isPlainObject(tgtVal) && isPlainObject(patchVal)) {
      result[key] = mergeSettingsWrite(tgtVal, patchVal);
    } else {
      result[key] = patchVal;
    }
  }

  return result as T;
}
