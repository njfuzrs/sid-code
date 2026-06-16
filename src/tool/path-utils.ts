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
import { resolve, normalize, dirname, basename } from "path";
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
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
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
      const siblings = readdirSync(parentDir);
      if (siblings.length > 0 && siblings.length <= 5000) {
        const targetBase = basename(filePath).replace(/\.[^.]+$/, "");
        const similar = siblings
          .filter(s => {
            const sBase = s.replace(/\.[^.]+$/, "");
            return sBase === targetBase || levenshteinDistance(sBase, targetBase) <= 3;
          })
          .slice(0, maxSiblings);
        if (similar.length > 0) {
          parentInfo = `\n目录中存在相似文件: ${similar.join(", ")}`;
        }
      }
    } else {
      parentInfo = `\n注意: 父路径 "${parentDir}" 不是目录`;
    }
  } catch {
    parentInfo = `\n注意: 父目录 "${parentDir}" 也不存在，路径可能整体有误`;
  }

  return `错误: 文件不存在: ${filePath}\n当前工作目录: ${cwd}${parentInfo}`;
}
