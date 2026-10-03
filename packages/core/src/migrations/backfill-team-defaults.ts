/**
 * 团队默认配置补全：迁移 v1 + 每次启动的增量补全（B35）
 *
 * 背景：`sid-code update` 只替换二进制、不碰用户 ~/.sid-code/settings.json（install.sh 是
 * 纯 bash，只有「文件不存在才整份 cp」的语义，无法做 JSON 顶层合并）。早期安装的用户因此
 * 永远拿不到后来新增的团队默认字段（subAgentModels / search / trace / quota 等）。
 *
 * 两段补全，语义相同（只补用户缺失的顶层键、`{}` / `[]` 算已表态、不展开 env 占位符）：
 * - `migrate()`：迁移 v1，首次升级时把模板里用户缺的顶层键全部补上，并记下模板键集合。
 * - `backfillNewTemplateKeys()`：每次启动都跑，**不受全局迁移水位线约束**。只补
 *   「本次模板顶层键 − 上次记录的顶层键」里用户缺失的那几个。
 *
 * 为什么拆出独立水位：v1 挂在全局水位线上，水位线过了 1 就永不重跑，于是改模板发版
 * 老用户依旧拿不到新字段——这正是 v1 当初要补的断层，只补了一次就又断了（D127）。
 *
 * 为什么只补「新增键」而不是「哈希一变就补全部缺失键」：用户补全后主动删掉某个键是表态，
 * 哈希变了就全量补会把删掉的键加回来。哈希只是快路径（没变就不碰 settings.json），
 * 真正决定补什么的是键集合差。
 *
 * 没有记录的老用户（B35 之前已跑过 v1）：不知道当年补全时模板有哪些键，分不清「模板后来
 * 才加的」与「用户自己删掉的」，所以首次只把当前键集合记为基线、不补任何键。代价是 B35
 * 之前就已加进模板的键对这些用户仍缺——宁可少补，不复活用户删掉的配置。
 *
 * 单一事实源：直接 import 团队默认模板 scripts/team-defaults.template.json（Bun --compile
 * 会把它内联进二进制，与 install.sh 首装拷贝的服务器版同源，避免两份 drift）。
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
// 指向**仓库根**的 scripts/（不是包内）。P2-2 分包后本文件深了两层，故 ../../../../。
import teamDefaults from "../../../../scripts/team-defaults.template.json" with { type: "json" };
import { mergeMissingTopLevelKeys } from "../config/settings/settings.ts";
import { sidPaths } from "../config/paths.ts";

type Template = Record<string, unknown>;

/** migrations.json 里的独立水位：上次补全时模板的内容哈希与顶层键集合 */
interface TeamDefaultsMark {
  hash: string;
  keys: string[];
}

function templateHash(template: Template): string {
  return createHash("sha256").update(JSON.stringify(template)).digest("hex");
}

function readState(): Record<string, unknown> {
  try {
    const file = sidPaths.migrationState();
    if (!existsSync(file)) return {};
    const data = JSON.parse(readFileSync(file, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function readMark(): TeamDefaultsMark | null {
  const mark = readState().teamDefaults as Partial<TeamDefaultsMark> | undefined;
  if (!mark || typeof mark.hash !== "string" || !Array.isArray(mark.keys)) return null;
  return { hash: mark.hash, keys: mark.keys.filter((k): k is string => typeof k === "string") };
}

/** 写独立水位，保留 migrations.json 其它字段（migrationVersion 由 runner 管） */
function writeMark(template: Template): void {
  const dir = sidPaths.state();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data = readState();
  data.teamDefaults = { hash: templateHash(template), keys: Object.keys(template) };
  writeFileSync(sidPaths.migrationState(), JSON.stringify(data, null, 2), "utf-8");
}

function announce(added: string[]): void {
  if (added.length > 0) {
    console.log(`已补全团队默认配置字段（未覆盖任何已有配置）: ${added.join(", ")}`);
  }
}

/** 迁移 v1：首次升级时全量补缺失顶层键，并记下模板键集合作为后续增量补全的基线 */
export function migrate(template: Template = teamDefaults as Template): void {
  // 先补再记：补全抛错（settings.json 损坏）时不记水位，修好后 v1 重跑仍会全量补
  announce(mergeMissingTopLevelKeys("userSettings", template));
  writeMark(template);
}

/**
 * 每次启动的增量补全：只补模板相对上次记录新增的顶层键。
 * 抛错（settings.json 损坏 / 写盘失败）时不更新水位，下次启动重试；由 runner 转成启动告警。
 */
export function backfillNewTemplateKeys(template: Template = teamDefaults as Template): string[] {
  const mark = readMark();
  if (mark && mark.hash === templateHash(template)) return [];

  if (!mark) {
    // 无记录：B35 之前的老用户。只记基线，不补（理由见文件头）。
    writeMark(template);
    return [];
  }

  const known = new Set(mark.keys);
  const fresh: Template = {};
  for (const [key, value] of Object.entries(template)) {
    if (!known.has(key)) fresh[key] = value;
  }
  const added =
    Object.keys(fresh).length > 0 ? mergeMissingTopLevelKeys("userSettings", fresh) : [];
  announce(added);
  writeMark(template);
  return added;
}
