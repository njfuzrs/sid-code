/**
 * 差分算法
 * 用于 Checkpoint 系统的增量存储：计算两个文本之间的差异，支持 apply 还原
 *
 * 优化策略：
 * 1. 小文件（<1000 行）：使用 LCS 算法（去掉冗余滚动数组计算）
 * 2. 大文件（>=1000 行）：使用 Myers diff 算法（O(ND) 时间，D 为编辑距离）
 * 3. 超大文件（>10000 行）：返回空 ops，调用方会直接存 full
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

const SMALL_FILE_THRESHOLD = 1000; // 行数
const LARGE_FILE_THRESHOLD = 10000; // 行数

/**
 * 计算 diff：根据文件大小选择算法
 */
export function computeDiff(oldText: string, newText: string): DiffResult {
  if (oldText === newText) {
    return { ops: [{ type: "keep", lines: oldText.split("\n") }] };
  }

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const maxLines = Math.max(oldLines.length, newLines.length);

  if (maxLines < SMALL_FILE_THRESHOLD) {
    return lcsBasedDiff(oldLines, newLines);
  } else if (maxLines < LARGE_FILE_THRESHOLD) {
    // 暂时对大文件也使用 LCS，Myers diff 需要更多调试
    return lcsBasedDiff(oldLines, newLines);
  } else {
    // 超大文件不做 diff，调用方会直接存 full
    return { ops: [] };
  }
}

/**
 * 基于 LCS 的行级 diff（优化版：去掉冗余滚动数组计算）
 */
function lcsBasedDiff(oldLines: string[], newLines: string[]): DiffResult {
  const m = oldLines.length;
  const n = newLines.length;

  // 直接构建完整 DP 表（不再先用滚动数组算一遍）
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
  const rawOps: { type: "keep" | "add" | "remove"; line: string }[] = [];
  let i = m,
    j = n;

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

  const ops: DiffOp[] = [];
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
 * Myers diff 算法（用于大文件）
 * 时间复杂度：O((M+N)D)，其中 D 是编辑距离
 * 空间复杂度：O(M+N)
 *
 * ⚠️ 当前**未接线**：`computeDiff` 对 1000~10000 行的中等文件仍走 `lcsBasedDiff`，
 * 注释写着「Myers diff 需要更多调试」（见上方分派处）。这是**未完成的在建实现**，
 * 不是失效的死代码 —— 所以 lint 在这里显式豁免而不是删掉它。
 * 接线时把 `lcsBasedDiff` 那条分支换成 `myersDiff` 并补上大文件用例即可。
 */
// oxlint-disable-next-line no-unused-vars -- 在建实现，待接线（见上方 doc 注释）
function myersDiff(oldLines: string[], newLines: string[]): DiffResult {
  const m = oldLines.length;
  const n = newLines.length;
  const max = m + n;

  // V[k] 表示在对角线 k 上能到达的最远 x 坐标
  const v = new Map<number, number>();
  v.set(1, 0);

  // 记录每一步的 V 快照（用于回溯）
  const trace: Map<number, number>[] = [];

  for (let d = 0; d <= max; d++) {
    const vSnapshot = new Map(v);
    trace.push(vSnapshot);

    for (let k = -d; k <= d; k += 2) {
      let x: number;

      // 决定是从上方还是左方移动
      if (k === -d || (k !== d && (v.get(k - 1) || 0) < (v.get(k + 1) || 0))) {
        x = v.get(k + 1) || 0;
      } else {
        x = (v.get(k - 1) || 0) + 1;
      }

      let y = x - k;

      // 沿对角线前进（匹配的行）
      while (x < m && y < n && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }

      v.set(k, x);

      // 到达终点
      if (x >= m && y >= n) {
        return backtrackMyersDiff(oldLines, newLines, trace, d);
      }
    }
  }

  // 理论上不会到这里
  return { ops: [] };
}

/**
 * Myers diff 回溯：从 trace 重建 diff ops
 */
function backtrackMyersDiff(
  oldLines: string[],
  newLines: string[],
  trace: Map<number, number>[],
  d: number,
): DiffResult {
  const m = oldLines.length;
  const n = newLines.length;

  let x = m;
  let y = n;

  const rawOps: { type: "keep" | "add" | "remove"; line: string }[] = [];

  for (let depth = d; depth > 0; depth--) {
    const vPrev = trace[depth - 1];
    const k = x - y;

    let prevK: number;
    if (k === -depth || (k !== depth && (vPrev.get(k - 1) || 0) < (vPrev.get(k + 1) || 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = vPrev.get(prevK) || 0;
    const prevY = prevX - prevK;

    // 沿对角线的匹配部分
    while (x > prevX && y > prevY) {
      x--;
      y--;
      rawOps.push({ type: "keep", line: oldLines[x] });
    }

    // 单步移动
    if (x > prevX) {
      x--;
      rawOps.push({ type: "remove", line: oldLines[x] });
    } else if (y > prevY) {
      y--;
      rawOps.push({ type: "add", line: newLines[y] });
    }
  }

  // 处理起点的对角线匹配
  while (x > 0 && y > 0) {
    x--;
    y--;
    rawOps.push({ type: "keep", line: oldLines[x] });
  }

  // 反转并合并
  rawOps.reverse();

  const ops: DiffOp[] = [];
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
  const oldLines = oldText.split("\n");
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

  return result.join("\n");
}

/**
 * 反向应用 diff：从 newText 还原出 oldText
 * 用于 undo 操作
 */
export function reverseDiff(newText: string, diff: DiffResult): string {
  const newLines = newText.split("\n");
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

  return result.join("\n");
}
