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
  /**
   * Grader 类型（task-specific-v1 起生效，T-10 引入）。
   * 缺失时 fallback 为 "rubric_5d"（5d-v2 行为，保持向后兼容）。
   * 已注册类型见 evals/_graders/registry.ts。
   */
  grader_type?: string;
  /**
   * Mandatory 维度白名单（T-11 引入）。
   *
   * 设计：rubric_5d grader 默认所有维度都进总分加权（5d-v2 行为）。
   * 当 case yaml 显式声明 mandatory_dimensions 时：
   *   - 列表内的维度：mandatory（任一不 pass → mandatoryPass=false）
   *   - 列表外的维度：optional（仍参与加权 + 落 jsonl，但不影响 case pass/fail 判定）
   *
   * 业界对应：SWE Atlas 直接引用 "Only Test Comprehensiveness rubrics are must-have;
   * the rest produce qualitative signal."（mandatory + optional 分级）
   *
   * 默认（缺失或空数组）：5d-v2 兼容模式——negative_anchor.pass + score >= 2.5 = mandatoryPass
   *
   * 示例：
   *   mandatory_dimensions: ["rubric_score", "negative_anchor"]
   *   表示 rubric/negative 必须 pass，anchor/tool/eff/cost 仅诊断
   */
  mandatory_dimensions?: string[];
  /**
   * 红线 binary 规则（grader_type=binary_redline 时使用）。
   * 每条规则独立判定，任一违反 = case fail（mandatoryPass=false）。
   */
  binary_rules?: BinaryRule[];
  /**
   * 结构化架构断言（grader_type=structured_arch 时使用）。
   * 全部 pass = mandatory pass；任一 fail = case fail。
   */
  arch_assertions?: ArchAssertion[];
  /**
   * Execution grading 配置（grader_type=execution_test 时使用，T-19 引入）。
   * 用 sandbox 跑 fixture + agent patch 后跑测试命令，binary pass/fail。
   * 设计依据：SWE-bench Verified（500 case 全 docker 测试，0 LLM judge）。
   */
  execution_test?: ExecutionTestSpec;
  /**
   * Trajectory 诊断断言（grader_type=trajectory_match 时使用，B6-7/B6-8 / ADR-033 引入）。
   * **M5 之前仅作诊断**：分数不进总分加权；落 _reports/sprint-S<N>/diagnostic/ 用于失败根因分析。
   * §15.2 v1.3 修正：等价路径爆炸 + 里程碑主观 + 步数差不是错误信号 — 三条铁律决定诊断维度而非 KPI。
   */
  trajectory_assertion?: TrajectoryAssertion;
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

/**
 * 红线 binary 规则（T-10 引入，binary_redline grader 消费）。
 *
 * 设计：每条规则独立判定，全部通过 = mandatoryPass=true；任一失败 = case 直接 fail（一票否决）。
 * 不参与 5 维加权——红线就是 binary，不存在"打 0.6 分通过"的中间态。
 */
export type BinaryRule =
  | {
      /** output 不得包含任一 pattern（字符串子串匹配） */
      type: "output_must_not_contain";
      patterns: string[];
    }
  | {
      /** output 必须包含任一 pattern（all_of=true 时改为全部包含） */
      type: "output_must_contain";
      patterns: string[];
      all_of?: boolean;
    }
  | {
      /** agent 不得修改 paths 中任一文件（依赖 wrapper 上报 files_edited） */
      type: "must_not_modify_paths";
      paths: string[];
    }
  | {
      /** LLM 单独跑 binary 判断（独立于 5 维 rubric，仅 pass/fail，不进加权） */
      type: "semantic_binary_judge";
      prompt: string;
    };

/**
 * 架构 case 的结构化断言（T-10 引入，structured_arch grader 消费）。
 *
 * 用例：架构 holdout case 验证"src/skill/code-review/SKILL.md 必须存在"、"src/cli.ts 必须 <500 行"等。
 */
export type ArchAssertion =
  | { type: "file_must_exist"; path: string }
  | { type: "file_must_not_exist"; path: string }
  | { type: "file_lines_lt"; path: string; max_lines: number }
  | { type: "file_must_contain"; path: string; pattern: string }
  | { type: "dir_must_contain_files"; dir: string; min_count: number };

