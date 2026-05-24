/**
 * 评测系统共享类型定义。
 *
 * 历史：CaseYaml 曾在 eval-runner.ts、_judge/rubric-template.ts、gen-cases-md.ts
 * 三处各写一份，字段集合互不一致。改其一不会触发其他两处类型错误，
 * 已经造成过漂移。此处统一为单一来源。
 */

export interface CaseBaselineEntry {
  score: number | null;
  run_status: string;
  tested_at?: string | null;
  tested_by?: string;
  notes?: string;
  transcript_path?: string | null;
  dimensions?: Record<string, number>;
}

export interface CaseYaml {
  id: string;
  category: string;
  priority: string;
  /** 可选元数据，仅 gen-cases-md.ts 会用 */
  created_date?: string;
  eval_type?: string;
  target_score?: number;
  graduated_at?: string | null;
  holdout?: boolean;
  holdout_reason?: string | null;
  input: {
    user_query: string;
    repo?: string;
    repo_commit?: string;
  };
  expected: {
    outcome?: string;
    must_include_any_of?: string[];
    must_not_include?: string[];
    must_call_tools?: string[];
    /** 工具检查模式：all_of(默认) | any_of(任一即可) */
    must_call_tools_mode?: "all_of" | "any_of";
    must_not_call_tools?: string[];
    must_modify_files_in?: string[];
    must_not_modify_files?: string[];
    max_steps?: number;
    reference_answer?: string;
  };
  rubric?: {
    completeness?: string;
    precision?: string;
    helpfulness?: string;
  };
  baseline_scores?: Record<string, CaseBaselineEntry>;
  source?: string;
  notes?: string;
  related_subsystem?: string[];
}
