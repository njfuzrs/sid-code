/**
 * 路径工具函数
 * 为所有工具提供统一的路径预处理和错误格式化
 *
 * 修复背景：sid-code 所有 10 个接受路径参数的工具均不做路径预处理，
 * 导致弱模型在路径拼写错误时陷入"文件被删了/改名字了"的猜测循环。
 * 此模块把"路径纠错"的负担从模型侧转移到工具侧。
 *
 * See: docs/bugfixes/todo/ReadTool-路径处理缺失-弱模型路径纠错能力不足.md
 */

import { homedir } from "os";
import { resolve, normalize, dirname, basename, sep } from "path";
import { readdirSync, statSync } from "fs";
import { getCwd } from "../bootstrap/state.ts";

/**
 * 预处理工具路径：~ 展开 → resolve → NFC 归一化 → null byte 检查
 * @param raw 原始路径（可能含 ~、相对路径、冗余 ..、NFD 编码）
 * @param cwd 当前工作目录（默认读全局 cwd 状态 getCwd()）
 * @returns 规范化后的绝对路径
 * @throws 如果路径含 null byte
 *
 * 持久 Shell 会话（P0-2）：默认 cwd 从 process.cwd() 改为 getCwd()。
 * bash 工具 cd 后写回全局 cwd（bootstrap/state.ts），此处读全局 cwd，
 * 使 read/edit/write/glob/grep/ls/read-many 全部跟随 bash 的 cd。
 * getCwd() 初值即 process.cwd()，bash 未改 cwd 前行为与改造前一致。
 */
export function normalizeToolPath(raw: string, cwd: string = getCwd()): string {
  // null byte 安全检查
  if (raw.includes("\0")) {
    throw new Error("路径包含非法字符 (null byte)");
  }

  let path = raw.trim();

  // ~ 展开
  if (path === "~") {
    path = homedir();
  } else if (path.startsWith("~/")) {
    path = resolve(homedir(), path.slice(2));
  }

  // resolve（处理相对路径、冗余 ../ 和 //）
  path = resolve(cwd, path);

  // NFC 归一化（macOS 文件名可能以 NFD 存储，导致匹配失败）
  path = normalize(path).normalize("NFC");

  return path;
}

/**
 * Levenshtein 编辑距离（O(n) 空间优化版，无外部依赖）
 * 用于文件名相似度匹配
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // 使用两行滚动数组优化空间
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] =
        a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

/**
 * 在 ancestorDir 下按"去掉分隔符/大小写归一"精确匹配 + Levenshtein 模糊匹配 name。
 * 用于路径某一段拼错时（如 `本体&管道&数据` 被吞成 `本体管道数据`）给出候选。
 * @returns 命中的真实条目名数组（最多 maxHits 个），无命中返回空数组
 */
