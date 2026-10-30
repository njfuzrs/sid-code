/**
 * 本地企业策略文档的唯一读取口：主文件 + managed-settings.d/*.json drop-in。
 *
 * 为什么要有这一层：此前 drop-in 只进了 settings 链（settings.ts）和 hooks（hook-layers.ts），
 * 真正执行企业约束的两个消费方——rule-loader 的权限规则、ManagedFileLoader 的模式开关 /
 * policyLimits / strictPluginOnlyCustomization——都只读主文件。管理员把 deny 写进 drop-in，
 * 加载不报错、规则不生效；主文件不存在时 drop-in 更是完全没人读。
 * 与 paths.ts managedPolicyCandidates 的历史教训同形：几处各读各的，放哪都只能生效一部分。
 *
 * 合并语义与 settings 链 policySettings 层一致（mergeSettingsRead）：主文件作基座，
 * drop-in 按文件名字母序叠加，字符串数组拼接去重（deny 只增不减），标量后者覆盖前者。
 */

import { existsSync, readFileSync } from "fs";
import { resolveManagedPolicyFile } from "./paths.ts";
import { listManagedSettingsDropIns } from "./settings/constants.ts";
import { mergeSettingsRead } from "./settings/merge.ts";

export interface ManagedPolicyDocument {
  /** 命中的主文件（候选链首个存在者）；不存在为 null */
  mainFile: string | null;
  /** 成功解析并参与合并的 drop-in */
  dropIns: string[];
  /** 合并后的策略对象 */
  settings: Record<string, unknown>;
  /** 解析失败的文件（主文件坏掉时 settings 只含 drop-in 部分，由调用方决定怎么处置） */
  errors: Array<{ file: string; message: string }>;
}

function parseObject(file: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(file, "utf-8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("顶层必须是 JSON 对象");
  }
  return raw as Record<string, unknown>;
}

/**
 * 读取并合并本地企业策略。主文件与 drop-in 都不存在时返回 null（= 未部署本地策略）。
 */
export function readManagedPolicyDocument(): ManagedPolicyDocument | null {
  const mainFile = resolveManagedPolicyFile();
  const dropInFiles = listManagedSettingsDropIns();
  if (!mainFile && dropInFiles.length === 0) return null;

  const errors: ManagedPolicyDocument["errors"] = [];
  let settings: Record<string, unknown> = {};
  if (mainFile && existsSync(mainFile)) {
    try {
      settings = parseObject(mainFile);
    } catch (err: any) {
      errors.push({ file: mainFile, message: err?.message ?? String(err) });
    }
  }
  const dropIns: string[] = [];
  for (const file of dropInFiles) {
    try {
      settings = mergeSettingsRead(settings, parseObject(file));
      dropIns.push(file);
    } catch (err: any) {
      errors.push({ file, message: err?.message ?? String(err) });
    }
  }
  return { mainFile, dropIns, settings, errors };
}