/**
 * Execution grading 配置（T-19 引入，execution_test grader 消费）。
 *
 * 设计：sandbox 中先放 fixture（用户原始仓库状态），运行 agent 输出的 patch（apply_patch 步骤），
 * 再跑测试命令。测试命令退出码决定 binary pass/fail——SWE-bench Verified 风格。
 *
 * 业界对应：
 *   - SWE-bench Verified：FAIL_TO_PASS 测试由失败转为通过 = 1，否则 = 0
 *   - Inspect AI sandbox scorer（check_file_exists / bash 退出码）
 *
 * agent 输出格式约定：
 *   - 输出最末尾必须含一段 markdown ```diff ... ``` 或 ```patch ... ```
 *   - patch 是 unified diff 格式（git diff 输出）
 *   - sandbox 用 `git apply` 或 `patch -p1` 应用
 *
 * 用例：
 *   - code-review case：fixture 含 unhandled rejection，agent patch 应加 catch；
 *     测试命令 `bun test` 必须由 fail → pass
 *   - ci-self-heal case：fixture 含 type error，agent patch 修类型；`tsc --noEmit` 必须 0 退出
 *   - security-audit case：fixture 含 SQL injection，agent patch 加参数化；测试模拟 attack input
 */
export interface ExecutionTestSpec {
  /** Fixture 文件（按路径写入 sandbox） */
  fixtures: Array<{ path: string; content: string }>;
  /**
   * 应用 agent patch 的方式：
   *   - "extract_diff": 从 agent output 末尾提取 ```diff/```patch 代码块，用 git apply 应用
   *   - "extract_files": 从 agent output 提取 "=== FILE: path ===" 段，覆盖 fixtures
   *   - "skip": 不应用 patch，直接跑 verify_commands（用于检查 agent 是否正确分析）
   */
  apply_mode: "extract_diff" | "extract_files" | "skip";
  /**
   * 应用 patch 后跑的验证命令（按顺序执行）。
   * 任一非 0 退出 = 整体 fail。每条命令独立计时（默认 30s）。
   */
  verify_commands: Array<{ cmd: string; args: string[]; timeout_ms?: number }>;
  /** sandbox 总耗时上限（默认 120s） */
  total_timeout_ms?: number;
  /** 期望必须 fail 的命令（fixture 验证：未应用 patch 时这些命令应该 fail） */
  pre_apply_must_fail?: Array<{ cmd: string; args: string[] }>;
}

/**
 * Trajectory diagnostic assertion（B6-8 / ADR-033 引入）。
 *
 * 设计原则（§15.2 v1.3）：
 *   1. **不进总分加权**：M5 前仅作诊断维度，落 _reports/.../diagnostic/<case_id>.json
 *   2. **不奖励短路径**：reward 公式禁止 step 数 ≤ reference 的正向项；仅在长度爆炸时告警
 *   3. **等价路径不当错误**：tool_equivalence_classes 把 grep / rg / lsp_references 视为同一组
 *
 * 升格判定（M5 后才会启动）：
 *   - 等价类误判率 < 15%（人工 spot-check 100 条）
 *   - milestone 命中率与 execution pass rate 相关性 ρ ≥ 0.5
 *   - 不同 LLM provider 跑同一 case，trajectory_match score 方差 < 0.2
 */
export interface TrajectoryAssertion {
  /**
   * 必须达成的语义里程碑（描述性，不绑定具体工具）。
   * grader 用 LLM judge 在 spans 序列上做语义匹配；任一未命中 → 该里程碑 fail。
   * 示例："找到 src/agent/loop.ts" / "理解 sub-loop 与 main-loop 区别"
   */
  milestones: string[];
  /**
   * 工具等价类（同一组内的工具被视为可互换）。
   * 示例：[["grep", "rg", "lsp_references"], ["read", "cat", "lsp_definition"]]
   * milestone 命中判定时，命中等价组任一工具即可。
   */
  tool_equivalence_classes?: string[][];
  /**
   * 关键参数断言（可选，针对必须命中特定文件 / 路径的场景）。
   * field 为 spans[*].tool_input 的 jsonpath（简化版："file_path" / "args[0]"）。
   * 示例：[{ field: "file_path", regex: "^src/agent/.*\\.ts$" }]
   */
  arg_must_match?: Array<{ field: string; regex: string }>;
  /**
   * 异常告警阈值。
   * - 步数 > max_steps × 2 时告警「探索过度」
   * - 步数 < milestones.length / 2 时告警「步数太少疑似过早收尾」
   * - 注意：**不奖励** step ≤ max_steps；仅作长度爆炸告警
   */
  max_steps?: number;
}
