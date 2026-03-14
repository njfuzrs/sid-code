/**
 * LCS 差分算法
 * 用于 Checkpoint 系统的增量存储：计算两个文本之间的差异，支持 apply 还原
 */

/** 差分操作类型 */
export interface DiffOp {
  /** 操作类型：keep=保留, add=新增, remove=删除 */
  type: "keep" | "add" | "remove";
  /** 行内容 */
  lines: string[];
}

/** 差分结果 */
export interface DiffResult {
  ops: DiffOp[];
}

/**
 * 基于 LCS 的行级 diff
 * 计算从 oldText 到 newText 的差异
 */
export function computeDiff(oldText: string, newText: string): DiffResult {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // 计算 LCS 表
  const m = oldLines.length;
  const n = newLines.length;

  // 优化：如果内容相同，直接返回 keep
  if (oldText === newText) {
    return { ops: [{ type: "keep", lines: oldLines }] };
  }

  // 使用滚动数组优化空间（只需要两行）
  let prev = new Uint16Array(n + 1);
  let curr = new Uint16Array(n + 1);

  for (let i = 1; i <= m; i++) {
    [prev, curr] = [curr, prev];
    curr.fill(0);
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
  }

  // 需要完整表来回溯，重新计算（空间换时间）
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯生成 diff ops
  const ops: DiffOp[] = [];
  let i = m, j = n;

  // 临时收集（逆序）
  const rawOps: { type: "keep" | "add" | "remove"; line: string }[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      rawOps.push({ type: "keep", line: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawOps.push({ type: "add", line: newLines[j - 1] });
      j--;
    } else {
      rawOps.push({ type: "remove", line: oldLines[i - 1] });
      i--;
    }
  }

  // 反转并合并连续相同类型的操作
  rawOps.reverse();

  let currentOp: DiffOp | null = null;
  for (const raw of rawOps) {
    if (currentOp && currentOp.type === raw.type) {
      currentOp.lines.push(raw.line);
    } else {
      if (currentOp) ops.push(currentOp);
      currentOp = { type: raw.type, lines: [raw.line] };
    }
  }
  if (currentOp) ops.push(currentOp);

  return { ops };
}

/**
 * 将 diff 应用到 oldText 上，还原出 newText
 */
export function applyDiff(oldText: string, diff: DiffResult): string {
  const oldLines = oldText.split('\n');
  const result: string[] = [];
  let oldIdx = 0;

  for (const op of diff.ops) {
    switch (op.type) {
      case "keep":
        // 保留原始行
        for (let i = 0; i < op.lines.length; i++) {
          result.push(oldLines[oldIdx++]);
        }
        break;
      case "add":
        // 插入新行
        result.push(...op.lines);
        break;
      case "remove":
        // 跳过旧行
        oldIdx += op.lines.length;
        break;
    }
  }

  return result.join('\n');
}

/**
 * 反向应用 diff：从 newText 还原出 oldText
 * 用于 undo 操作
 */
export function reverseDiff(newText: string, diff: DiffResult): string {
  const newLines = newText.split('\n');
  const result: string[] = [];
  let newIdx = 0;

  for (const op of diff.ops) {
    switch (op.type) {
      case "keep":
        for (let i = 0; i < op.lines.length; i++) {
          result.push(newLines[newIdx++]);
        }
        break;
      case "add":
        // 反向：add 变成跳过
        newIdx += op.lines.length;
        break;
      case "remove":
        // 反向：remove 变成插入
        result.push(...op.lines);
        break;
    }
  }

  return result.join('\n');
}
