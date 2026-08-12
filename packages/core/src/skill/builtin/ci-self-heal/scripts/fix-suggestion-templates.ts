#!/usr/bin/env bun
/**
 * fix-suggestion-templates.ts — ci-self-heal Skill 确定性脚本 (S6-T10)
 *
 * 输入: classify-failure.ts 的 JSON 输出 (stdin 或 --file <path>)
 *      可选 --max-suggestions <n> 限制返回数量(默认 3)
 *
 * 输出: 结构化建议 JSON to stdout
 *   {
 *     class: <FailureClass>,
 *     suggestions: [{
 *       title: string,             // 一行摘要
 *       command_or_action: string, // 可执行命令或动作描述
 *       why: string,               // 为什么这样做
 *       confidence: number,        // 0.0..1.0
 *       references: string[],      // 引用文件 (来自 fileRefs)
 *     }],
 *     escalation: string | null,   // 当 confidence 全部 < 0.5 时给出"建议人介入"提示
 *   }
 *
 * 用途: classify 完成后, 由模板生成 N 条候选 fix 给 LLM 兜底, 不强制采用.
 *      LLM 在 SKILL.md §2.4 7 维度推理后, 会从模板里挑或弃.
 *
 * 由 RFC-002 §2.4 / SKILL.md §3.3 定义.
 *
 * 设计原则:
 *   - 模板只给 read-only 的诊断动作 + 文档建议, 永不直接调 edit/write
 *     (RL-001 不删用户代码 / RL-006 ci-self-heal 不修源码, 只给建议)
 *   - confidence 取自 classify 结果, 衰减 0.1 (模板永远比真分类略保守)
 *   - 多类失败 (candidate_alternatives) 时把次选也产出, 让 LLM 决断
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { ClassifyResult, FailureClass } from "./classify-failure.ts";
import type { ParsedCILog, FileRef } from "./parse-ci-log.ts";

export interface FixSuggestion {
  title: string;
  command_or_action: string;
  why: string;
  confidence: number;
  references: string[];
}

export interface FixTemplateResult {
  class: FailureClass;
  suggestions: FixSuggestion[];
  escalation: string | null;
}

export interface FixTemplateInput {
  classify: ClassifyResult;
  /** 可选: parse-ci-log 原始输出, 用于产 references */
  parsed?: ParsedCILog;
  maxSuggestions?: number;
}

