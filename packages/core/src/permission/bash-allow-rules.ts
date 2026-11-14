/**
 * 「始终允许」的规则生成：把一条复合命令归一成一组 allow 规则（B9 / PR-5）。
 *
 * ## 为什么需要它
 *
 * 旧行为：会话级「本会话始终允许」的记忆键是 `bash:<整条命令>`（`checker.getMemoryKey`），
 * 持久化写 `Bash(<整条命令>)`（`app.persistBashAllowRule`）。复合命令换个参数就失效——
 * `cd <ws> && bun test a.test.ts | tail -30` 点过「始终允许」之后，
 * `cd <ws> && bun test b.test.ts | head` 仍然要再点一次。用户最终干脆不点这一项。
 *
 * CC 的做法（permissions.md:230）是按**每个需要批准的子命令**各存一条规则、最多 5 条：
 * `git status && npm test` 只存 `npm test *`，下次无论 `&&` 前面是什么都能命中。
 * 本模块就是这条归一的纯函数实现，IO 与「写会话 / 写盘」由调用方决定。
 *
 * ## 边界（每条都是「宁可少放行」的方向）
 *
 * 1. **免确认段不生成规则**：只读段、首段 `cd <dir>`、管道下游纯过滤器。它们本来就不需要
 *    批准（`checker.checkAllowList` 已有对应豁免），写进规则只会让会话里多出噪音条目。
 * 2. **解释器 / shell / 包装器只给精确规则**：`python3 *` 等于放行本机任意脚本，
 *    语义上不是「这条命令」的前缀。名单见 {@link INTERPRETER_LIKE_RE}。
 * 3. **无法用规则语法表达的段退回整条精确规则**：`Bash(pattern)` 的 pattern 里
 *    `)` 会让 `rules.ts` 的 `\(([^)]+)\)` 提前截断（规则静默失效），`*` 会被当通配
 *    （精确规则变成更宽的匹配）。含这些字符的命令一律 `fallback: "unrepresentable"`，
 *    调用方退回会话记忆（等价旧行为），不生成失真的规则。
 * 4. **超过上限退回整条精确规则**：CC 也是最多 5 条。
 * 5. **危险确认只给整条精确规则**：`fallback: "dangerous"`，且调用方只应写进会话
 *    （`isSafetyConfirmation` 的语义是「这次人工确认过」，不是「以后这类都放行」）。
 *
 * 纯函数、无 IO、无进程状态，便于单测。
 */

import { isReadOnlyCommand } from "../tool/bash/read-only-validation.ts";
import { splitShellWords } from "../tool/bash/parser.ts";
import { isPipelineFilterStage, parseLiteralCdTarget } from "./allow-composition.ts";
import { splitCommandStructure } from "./shell-structure.ts";

/** 复合命令一次最多生成多少条规则（对齐 CC：最多 5 条） */
export const MAX_BASH_ALLOW_RULES = 5;

/**
 * 多子命令 CLI：规则取「程序名 + 第一个非选项参数 + ` *`」。
 *
 * 判据是「第一个位置参数决定动作、后续位置参数只是它的对象」：
 * `git log --oneline -40` → `Bash(git log *)`，`bun test a.test.ts` → `Bash(bun test *)`。
 * 名单外的程序只取「程序名 + ` *`」（`curl *`、`rsync *`）。
 * `npx` 不在此列——它会执行任意包，按解释器处理。
 */
const MULTI_SUBCOMMAND_CLIS = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "gh",
  "docker",
  "docker-compose",
  "cargo",
  "go",
  "make",
  "kubectl",
  "brew",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "mvn",
  "gradle",
  "dotnet",
]);

/**
 * 解释器 / shell / 包装器：程序名之后跟的是**代码或另一条命令**，前缀规则等于放行任意代码。
 *
 * `python*` 用正则是因为版本号无限（`python3.12`）。`time` / `nice` / `nohup` / `timeout`
 * 是「包一层再执行」的包装器，与 `env` / `sudo` / `xargs` 同类。
 */
const INTERPRETER_LIKE_RE =
  /^(python[0-9.]*|node|nodejs|deno|ruby|perl|php|bash|sh|zsh|dash|ksh|fish|ash|mksh|npx|eval|exec|source|\.|xargs|env|sudo|doas|time|nice|nohup|timeout)$/;

/** `find` 在这几个选项后面接的是另一条命令（CC 的「find 操作无法通过前缀规则批准」） */
const FIND_EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/**
 * 规则 syntax 无法表达的字符。
 *
 * - `)`：`rules.ts:108` 用 `\(([^)]+)\)` 解析参数，`Bash(echo $(date))` 整条匹配失败，
 *   规则静默失效（比不生效更糟：用户以为已经放行）。
 * - `*`：精确规则里的 `*` 会被 `matchShellRulePattern` 当通配，`Bash(ls *.ts)` 会
 *   放行 `ls a.ts` —— 比用户批准的范围宽。
 */
const UNREPRESENTABLE_RE = /[)*]/;

/** 前导变量赋值 `NAME=value`（前缀规则没法表达「换了值也算同一条」） */
const LEADING_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** 规则退化的原因（生成前缀规则时为 undefined） */
export type BashAllowRuleFallback =
  /** 危险确认：只给整条精确规则，调用方只应写进会话 */
  | "dangerous"
  /** 生成的规则数超过上限：退回整条精确规则 */
  | "too-many"
  /** 命令里有规则语法无法表达的字符（`(` / `)` / `*`） */
  | "unrepresentable"
  /** 没有任何需要批准的子命令（全是只读 / cd / 管道过滤器） */
  | "nothing-to-ask";

