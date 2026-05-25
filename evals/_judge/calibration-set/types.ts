/**
 * Pair schema 类型定义（T-13）
 */

export interface CalibrationPair {
  pair_id: string;
  category: string;
  user_query: string;
  response_A: string;
  response_B: string;
  /** 已知正确选项（"A" / "B" / "tie"） */
  ground_truth_winner: "A" | "B" | "tie";
  source: string;
  notes?: string;
}

export interface CalibrationVerdict {
  pair_id: string;
  judge: string;
  /** 跑 pair 的顺序：AB（先 A 后 B）/ BA（先 B 后 A） */
  order: "AB" | "BA";
  /** judge 选的赢家（按顺序里的"第一个"/"第二个"/"tie"） */
  judge_pick: "first" | "second" | "tie" | "error";
  /** 标准化后判定（统一映射到 A/B/tie/error） */
  normalized_winner: "A" | "B" | "tie" | "error";
  /** judge 的简短理由 */
  reason: string;
  /** 是否选对 ground truth */
  correct: boolean;
  tested_at: string;
}

export interface CalibrationSummary {
  judge: string;
  total_pairs: number;
  position_bias: number; // 0-1
  accuracy_AB: number;
  accuracy_BA: number;
  accuracy_avg: number;
  verdict_flip_rate: number;
  by_category: Record<string, { count: number; accuracy: number }>;
}