const TEMPLATES: Record<FailureClass, Array<Omit<FixSuggestion, "confidence" | "references">>> = {
  test_failure: [
    {
      title: "复现失败用例 (单条 / 单文件粒度)",
      command_or_action:
        "在本地按 CI 同样的命令跑单条用例: jest/vitest --testNamePattern '<name>' 或 pytest -k '<name>'. 不要全量重跑直到能稳定复现.",
      why: "test_failure 第一步必须是稳定复现; 不能复现的失败几乎总是 flaky 或环境问题, 走 flaky 分支处理.",
    },
    {
      title: "比对 expected vs actual",
      command_or_action:
        "读 failedAssertions 里的 expected/actual, 检查是不是 fixture/snapshot 过期 (大量字段微小差异 = 真改动; 单字段差 = 真 bug).",
      why: "AI 生成代码场景下, 测试失败 ~30% 是 snapshot 过期, 不要直接改源码.",
    },
    {
      title: "逐步缩小变更范围",
      command_or_action:
        "git bisect / 看 PR diff: 失败用例对应的 file:line 是否在本次 diff 内? 不在 = 旁支断裂, 提醒用户先合主分支.",
      why: "RL-007 不编造问题: 必须用 file:line 证据指明失败来源.",
    },
  ],
  lint_failure: [
    {
      title: "本地跑同版本 lint",
      command_or_action:
        "用 PR 里 package.json 锁定的 eslint 版本本地复现 (npx eslint --version 对齐 CI). 版本不一致是 ~50% 误报来源.",
      why: "AI 生成代码场景下, lint 规则差异远比代码 bug 多.",
    },
    {
      title: "用 --fix 自动修可机修问题",
      command_or_action:
        "如果本地复现的是格式 / 简单规则 (no-unused-vars / prefer-const), 跑 'eslint --fix' / 'prettier --write' 后看 diff, 不要手改.",
      why: "可机修问题手动改容易引入新错; 让用户自己跑 --fix 比 Skill 写脚本安全.",
    },
    {
      title: "评估是否需要单条 disable",
      command_or_action:
        "如果是误报 (类型反问题 / generic 规则), 在源文件用 // eslint-disable-next-line <rule> 注释 + 一行 why 说明, 不要全文件 disable.",
      why: "RL-001 守护: 不动到的代码不要碰 + 单行 disable 比全文 disable 风险低.",
    },
  ],
  build_failure: [
    {
      title: "看完整错误的第一帧",
      command_or_action:
        "stack trace 里第一个 file:line 通常是真因 (后面的是 cascade). 用 read 工具打开该文件 ±10 行确认.",
      why: "build 错误 stack 经常多达 50+ 帧, 不抓第一帧很容易看错位置.",
    },
    {
      title: "比对 lock 文件",
      command_or_action:
        "如果错误指向 node_modules / vendor 里的文件, 用 grep 检查 package-lock.json / Cargo.lock 是否与 PR 同步; 不同步则提醒先 'npm ci' / 'cargo update'.",
      why: "lock 不同步是 build 失败 ~25% 的来源, 与代码无关.",
    },
  ],
  type_error: [
    {
      title: "看 TS error code 对应说明",
      command_or_action:
        "把 'error TS\\d{4}' 中的 code 在 https://typescript.tv/errors/ 查具体含义, 不要猜.",
      why: "TS error 信息常误导 (例如 TS2322 在不同上下文意思差很多).",
    },
    {
      title: "确认 tsconfig 是否冲突",
      command_or_action:
        "用 read 看根 tsconfig + monorepo 子包 tsconfig, 检查 strict / target / moduleResolution 是否一致.",
      why: "AI 生成代码场景下, monorepo 子包 tsconfig 不一致是 type_error 高发原因.",
    },
  ],
  dependency_missing: [
    {
      title: "确认 import 是否拼写错误",
      command_or_action:
        "对照 package.json deps 列表 + node_modules 实际目录, 看 import 路径大小写 / 包名是否完全匹配 (Linux CI 区分大小写, mac 不区分).",
      why: "AI 生成代码 ~40% 的 'Cannot find module' 是大小写或拼写错误.",
    },
    {
      title: "区分 missing vs version mismatch",
      command_or_action:
        "如果是 'Cannot find module', 跑 'ls node_modules/<pkg>'. 没有 = 真缺; 有但 import 失败 = 版本/导出路径变了, 看 CHANGELOG.",
      why: "处理路径完全不同, 不能合并.",
    },
  ],
  config_error: [
    {
      title: "校验 YAML / JSON 语法",
      command_or_action:
        "用 yamllint / jsonlint / 'bun run -e' 校验 .github/workflows/*.yml / tsconfig.json. 大多数 config_error 是缩进或逗号.",
      why: "config_error 中 ~60% 是纯语法, 不需要 LLM 推理.",
    },
    {
      title: "对照 schema 文档",
      command_or_action:
        "GitHub Actions / Vercel / Netlify 等都有官方 schema, 用 read 工具看错误段对应的 schema 章节.",
      why: "猜测配置字段名几乎一定错; 必须查文档.",
    },
  ],
  flaky: [
    {
      title: "重跑 3 次确认是否 flaky",
      command_or_action:
        "在 CI UI 上点 'Re-run failed jobs' 3 次, 如果有 ≥ 1 次成功 = flaky 信号充分.",
      why: "flaky 不能靠看单次 log 确定, 必须重跑取证.",
    },
    {
      title: "查找 hasRetryMarkers 来源",
      command_or_action:
        "log 中 'retry N' 标记可能是 testing-library / vitest --retry 自带 retry. 用 grep 'retry' src/ 找显式 retry 配置.",
      why: "区分自动 retry 配置 vs 真 flaky, 处理路径不同.",
    },
    {
      title: "建议加 retry 配置 (而不是改测试)",
      command_or_action:
        "如果是网络/时间相关 flaky (database / network / timing), 建议 vitest.config 加 'retry: 2'; 不要在测试里加 sleep.",
      why: "RL-001 守护: flaky 不应该用 'sleep + 期望' 来掩盖, 用 retry 配置更可观测.",
    },
  ],
  timeout: [
    {
      title: "查找 timeout 段落",
      command_or_action:
        "在 log 里找 'timed out' / 'timeout' / 'killed', 看哪一步耗时最长. CI 默认 timeout 6h, 单 job 超 30 分钟 = 真问题.",
      why: "timeout 50% 是死循环, 50% 是网络/资源限制, 必须先定位.",
    },
    {
      title: "比对历史 job 时长",
      command_or_action:
        "用 gh / GitHub API 查最近 5 次 同 job 的耗时, 看是不是渐进式劣化 (=配置问题) 还是突然超时 (=代码 bug).",
      why: "区分代码引入 vs 环境问题, 是不是同 PR 的责任.",
    },
  ],
  unknown: [
    {
      title: "建议人介入",
      command_or_action:
        "无法识别失败分类 (信号不足或未知 runner). 建议把 log 完整复制到 issue, 让人工判断.",
      why: "RL-007 不编造问题: 不知道就说不知道, 不要硬猜分类.",
    },
  ],
};