export interface BashAllowRulePlan {
  /** 规则列表（`Bash(...)` 形态，已去重、保持出现顺序） */
  rules: string[];
  /** 退化原因；正常生成前缀规则时为 undefined */
  fallback?: BashAllowRuleFallback;
  /** 被跳过的免确认段（仅供确认框文案与测试断言） */
  skipped: string[];
}

/**
 * 生成「始终允许」要写入的 allow 规则。
 *
 * @param command 用户刚批准的那条完整命令
 * @param opts.dangerous 是否属于危险确认（`isSafetyConfirmation` 为真）。
 *   为真时只返回整条精确规则，`fallback: "dangerous"`。
 * @param opts.maxRules 上限，默认 {@link MAX_BASH_ALLOW_RULES}
 */
export function buildBashAllowRules(
  command: string,
  opts: { dangerous?: boolean; maxRules?: number } = {},
): BashAllowRulePlan {
  const trimmed = command.trim();
  if (!trimmed) return { rules: [], fallback: "nothing-to-ask", skipped: [] };

  // 危险确认：只记这一条命令本身（且调用方只写会话）。不拆、不加前缀。
  if (opts.dangerous) {
    return UNREPRESENTABLE_RE.test(trimmed)
      ? { rules: [], fallback: "unrepresentable", skipped: [] }
      : { rules: [toRule(trimmed)], fallback: "dangerous", skipped: [] };
  }

  const maxRules = opts.maxRules ?? MAX_BASH_ALLOW_RULES;
  const skipped: string[] = [];
  const patterns: string[] = [];

  for (const pipeline of splitCommandStructure(trimmed)) {
    const stages = pipeline.stages;
    for (let s = 0; s < stages.length; s++) {
      const stage = stages[s];
      // 首段 `cd <dir>`：切目录本身不需要批准，放行面由 checkAllowList 的
      // isSafeLeadingCd 决定（它还会校验目标在工作区内）。这里不为 cd 生成规则。
      if (s === 0 && parseLiteralCdTarget(stage) !== null) {
        skipped.push(stage);
        continue;
      }
      // 管道下游纯过滤器（`| tail -30`）：只读 stdin、无文件操作数、无写重定向。
      if (s > 0 && isPipelineFilterStage(stage)) {
        skipped.push(stage);
        continue;
      }
      // 本来就免确认的只读段
      if (isReadOnlyCommand(stage)) {
        skipped.push(stage);
        continue;
      }
      const pattern = describeStagePattern(stage);
      if (pattern === null) {
        // 某一段无法用规则表达 → 整条退回精确（调用方落会话记忆），不生成半套规则：
        // 半套规则会让「用户批准的命令」与「实际放行的范围」不一致。
        return { rules: [], fallback: "unrepresentable", skipped };
      }
      if (!patterns.includes(pattern)) patterns.push(pattern);
    }
  }

  if (patterns.length === 0) return { rules: [], fallback: "nothing-to-ask", skipped };
  if (patterns.length > maxRules) {
    return { rules: [toRule(trimmed)], fallback: "too-many", skipped };
  }
  return { rules: patterns.map(toRule), skipped };
}

/**
 * 单段的规则 pattern（`Bash(...)` 括号内的部分）。
 *
 * 返回 `null` 表示这一段**无法用规则表达**，调用方必须整条退回（见文件头边界 3）。
 */
function describeStagePattern(stage: string): string | null {
  const trimmed = stage.trim();
  if (!trimmed || UNREPRESENTABLE_RE.test(trimmed)) return null;

  const tokens = splitShellWords(trimmed);
  const program = tokens[0];
  if (!program) return null;

  // 程序名不是字面量（`$CMD`、`${x}`、反引号…）：没法写前缀
  if (!/^[A-Za-z0-9_@%+=:,./~-]+$/.test(program)) return exactPattern(trimmed);
  // 前导变量赋值 `FOO=1 cmd`：前缀规则表达不了「值任意」，精确记这一条
  if (LEADING_ASSIGNMENT_RE.test(program)) return exactPattern(trimmed);

  const base = program.includes("/") ? program.slice(program.lastIndexOf("/") + 1) : program;

  // 解释器 / shell / 包装器：程序名之后是代码，只给精确规则
  if (INTERPRETER_LIKE_RE.test(base)) return exactPattern(trimmed);

  // `find … -exec …`：命令位置在选项后面
  if (base === "find" && tokens.some((t) => FIND_EXEC_FLAGS.has(t))) {
    return exactPattern(trimmed);
  }

  // `bun -e` / `bun run <文件>` / `bun --print`：bun 在这几种形态下是解释器
  if (base === "bun") {
    if (tokens.some((t) => t === "-e" || t === "--eval" || t === "-p" || t === "--print")) {
      return exactPattern(trimmed);
    }
    if (tokens[1] === "run") return exactPattern(trimmed);
  }

  if (MULTI_SUBCOMMAND_CLIS.has(base)) {
    const firstArg = firstPositionalArg(tokens);
    // 第一个位置参数是路径 / 赋值（`git -C /repo log` 里的 `/repo`）→ 说不清动作是什么，
    // 精确记这一条，不猜。
    if (firstArg && !firstArg.includes("/") && !firstArg.includes("=")) {
      return `${program} ${firstArg} *`;
    }
    return exactPattern(trimmed);
  }

  return `${program} *`;
}

/** 段原文作为精确规则（`matchShellRulePattern` 对无通配符走精确全串匹配） */
function exactPattern(stage: string): string {
  return stage;
}

/** tokens[1..] 里第一个不以 `-` 开头的参数 */
function firstPositionalArg(tokens: string[]): string | undefined {
  return tokens.slice(1).find((t) => !t.startsWith("-") && t !== "");
}

/** pattern → 写进 settings / addSessionRule 的规则串 */
function toRule(pattern: string): string {
  return `Bash(${pattern})`;
}