function findSimilarEntries(ancestorDir: string, name: string, maxHits: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(ancestorDir);
  } catch {
    return [];
  }
  if (entries.length === 0 || entries.length > 5000) return [];

  // 归一：去掉常见 shell 元字符与空格、转小写。
  // 这能直接命中"& 被吞"的场景——`本体&管道&数据` 与 `本体管道数据` 归一后相等。
  const canon = (s: string) => s.replace(/[&|;<>()\\'"\s]/g, "").toLowerCase();
  const targetCanon = canon(name);

  const exactish: string[] = [];
  const fuzzy: { name: string; dist: number }[] = [];
  for (const e of entries) {
    if (e === name) continue; // 完全相等不会走到"不存在"分支，防御性跳过
    if (canon(e) === targetCanon) {
      exactish.push(e); // 归一后相等 → 最强候选（元字符差异）
    } else {
      const dist = levenshteinDistance(canon(e), targetCanon);
      if (dist <= 3) fuzzy.push({ name: e, dist }); // 编辑距离近 → 次级候选（拼写差异）
    }
  }
  // 归一相等的排最前；其次按编辑距离升序（最接近的优先），避免距离远的抢先
  fuzzy.sort((a, b) => a.dist - b.dist);
  return [...exactish, ...fuzzy.map((f) => f.name)].slice(0, maxHits);
}

/**
 * 格式化"路径/文件不存在"错误消息，提供纠错上下文
 * @param filePath 已规范化的文件绝对路径
 * @param cwd 当前工作目录
 * @param maxSiblings 最多返回几个相似文件（默认 3，>5000 文件时跳过）
 */
export function formatPathNotFoundError(
  filePath: string,
  cwd: string = getCwd(),
  maxSiblings = 3,
): string {
  const parentDir = dirname(filePath);
  let parentInfo = "";

  try {
    const parentStat = statSync(parentDir);
    if (parentStat.isDirectory()) {
      // 父目录存在 → 文件本身不存在，尝试找相似文件
      const similar = findSimilarEntries(parentDir, basename(filePath), maxSiblings);
      if (similar.length > 0) {
        parentInfo = `\n目录中存在相似文件: ${similar.join(", ")}`;
      }
    } else {
      parentInfo = `\n注意: 父路径 "${parentDir}" 不是目录`;
    }
  } catch {
    // 父目录也不存在：说明是路径中某一段（目录名）拼错了——这正是
    // "路径里的 & 等字符被终端/剪贴板吞掉"的典型症状。向上回溯到最近一个
    // 真实存在的祖先目录，对第一个缺失的路径段做归一 + 模糊匹配，
    // 直接把正确目录名报给模型，避免它陷入"文件被删/改名了"的猜测循环。
    const suggestion = suggestNearestExistingSegment(filePath);
    parentInfo = suggestion
      ? `\n注意: 父目录 "${parentDir}" 也不存在。${suggestion}`
      : `\n注意: 父目录 "${parentDir}" 也不存在，路径可能整体有误`;
  }

  return `错误: 文件不存在: ${filePath}\n当前工作目录: ${cwd}${parentInfo}`;
}

/** 向上回溯查找存在祖先的最大层数上限（防御极深路径导致过多 statSync） */
const MAX_ANCESTOR_BACKTRACK = 8;

/**
 * 从 filePath 向上回溯，找到最近一个真实存在的祖先目录，
 * 再对"该祖先下第一个缺失的路径段"做归一 + 模糊匹配。
 * 命中则返回形如 `路径段 "X" 疑似应为: Y（完整路径: /.../Y）` 的提示，否则返回空串。
 *
 * 回溯层数上限 MAX_ANCESTOR_BACKTRACK：极深路径（几十层）时不逐级探到根，
 * 最多回溯 N 层，超过则放弃建议（返回空串，退回通用提示）。
 */
function suggestNearestExistingSegment(filePath: string): string {
  const segments = filePath.split(sep).filter((s) => s.length > 0);
  const isAbsolute = filePath.startsWith(sep);

  // 从完整路径逐级向上，找到"存在的祖先 + 它下面第一个不存在的段"
  // 下界额外受 MAX_ANCESTOR_BACKTRACK 约束：最多向上探 N 层
  const lowerBound = Math.max(1, segments.length - 1 - MAX_ANCESTOR_BACKTRACK);
  for (let i = segments.length - 1; i >= lowerBound; i--) {
    const ancestorParts = segments.slice(0, i);
    const ancestorDir = (isAbsolute ? sep : "") + ancestorParts.join(sep);
    let ok = false;
    try {
      ok = statSync(ancestorDir).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) continue;

    // ancestorDir 存在，segments[i] 是它下面第一个缺失的段
    const missingSeg = segments[i];
    const hits = findSimilarEntries(ancestorDir, missingSeg, 3);
    if (hits.length > 0) {
      const best = hits[0];
      const fullPath =
        ancestorDir +
        sep +
        best +
        (i < segments.length - 1 ? sep + segments.slice(i + 1).join(sep) : "");
      const more = hits.length > 1 ? `（其它候选: ${hits.slice(1).join(", ")}）` : "";
      return `路径段 "${missingSeg}" 疑似应为 "${best}"${more}。可尝试完整路径: ${fullPath}`;
    }
    // 找到最近存在的祖先但无相似段，无需再往上找
    return "";
  }
  return "";
}