export function generateFixSuggestions(input: FixTemplateInput): FixTemplateResult {
  const cls = input.classify.class;
  const max = Math.max(1, input.maxSuggestions ?? 3);
  const baseConfidence = Math.max(0, input.classify.confidence - 0.1);
  const refs = (input.parsed?.fileRefs ?? [])
    .slice(0, 5)
    .map((r: FileRef) => `${r.file}${r.line ? `:${r.line}` : ""}`);

  const baseSuggestions = (TEMPLATES[cls] ?? TEMPLATES.unknown).slice(0, max).map((tpl, idx) => ({
    ...tpl,
    // 第 1 条最高 confidence, 后续梯度降低
    confidence: parseFloat((baseConfidence - idx * 0.08).toFixed(2)),
    references: refs,
  }));

  // 当 candidate_alternatives 存在时, 把 top alternative 的第一条也加进来 (让 LLM 看到次选可能)
  const alts = input.classify.candidate_alternatives ?? [];
  if (alts.length > 0 && baseSuggestions.length < max) {
    const altCls = alts[0].class;
    const altTpl = (TEMPLATES[altCls] ?? [])[0];
    if (altTpl) {
      baseSuggestions.push({
        ...altTpl,
        title: `[备选: ${altCls}] ${altTpl.title}`,
        confidence: parseFloat((alts[0].confidence - 0.15).toFixed(2)),
        references: refs,
      });
    }
  }

  const allLow = baseSuggestions.every((s) => s.confidence < 0.5);
  return {
    class: cls,
    suggestions: baseSuggestions,
    escalation: allLow
      ? "所有候选方案 confidence < 0.5, 建议人工介入: 把 CI log 完整段落贴回 PR 或 issue, 让 maintainer 判断."
      : null,
  };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      file: { type: "string", short: "f" },
      "max-suggestions": { type: "string" },
      "parsed-file": { type: "string" },
    },
    allowPositionals: false,
  });

  let jsonText: string;
  if (values.file) {
    jsonText = readFileSync(values.file, "utf-8");
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    jsonText = Buffer.concat(chunks).toString("utf-8");
  }

  const classify: ClassifyResult = JSON.parse(jsonText);
  const parsed: ParsedCILog | undefined = values["parsed-file"]
    ? JSON.parse(readFileSync(values["parsed-file"], "utf-8"))
    : undefined;
  const max = values["max-suggestions"] ? parseInt(values["max-suggestions"], 10) : 3;

  const result = generateFixSuggestions({ classify, parsed, maxSuggestions: max });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
