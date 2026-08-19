/**
 * CLI 完整入口（Stage 2）
 * 由 bootstrap.ts 动态导入，负责完整的参数解析、初始化和路由
 */

// ⚠️ 启动性能打点必须在所有其他 import 之前
import { profileCheckpoint } from "@sid-code/shared/utils/startup-profiler.ts";
profileCheckpoint("full_cli_entry");

// 强制启用终端颜色（必须在业务 import 之前）
if (!process.env.FORCE_COLOR && !process.env.NO_COLOR) {
  process.env.FORCE_COLOR = "3";
}

import { parseArgs } from "node:util";
import { loadConfig, isMissingApiKey, PLACEHOLDER_API_KEY } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { initLogger, getLogger, LogLevel, getPerfTimer } from "@sid-code/core/debug/index.ts";
import { clearFileIntent } from "@sid-code/core/session/file-intent.ts";
import { printHelp } from "./help.ts";
import { runMigrations } from "@sid-code/core/migrations/runner.ts";
import { getVersion } from "@sid-code/shared/version.ts";
import { isAbortError } from "@sid-code/core/llm/errors.ts";
import { EFFORT_LEVELS, isEffortLevel } from "@sid-code/core/llm/effort.ts";
import {
  LANGUAGE_PREFS,
  normalizeLanguagePref,
  resolveLanguageFromEnv,
} from "@sid-code/core/config/prompt-lang.ts";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

profileCheckpoint("full_cli_imports_loaded");

/** CLI 参数扩展类型 */
type CLIArgs = Partial<Config> & {
  prompt?: string;
  "list-sessions"?: boolean;
  "browse-sessions"?: boolean;
  "delete-session"?: string;
  "cleanup-sessions"?: boolean;
  "upload-traces"?: boolean;
  /** --json-schema 指向的文件路径，后续解析为 config.jsonSchema */
  jsonSchemaFile?: string;
  /** Bridge 远程控制：中继 WebSocket URL（ws:// 或 wss://） */
  bridgeUrl?: string;
  /** Bridge 远程控制：认证令牌 */
  bridgeToken?: string;
  /** --worktree [name]：启动时自动创建并进入 worktree（缺省值表示自动命名） */
  worktree?: string | boolean;
  /**
   * `-r` / `--resume` 不带值 → 打开交互式会话选择器（对标 CC）。
   * 带值时走 config.resume（ID / 索引 / 搜索词），此标志为 false。
   */
  resumePicker?: boolean;
  /** P2-G9：--from-pr <number>——从 PR 恢复会话上下文（PR 编号字符串）。 */
  fromPr?: string;
  /**
   * T-3.2：隐藏出口 --dump-tools——把**实际注册进 registry** 的工具定义
   * （`toolToDefinition()` 结果，与发给 LLM 的定义同源）以 JSON 输出后退出。
   * 供 `scripts/docs-gen-reference.ts` 生成 `website/ref/tools.md`——文档走"运行时自省"
   * 而非静态解析源码文本（设计见 §4.5.2 机制二）。刻意不写进 --help：它是给生成器用的
   * 内部出口，不是用户功能（对账测试里以 HIDDEN_FLAGS 显式登记豁免）。
   */
  dumpTools?: boolean;
};

/**
 * 解析 TUI 渲染模式（alt-screen 全屏 / 主屏），**同时给出判定依据**。
 *
 * 优先级（高 → 低）：
 *   1. `--inline`            → false（逃生舱，最高优先级）
 *   2. `--alternate-buffer`  → true （显式覆盖自动回退）
 *   3. TERM_PROGRAM === "Apple_Terminal" → false（自动回退，见下）
 *   4. 其余                  → undefined（交由 config 默认值，当前为 true）
 *
 * 为什么 Apple_Terminal 要自动回退：Terminal.app 在 alt screen 下对 SGR 1006 鼠标
 * 追踪兼容性差，滚轮/触控板滚不动；主屏模式靠终端原生 scrollback 滚动，任何终端都支持。
 *
 * ## 为什么要单独抽成函数并返回 reason（2026-08-04 排查教训）
 *
 * 原实现是内联的四层三元表达式，只算出值、不留依据。于是排查 TUI 刷屏问题时卡在
 * 一个本可秒答的问题上：同事确认"我用的就是 Terminal.app"，但按预期该走主屏模式的
 * 会话依然复现报错 —— 而**没有任何手段能验证这次判定到底是 true 还是 false、依据是什么**
 * （TERM_PROGRAM 可能被 tmux/screen 改写或清空，`--alternate-buffer` 可能藏在 alias 里）。
 * 整轮排查因此建立在一个未经验证的前提上。
 *
 * 返回 reason 后，`--debug` 会打出一行「本次 alternateBuffer=X，依据=Y」，用户可自证；
 * 这个价值独立于本次 bug 的最终归因是否正确。
 */
export function resolveAlternateBufferDecision(env: {
  inline: boolean;
  alternateBufferFlag: boolean;
  termProgram: string | undefined;
}): {
  /** 传给 config 的值；undefined = 不覆盖，走 config 默认 */
  value: boolean | undefined;
  /** 人类可读的判定依据（写进日志用） */
  reason: string;
} {
  if (env.inline) {
    return { value: false, reason: "CLI --inline（显式强制主屏模式）" };
  }
  if (env.alternateBufferFlag) {
    return { value: true, reason: "CLI --alternate-buffer（显式强制 alt-screen）" };
  }
  if (env.termProgram === "Apple_Terminal") {
    return {
      value: false,
      reason:
        'TERM_PROGRAM="Apple_Terminal" 自动回退主屏（其 alt-screen 鼠标追踪兼容性差；可用 --alternate-buffer 覆盖）',
    };
  }
  return {
    value: undefined,
    reason: `未指定，走配置默认值（TERM_PROGRAM=${env.termProgram ?? "<未设置>"}）`,
  };
}

/**
 * 校验 UUID v4 格式（--session-id 用）。CC 要求 --session-id 必须是合法 UUID。
 * 宽松匹配 8-4-4-4-12 十六进制形态（不强制 version/variant 位，兼容外部编排生成的 uuid）。
 */
export function isValidUUID(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/**
 * 预扫描 argv 抽取 `-r` / `--resume`，对齐 claude-code 的 `[value]` 可选值语义。
 *
 * 背景：Node/Bun 的 `parseArgs` 里 `type: "string"` 的选项**强制要求带值**，
 * 于是 `sid-code -r` 单独出现就报 `Option '-r, --resume <value>' argument missing`。
 * CC 的声明是 `-r, --resume [value]`（值可选）：不带值开交互选择器，带值按 ID 恢复
 * 或当搜索词。这里手动解析出三态，并把相关 token 从 argv 剔除，交给 parseArgs 处理其余选项。
 *
 * 三态：
 *   - 未出现            → { present: false }
 *   - 出现但不带值      → { present: true, picker: true }        （开选择器）
 *   - 出现且带值        → { present: true, value: "<v>" }        （ID / 索引 / 搜索词）
 *
 * 「带值」判定：`-r foo` / `--resume foo` / `--resume=foo` / `-r=foo` / `-rfoo`。
 * 若 `-r` 后紧跟的是另一个选项（以 `-` 开头）则视为不带值——与 CC 一致。
 */
export function extractResumeArg(argv: string[]): {
  present: boolean;
  picker: boolean;
  value?: string;
  rest: string[];
} {
  const rest: string[] = [];
  let present = false;
  let picker = false;
  let value: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    // 形如 --resume=foo / -r=foo
    if (token.startsWith("--resume=")) {
      present = true;
      value = token.slice("--resume=".length);
      continue;
    }
    if (token.startsWith("-r=")) {
      present = true;
      value = token.slice("-r=".length);
      continue;
    }

    // 形如 -rfoo（短选项紧贴值，不含 = ）
    if (token.length > 2 && token.startsWith("-r") && !token.startsWith("--")) {
      present = true;
      value = token.slice(2);
      continue;
    }

    // 形如 -r / --resume（值在下一个 token 或缺省）
    if (token === "-r" || token === "--resume") {
      present = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        value = next;
        i++; // 消费值 token，避免它掉进 positionals 变成提示词
      } else {
        picker = true; // 不带值 → 开选择器
      }
      continue;
    }

    rest.push(token);
  }

  // 带了值就不是 picker（picker 仅用于「显式无值」这一态）
  if (value !== undefined) picker = false;

  return { present, picker, value, rest };
}

/**
 * 归一 --allow-tool / --deny-tool 规则 flag（P2-1）。
 * parseArgs multiple:true 给出 string[]（未传为 undefined）；每项再按逗号拆分并去空。
 * 返回 undefined（未传）或去重后的规则数组。
 */
function normalizeRuleFlag(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  const items = Array.isArray(raw) ? raw : [raw];
  const rules = items
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  return rules.length > 0 ? Array.from(new Set(rules)) : undefined;
}

/** 解析命令行参数 */
function parseCLIArgs(): CLIArgs {
  let values: Record<string, any>;
  let positionals: string[];

  // 先摘掉 resume（可选值语义 parseArgs 表达不了），其余交给 parseArgs。
  const resumeArg = extractResumeArg(process.argv.slice(2));

  try {
    const result = parseArgs({
      args: resumeArg.rest,
      options: {
        // LLM 配置
        provider: { type: "string" },
        model: { type: "string", short: "m" },
        "max-tokens": { type: "string" },
        // 推理强度档位（P0-3）：low/medium/high/xhigh/max/auto。映射到 config.effortLevel。
        effort: { type: "string" },
        // 输出语言偏好：zh / en / auto / unset。映射到 config.language。
        // 无头模式（-p）此前只能改 settings.json（全局生效），无法单次调用指定语言。
        language: { type: "string" },
        // 主模型失败时的降级模型（P0-4）：映射到 config.fallbackModel，须在 availableModels 中存在。
        "fallback-model": { type: "string" },

        // 权限配置
        "permission-mode": { type: "string" },
        "dangerously-skip-permissions": { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        // 缺口 C1 §5.3：预授权工具白名单（守护进程无头 job 注入；逗号分隔）
        "allowed-tools": { type: "string" },
        "disallowed-tools": { type: "string" },
        // P2-1：CLI 权限规则（cliArg 源，规则语法如 "Bash(curl *)"；可多次传或逗号分隔）
        "allow-tool": { type: "string", multiple: true },
        "deny-tool": { type: "string", multiple: true },

        // 会话配置
        // 注意：resume（-r）不在此声明——它是可选值语义（`-r` 可不带值开选择器），
        // parseArgs 的 type:"string" 无法表达，已在 extractResumeArg 中预处理。
        continue: { type: "boolean", short: "c" },
        // 显式指定会话 UUID（P0-1）：SDK 幂等/外部编排复现。须合法 UUID；
        // 与 --continue/--resume 同用时必须带 --fork-session（组合约束在下方校验）。
        "session-id": { type: "string" },
        // 恢复会话时分叉出新 id 而非复用原 id（P0-2）：配合 --resume/--continue/--session-id。
        "fork-session": { type: "boolean" },
        // 禁用会话落盘（P1-2 会话控制）：本次会话不写持久化存储（SDK/一次性任务用）。
        "no-session-persistence": { type: "boolean" },
        // 从 PR 恢复会话上下文（P2-G9）：gh pr view <n> 拉取标题/描述/改动文件；
        // PR body 嵌了会话 id 则 resume 该会话，否则把 PR 上下文注入新会话。
        "from-pr": { type: "string" },
        "list-sessions": { type: "boolean" },
        "browse-sessions": { type: "boolean" },
        "delete-session": { type: "string" },
        "cleanup-sessions": { type: "boolean" },

        // 无头模式
        print: { type: "boolean", short: "p" },
        "output-format": { type: "string" },
        "max-turns": { type: "string" },
        verbose: { type: "boolean" },
        "json-schema": { type: "string" },

        // 系统提示词
        "system-prompt": { type: "string" },
        "append-system-prompt": { type: "string" },
        "system-prompt-file": { type: "string" },
        // 从文件读取内容追加到系统提示词（P1-4）：与 --append-system-prompt 合并。
        "append-system-prompt-file": { type: "string" },

        // 调试
        debug: { type: "boolean", short: "d" },
        "debug-level": { type: "string" },
        "debug-log-file": { type: "string" },

        // 帮助
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },

        // 插件
        "plugin-dir": { type: "string", multiple: true },

        // 轨迹采集
        trace: { type: "boolean" },
        "trace-upload-url": { type: "string" },
        "trace-upload-token": { type: "string" },
        "trace-user-id": { type: "string" },
        "trace-device-id": { type: "string" },
        "trace-upload-disabled": { type: "boolean" }, // 强制禁用上传（最高优先级，覆盖配置文件）
        "upload-traces": { type: "boolean" },

        // Bridge 远程控制（spec 16 §7）
        bridge: { type: "string" }, // 中继 WebSocket URL，提供即进入 Bridge 模式
        "bridge-token": { type: "string" },

        // UI 渲染（幽灵残留根治方案乙：默认全屏 alt-screen 有界视口）
        inline: { type: "boolean" }, // 逃生舱：回退旧主屏 Static 内联模式（原生文本选择/终端 scrollback；不支持 alt-screen 的终端用）
        "alternate-buffer": { type: "boolean" }, // 兼容保留：显式开全屏 alt-screen（现已是默认，此 flag 仅为不破坏旧脚本）

        // Worktree 隔离（P1-2）：启动时直接进入 worktree
        worktree: { type: "string" }, // --worktree[=name]；不带值时自动命名

        // 目录授权（P1-1）：追加额外可访问目录（可重复）。映射到 config.allowedDirectories。
        "add-dir": { type: "string", multiple: true },
        // 花费上限美元（P1-9）：映射到 config.costLimit，超限终止。
        "max-budget-usd": { type: "string" },
        // IDE 自动连接（A-4 子集）：等价于 SID_CODE_AUTO_CONNECT_IDE=true / config.ide.autoConnect。
        ide: { type: "boolean" },
        // 禁用所有斜杠命令（P1-8）：headless/受限场景下关闭 / 命令入口。
        "disable-slash-commands": { type: "boolean" },
        // 会话显示名（P2-5）：映射到会话元数据 title/name，便于 --list-sessions 辨识。
        name: { type: "string", short: "n" },

        // 配置源（P1-5 / P1-6）
        settings: { type: "string" }, // 额外 settings 源：文件路径或内联 JSON
        "setting-sources": { type: "string" }, // 逗号分隔子集：user/project/local

        // MCP 配置源（P1-7）
        "mcp-config": { type: "string", multiple: true }, // 文件路径或内联 JSON，可重复
        "strict-mcp-config": { type: "boolean" }, // 仅用 --mcp-config，忽略其它来源

        // Beta 头（P2-3）
        betas: { type: "string", multiple: true }, // anthropic-beta 头值，可重复或逗号分隔

        // 工具白名单替换整个内置集（P2-6）
        tools: { type: "string" }, // 逗号分隔；替换而非叠加

        // 子代理注入（P1-10）
        agents: { type: "string" }, // 内联 JSON：{name:{description,prompt,tools?,model?}}
        agent: { type: "string" }, // 顶层子代理人格名

        // SDK 输入/输出格式（P2-1 / P2-2）
        "input-format": { type: "string" }, // text（默认）/ stream-json
        "include-partial-messages": { type: "boolean" }, // stream-json 输出含部分增量

        // 文档生成出口（T-3.2，隐藏：刻意不进 --help）
        "dump-tools": { type: "boolean" }, // 输出实际注册的工具定义 JSON 后退出
      },
      allowPositionals: true,
      allowNegative: true,
    });
    values = result.values;
    positionals = result.positionals;
  } catch (err: any) {
    const match = err.message?.match(/Unknown option '([^']+)'/);
    if (match) {
      console.error(`错误: 未知选项 '${match[1]}'，使用 --help 查看可用选项`);
    } else {
      console.error(`错误: ${err.message}\n使用 --help 查看可用选项`);
    }
    process.exit(1);
  }

  // 处理帮助和版本（兜底：bootstrap 未拦截时仍能处理）
  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (values.version) {
    console.log(getVersion());
    process.exit(0);
  }

  // ── flag 值校验与组合约束（对齐 claude-code main.tsx 的启动期校验）──

  // effort 档位（P0-3）：合法档位或 auto/unset。非法值报错退出。
  let effortLevel: Config["effortLevel"] | undefined;
  if (values.effort !== undefined) {
    const raw = String(values.effort).trim().toLowerCase();
    if (raw === "auto" || raw === "unset") {
      // auto：不显式设档（保持 undefined，运行时跟随模型默认）
      effortLevel = undefined;
    } else if (isEffortLevel(raw)) {
      effortLevel = raw as Config["effortLevel"];
    } else {
      console.error(
        `错误: --effort 无效档位 "${values.effort}"，可选: ${EFFORT_LEVELS.join(" / ")} / auto`,
      );
      process.exit(1);
    }
  }

  // session-id（P0-1）：UUID 校验 + 组合约束。
  if (values["session-id"] !== undefined) {
    if (!isValidUUID(String(values["session-id"]))) {
      console.error(
        `错误: --session-id 必须是合法 UUID（形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx），收到: "${values["session-id"]}"`,
      );
      process.exit(1);
    }
    // 组合约束：--session-id 与 --continue/--resume 同用时必须带 --fork-session。
    const resumingExisting = values.continue === true || resumeArg.present;
    if (resumingExisting && values["fork-session"] !== true) {
      console.error(
        "错误: --session-id 与 --continue/--resume 同用时必须同时指定 --fork-session（否则无法确定是复用还是分叉会话）。",
      );
      process.exit(1);
    }
  }

  // 输出语言偏好：zh / en / auto（或 unset 回退默认）。非法值报错退出。
  //
  // 显式传参写错必须**报错**而非静默忽略：用户敲了 `--language jp` 却拿到中文输出，
  // 会以为"这个参数没用"。环境变量走另一条路（静默忽略）——残留的 env 不该打断启动。
  let languagePref: Config["language"] | undefined;
  let languageExplicitlyUnset = false;
  if (values.language !== undefined) {
    const raw = String(values.language).trim().toLowerCase();
    if (raw === "unset" || raw === "default" || raw === "none") {
      // 显式回退默认：不设值（缺省即中文优先）。用 languageExplicitlyUnset 记住
      // "用户显式表达了要默认"，避免下面被 env 的旧值重新填上。
      languagePref = undefined;
      languageExplicitlyUnset = true;
    } else {
      const norm = normalizeLanguagePref(raw);
      if (!norm) {
        console.error(
          `错误: --language 无效值 "${values.language}"，可选: ${LANGUAGE_PREFS.join(" / ")} / unset`,
        );
        process.exit(1);
      }
      languagePref = norm;
    }
  }

  // input-format（P2-1）：仅 text / stream-json。
  let inputFormat: Config["inputFormat"] | undefined;
  if (values["input-format"] !== undefined) {
    const raw = String(values["input-format"]).trim().toLowerCase();
    if (raw === "text" || raw === "stream-json") {
      inputFormat = raw as Config["inputFormat"];
    } else {
      console.error(
        `错误: --input-format 无效值 "${values["input-format"]}"，可选: text / stream-json`,
      );
      process.exit(1);
    }
  }

  // 组合约束（P2-1 / P2-2，对齐 CC main.tsx:1825/1850）——SDK 流式输入/部分消息依赖 stream-json 输出通道：
  //   ① --input-format=stream-json 要求 --output-format=stream-json（双向流式必须成对；
  //      否则 stdin 逐条消息读进来了，回包却走 text/json 单次输出，SDK 对端无法解析）。
  //   ② --include-partial-messages 要求 --print + --output-format=stream-json（部分增量只在
  //      无头 stream-json 输出路径上有意义；交互 TUI 自己就在渲染增量，重复开启无益）。
  const outFmt = values["output-format"];
  if (inputFormat === "stream-json" && outFmt !== "stream-json") {
    console.error(
      "错误: --input-format stream-json 需要同时指定 --output-format stream-json（双向流式必须成对）。",
    );
    process.exit(1);
  }
  if (values["include-partial-messages"] === true) {
    if (values.print !== true || outFmt !== "stream-json") {
      console.error(
        "错误: --include-partial-messages 需要同时指定 --print 与 --output-format stream-json。",
      );
      process.exit(1);
    }
  }

  // setting-sources（P1-6）：逗号分隔子集 user/project/local。
  let settingSources: Config["settingSources"] | undefined;
  if (values["setting-sources"] !== undefined) {
    const parts = String(values["setting-sources"])
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const valid = new Set(["user", "project", "local"]);
    const bad = parts.filter((p) => !valid.has(p));
    if (bad.length > 0) {
      console.error(
        `错误: --setting-sources 含无效源 "${bad.join(", ")}"，可选: user / project / local`,
      );
      process.exit(1);
    }
    settingSources = parts as Config["settingSources"];
  }

  // max-budget-usd（P1-9）：正数。
  let costLimit: number | undefined;
  if (values["max-budget-usd"] !== undefined) {
    const n = Number(values["max-budget-usd"]);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`错误: --max-budget-usd 必须是正数，收到: "${values["max-budget-usd"]}"`);
      process.exit(1);
    }
    costLimit = n;
  }

  // append-system-prompt-file（P1-4）：读文件内容，与 --append-system-prompt 合并。
  let appendSystemPrompt: string | undefined = values["append-system-prompt"];
  if (values["append-system-prompt-file"] !== undefined) {
    const filePath = String(values["append-system-prompt-file"]);
    try {
      const fileContent = readFileSync(resolvePath(filePath), "utf-8");
      appendSystemPrompt = appendSystemPrompt
        ? `${appendSystemPrompt}\n${fileContent}`
        : fileContent;
    } catch (err: any) {
      console.error(
        `错误: 无法读取 --append-system-prompt-file "${filePath}": ${err?.message ?? err}`,
      );
      process.exit(1);
    }
  }

  // agents（P1-10）：内联 JSON 解析。
  let injectedAgents: Config["injectedAgents"] | undefined;
  if (values.agents !== undefined) {
    try {
      const parsed = JSON.parse(String(values.agents));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("须为对象 { name: { prompt, ... } }");
      }
      // 逐项校验 prompt 必填。
      for (const [name, def] of Object.entries(parsed as Record<string, any>)) {
        if (
          !def ||
          typeof def !== "object" ||
          typeof def.prompt !== "string" ||
          !def.prompt.trim()
        ) {
          throw new Error(`子代理 "${name}" 缺少 prompt 字段`);
        }
      }
      injectedAgents = parsed as Config["injectedAgents"];
    } catch (err: any) {
      console.error(`错误: --agents JSON 解析失败: ${err?.message ?? err}`);
      process.exit(1);
    }
  }

  // 转换为 Config 格式
  const cliConfig: CLIArgs = {
    provider: values.provider,
    model: values.model,
    maxTokens: values["max-tokens"] ? parseInt(values["max-tokens"]) : undefined,
    permissionMode: values["permission-mode"],
    skipPermissions: values["dangerously-skip-permissions"],
    yesMode: values.yes,
    // 缺口 C1 §5.3：逗号分隔 → string[]（守护进程无头 job 预授权白名单）
    allowedTools: values["allowed-tools"]
      ? String(values["allowed-tools"])
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : undefined,
    disallowedTools: values["disallowed-tools"]
      ? String(values["disallowed-tools"])
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : undefined,
    // P2-1：--allow-tool / --deny-tool 为规则语法（cliArg 源）。multiple:true → string[]；
    // 每项再按逗号拆分，兼容 `--deny-tool "Bash(curl *),Read(.env)"` 与多次传参两种写法。
    cliAllowRules: normalizeRuleFlag(values["allow-tool"]),
    cliDenyRules: normalizeRuleFlag(values["deny-tool"]),
    continue: values.continue,
    // resume 已在 extractResumeArg 预解析：带值走 config.resume，无值走 resumePicker 开选择器。
    resume: resumeArg.value,
    resumePicker: resumeArg.picker,
    // P2-G9：从 PR 恢复（PR 编号）。在会话恢复分支前处理，命中会话 id 则转 resume。
    fromPr: values["from-pr"],
    print: values.print,
    outputFormat: values["output-format"],
    maxTurns: values["max-turns"] ? parseInt(values["max-turns"]) : undefined,
    verbose: values.verbose,
    jsonSchemaFile: values["json-schema"],
    systemPrompt: values["system-prompt"],
    // P1-4：合并了 --append-system-prompt 与 --append-system-prompt-file 的内容
    appendSystemPrompt: appendSystemPrompt,
    systemPromptFile: values["system-prompt-file"],
    debug: values.debug,
    debugLevel: values["debug-level"],
    debugLogFile: values["debug-log-file"],
    pluginDirs: values["plugin-dir"],
    "list-sessions": values["list-sessions"],
    "browse-sessions": values["browse-sessions"],
    "delete-session": values["delete-session"],
    "cleanup-sessions": values["cleanup-sessions"],
    "upload-traces": values["upload-traces"],
    // T-3.2：文档生成出口（隐藏 flag，见 CLIArgs.dumpTools 注释）
    dumpTools: values["dump-tools"],
    bridgeUrl: values.bridge,
    bridgeToken: values["bridge-token"],
    // Worktree 启动 flag（P1-2）：--worktree=name 指定名称；--worktree= 或空串则自动命名
    worktree: values.worktree !== undefined ? values.worktree || true : undefined,
    // UI 渲染模式（幽灵残留根治方案乙）：默认全屏 alt-screen 有界视口（config 默认 true）。
    // --inline 逃生舱强制回退旧主屏 Static（false，最高优先级）；--alternate-buffer 兼容保留（显式 true）；
    // 两者都不给 → undefined → 走 config 默认（true），但对 macOS Terminal.app 自动回退 false
    // （其 alt screen 下 SGR 1006 鼠标追踪兼容性差，滚轮/触控板滚不动；主屏模式靠终端原生
    // scrollback 滚动，任何终端都支持。用户可用 --alternate-buffer 显式覆盖此回退）。
    // 判定与理由由 resolveAlternateBuffer 统一给出（可观测性见该函数注释）。
    alternateBuffer: resolveAlternateBufferDecision({
      inline: values["inline"] === true,
      alternateBufferFlag: values["alternate-buffer"] === true,
      termProgram: process.env.TERM_PROGRAM,
    }).value,
    // 轨迹采集配置。
    // 采集默认启用（--no-trace 关闭）。上传配置完全走配置文件（settings.json trace.upload 段），
    // CLI flag 仅作为覆盖手段——不在代码中硬编码 URL/token。
    // "是否上传 / 是否本地保留 / 上传后是否删除" 是独立开关，由配置文件各字段控制：
    //   trace.upload.url / token      → 是否上传（有配置才上传）
    //   trace.upload.auto_upload      → 会话结束自动上传还是手动
    //   trace.upload.delete_after_upload → 上传成功后是否删本地（默认 false = 保留）
    // --trace-upload-disabled 可强制关闭上传（最高优先级，覆盖配置文件）。
    //
    // 关键：仅当用户通过 CLI flag 显式指定 trace 相关参数时才构造 trace 对象。
    // 否则不覆盖配置文件中的 trace 配置（避免浅合并把 settings.json 的完整 trace 吃掉）。
    trace:
      values.trace === false ||
      values["trace-upload-disabled"] ||
      values["trace-upload-url"] ||
      values["trace-upload-token"]
        ? {
            enabled: values.trace !== false,
            upload: values["trace-upload-disabled"]
              ? undefined // 强制禁用上传（最高优先级）
              : values["trace-upload-url"] || values["trace-upload-token"]
                ? {
                    url: values["trace-upload-url"],
                    token: values["trace-upload-token"],
                    userId: values["trace-user-id"],
                    deviceId: values["trace-device-id"],
                    toolSource: "sid-code",
                    autoUpload: true,
                    deleteAfterUpload: false,
                    compress: true,
                    maxRetries: 5,
                    retryBaseMs: 2000,
                  }
                : undefined,
          }
        : undefined, // 不覆盖——完全由配置文件（settings.json）决定

    // ── 对齐 claude-code 新增 flag（批次 1/2/4）──
    // P0-3 推理强度档位（已在上方校验为合法档位或 auto→undefined）。
    // 注意：mergeConfig 跳过 undefined，故 auto 态不会覆盖 settings.json 的 effortLevel；
    // 若需 CLI 显式压过 settings/env 的 auto 语义，由 app.ts 运行时初值处理。
    effortLevel: effortLevel,
    // 输出语言偏好（已校验）。优先级 --language > SID_LANGUAGE > settings.json > 缺省(zh)。
    //
    // mergeConfig 跳过 undefined，所以这里的三态要分清：
    //   ① 传了合法值 → languagePref 有值，压过 settings/env；
    //   ② 传了 unset  → languageExplicitlyUnset=true，此时**不能**回落 env，
    //      否则"我明确要默认"会被残留的 SID_LANGUAGE 顶掉（用户视角就是 unset 失灵）；
    //   ③ 没传       → 回落 env；env 也没有时留 undefined 交给 settings.json。
    language: languagePref ?? (languageExplicitlyUnset ? undefined : resolveLanguageFromEnv()),
    // P0-4 降级模型。
    fallbackModel: values["fallback-model"],
    // P0-1 显式会话 UUID（已校验格式 + 组合约束）。
    sessionId: values["session-id"],
    // P0-2 会话分叉。
    forkSession: values["fork-session"],
    // P1-2 禁用会话落盘。
    noSessionPersistence: values["no-session-persistence"],
    // P2-5 会话显示名。
    sessionName: values.name,
    // P1-1 追加授权目录（multiple → string[]）。
    allowedDirectories: values["add-dir"] as string[] | undefined,
    // P1-9 花费上限美元（已校验为正数）。
    costLimit: costLimit,
    // A-4 子集：--ide 显式开启 IDE 自动连接。
    ide: values.ide === true ? { autoConnect: true } : undefined,
    // P1-8 禁用斜杠命令。
    disableSlashCommands: values["disable-slash-commands"],
    // P1-5 额外 settings 源（文件或内联 JSON）。
    extraSettings: values.settings,
    // P1-6 限定 settings 源（已校验子集）。
    settingSources: settingSources,
    // P1-7 额外 MCP 配置源 + 严格模式。
    mcpConfigSources: values["mcp-config"] as string[] | undefined,
    strictMcpConfig: values["strict-mcp-config"],
    // P2-3 额外 anthropic-beta 头值（multiple + 逗号分隔展开）。
    betas: values.betas
      ? (values.betas as string[]).flatMap((b) => b.split(",").map((s) => s.trim())).filter(Boolean)
      : undefined,
    // P2-6 工具白名单替换整个内置集（逗号分隔）。
    toolsWhitelist: values.tools
      ? String(values.tools)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    // P1-10 子代理注入（已解析校验）+ 顶层人格。
    injectedAgents: injectedAgents,
    topLevelAgent: values.agent,
    // P2-1 输入格式（已校验）。
    inputFormat: inputFormat,
    // P2-2 stream-json 输出含部分增量。
    includePartialMessages: values["include-partial-messages"],
  };

  // 位置参数作为初始提示词
  if (positionals.length > 0) {
    cliConfig.prompt = positionals.join(" ");
  }

  return cliConfig;
}

/**
 * 渲染交互式会话选择器，返回用户选中的会话 id；用户取消（Esc/q）返回 null。
 *
 * 对标 claude-code `-r` 的选择器：选中后**直接**把 id 交回调用方去恢复，
 * 而不是打印「请再敲一遍 --resume <id>」。selectAndExit 语义——一旦选中即卸载 TUI。
 *
 * @param opts.searchFirst        进入即搜索模式（CC 风格：一进来就是搜索框）
 * @param opts.initialSearchQuery 预填搜索词（`-r <term>` 未精确命中 ID 时带进来）
 */
async function runSessionPicker(
  config: Config,
  opts: { searchFirst?: boolean; initialSearchQuery?: string } = {},
): Promise<string | null> {
  const React = await import("react");
  const { default: render } = await import("@sid-code/tui-renderer/root.ts");
  const { SessionBrowser } = await import("./ui/SessionBrowser.tsx");
  const { sidPaths } = await import("@sid-code/core/config/paths.ts");
  const { consumeEarlyInput } = await import("./ui/early-input.ts");
  const { drainStdin } = await import("@sid-code/tui-renderer/ink.tsx");
  const { setSuppressTerminalProbe } = await import("@sid-code/tui-renderer/terminal.ts");
  const { resolveProjectRoot } = await import("@sid-code/core/memory/paths.ts");
  const { join } = await import("path");
  const { unlinkSync, existsSync } = await import("fs");

  // 当前项目根：与存储侧分目录归一算法一致（resolveProjectRoot = git top-level 优先，
  // 失败退回 resolve(cwd)）。传给选择器做 Ctrl+P「仅当前项目」筛选，保证过滤与物理目录对得上。
  const projectRoot = resolveProjectRoot(process.cwd());

  // 关键：bootstrap 阶段的早期输入捕获（early-input）在 stdin 上挂了 readable 监听，
  // 会把每个字节 read() 掉。若不先停掉它，选择器里 Ink 的 useInput 一个按键都收不到
  // ——表现为「方向键 / Enter / 输入全部无反应」。正常 TUI 由 InputArea 消费它，
  // 但选择器在 TUI 之前渲染，必须自己先停掉捕获，把 stdin 交还给 Ink。
  consumeEarlyInput();

  const sessionDir = sidPaths.sessions();

  let selectedId: string | null = null;
  let unmount: (() => void) | undefined;

  // 关键:选择器是短命 Ink 实例,卸载后会切到主 TUI。若它也发端末探查(XTVERSION),
  // 慢终端(VS Code xterm.js)的回复会在卸载后才到、经交接被拆碎漏进主 TUI 输入框
  // (`>|xterm.js(...)1;2c` 乱码)。这里抑制探查,只让主 TUI 探查——它解析器已接线,
  // 回复被正确消费。waitUntilExit 后在 finally 里解除,不影响主 TUI。
  setSuppressTerminalProbe(true);

  const instance = await render(
    React.createElement(SessionBrowser, {
      config,
      currentSessionId: config.sessionId,
      searchFirst: opts.searchFirst,
      initialSearchQuery: opts.initialSearchQuery,
      projectRoot,
      onResumeSession: (session: any) => {
        selectedId = session.id;
        unmount?.(); // 选中即卸载，waitUntilExit 随即 resolve
      },
      onDeleteSession: async (session: any) => {
        // P0-1：会话按项目分目录后，用条目自带的 dirPath 定位；回退到根目录兼容未迁移的平铺文件。
        const sessionPath = join(session.dirPath || sessionDir, session.fileName);
        if (existsSync(sessionPath)) {
          unlinkSync(sessionPath);
        }
      },
      onExit: () => {
        unmount?.(); // 取消：卸载但不设 selectedId
      },
    }),
  );
  unmount = instance.unmount;

  try {
    await instance.waitUntilExit();
  } finally {
    // 解除探查抑制:选择器已卸载,主 TUI 需要正常探查(它解析器已接线,回复不会拆碎)。
    setSuppressTerminalProbe(false);
  }

  // 兜底 drain:选择器不再发探查(已抑制),这里主要吸掉用户按 Enter 选中前后
  // 可能残留的按键字节,避免漏进主 TUI 输入框。等一小会儿让在途字节落地再 drain。
  await new Promise((r) => setTimeout(r, 30));
  try {
    drainStdin(process.stdin);
  } catch {
    /* stdin 可能已被销毁，忽略 */
  }

  return selectedId;
}

/** 处理浏览会话命令（--browse-sessions 独立入口，选中后打印恢复提示） */
async function handleBrowseSessions(config: Config): Promise<void> {
  const selectedId = await runSessionPicker(config);
  if (selectedId) {
    console.log(`已选择会话: ${selectedId}`);
    console.log(`使用 --resume ${selectedId} 恢复此会话`);
  }
}

/** 处理清理会话命令 */
async function handleCleanupSessions(config: Config): Promise<void> {
  const { cleanupExpiredSessions, getRetentionSettings } =
    await import("@sid-code/core/session/cleanup.ts");

  try {
    const retentionSettings = getRetentionSettings(config);
    console.log("开始清理过期会话...");
    console.log(`配置: maxAge=${retentionSettings.maxAge}, maxCount=${retentionSettings.maxCount}`);

    const result = await cleanupExpiredSessions(config, retentionSettings, config.sessionId);

    console.log(`\n清理完成:`);
    console.log(`  扫描: ${result.scanned} 个`);
    console.log(`  删除: ${result.deleted} 个`);
    console.log(`  跳过: ${result.skipped} 个`);
    console.log(`  失败: ${result.failed} 个`);

    if (result.deletedIds.length > 0) {
      console.log(`\n已删除会话 ID:`);
      for (const id of result.deletedIds) {
        console.log(`  - ${id}`);
      }
    }

    if (result.failedIds.length > 0) {
      console.log(`\n删除失败的会话 ID:`);
      for (const id of result.failedIds) {
        console.log(`  - ${id}`);
      }
    }
  } catch (error: any) {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  }
}

/** 处理手动触发重试队列补传 */
async function handleUploadTraces(config: Config): Promise<void> {
  const traceUpload = config.trace?.upload;
  if (!traceUpload?.url || !traceUpload?.token) {
    console.error(
      "错误: 未配置上传地址或 token，请在配置文件或通过 --trace-upload-url / --trace-upload-token 参数指定",
    );
    process.exit(1);
  }

  const { UploadManager } = await import("@sid-code/core/trace/uploader.ts");
  const { sidPaths } = await import("@sid-code/core/config/paths.ts");

  const outputDir = config.trace?.outputDir ?? sidPaths.trajectories();
  const mgr = new UploadManager({
    baseUrl: traceUpload.url,
    token: traceUpload.token,
    toolSource: traceUpload.toolSource,
    userId: traceUpload.userId,
    deviceId: traceUpload.deviceId,
    maxRetries: traceUpload.maxRetries,
    retryBaseMs: traceUpload.retryBaseMs,
    compress: traceUpload.compress,
    deleteAfterUpload: traceUpload.deleteAfterUpload ?? false,
    outputDir,
    // §6.4：手动补传队列时也据 events.jsonl 校正历史会话 cost=0
    availableModels: config.availableModels,
  });

  console.log("正在处理待上传队列...");
  try {
    await mgr.processRetryQueue();
    console.log("处理完成");
  } catch (err: any) {
    console.error(`处理失败: ${err.message}`);
    process.exit(1);
  }
}

// ─── 全局 App 弱引用（供 uncaughtException 等异常兜底使用）───

/** 全局 App 弱引用，供 emergencySessionEnd 在 uncaughtException 时调用 */
let lastAppRef: WeakRef<import("./app.ts").App> | null = null;

/** 注册当前 App 实例（由 main() 在 App 创建后调用） */
export function setLastApp(app: import("./app.ts").App): void {
  lastAppRef = new WeakRef(app);
}

/** 全局异常兜底处理器 */
function registerGlobalErrorHandlers(): void {
  process.on("unhandledRejection", (reason: unknown, _promise: Promise<unknown>) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    try {
      const { getLogger } = require("@sid-code/core/debug/logger.ts");
      getLogger().error("GLOBAL", `unhandledRejection: ${msg}`, { stack });
    } catch {
      /* logger 可能未初始化 */
    }

    // A5：abort 类拒绝 = 用户按 ESC / 超时主动中断，是可观测事件而非故障。
    // 对标 claude-code：abort 的 unhandledRejection 仅记录，不触发 emergencySessionEnd
    // （避免把会话错误标记为 error 并吃掉真正的 SessionEnd），更不退出进程。
    // 配合 anthropic.ts 已把 signal 下传 SDK（A1），abort 几乎不会再产生孤儿 Promise；
    // 此处为双保险——即使偶发，进程也保持存活。
    if (isAbortError(reason)) {
      return;
    }

    process.stderr.write(`[sid-code] unhandledRejection: ${msg}\n`);
    if (stack) process.stderr.write(`${stack}\n`);
    // 非 abort 的未处理拒绝：保留原有兜底（紧急 SessionEnd + 退出）
    const err = reason instanceof Error ? reason : new Error(String(reason));
    try {
      lastAppRef?.deref()?.emergencySessionEnd(err);
    } catch {
      /* ignore */
    }
    process.exit(1);
  });

  process.on("uncaughtException", (err: Error) => {
    try {
      const { getLogger } = require("@sid-code/core/debug/logger.ts");
      getLogger().error("GLOBAL", `uncaughtException: ${err.message}`, { stack: err.stack });
    } catch {
      /* logger 可能未初始化 */
    }

    // 与 unhandledRejection 对称：abort 类异常 = 用户/超时主动中断，不是真故障。
    // 多数 abort 走 unhandledRejection，但 setTimeout 回调内的 abort throw、
    // 无监听器的 EventEmitter error 等场景会以 uncaughtException 形式出现，
    // 携带裸 reason 字符串（如 "user-cancel"）。此前缺 isAbortError 短路 →
    // 这些路径仍会 process.exit(1) 崩溃。这里补齐，保持两个全局处理器一致。
    if (isAbortError(err)) {
      return;
    }

    process.stderr.write(`[sid-code] uncaughtException: ${err.message}\n`);
    if (err.stack) process.stderr.write(`${err.stack}\n`);
    // 紧急 SessionEnd（在 exit 前做最后一搏）
    try {
      lastAppRef?.deref()?.emergencySessionEnd(err);
    } catch {
      /* ignore */
    }
    // 强制退出（对标 claude-code forceExit）：
    // 终端已死时 process.exit() 可能抛 EIO，此时回退到 SIGKILL
    try {
      process.exit(1);
    } catch {
      // 生产环境：dead terminal → EIO → 回退 SIGKILL
      process.kill(process.pid, "SIGKILL");
    }
  });
}

/** 主函数（由 bootstrap.ts 调用） */
export async function main(): Promise<void> {
  registerGlobalErrorHandlers();
  const startupTimer = getPerfTimer().start("startup");

  try {
    const cliArgs = parseCLIArgs();

    // P1-5 / P1-6：在 loadConfig 之前注入 settings 源过滤与 --settings 覆盖源，
    // 使后续 loadConfigFile → getSettings 合并时即生效（settings 是 config 的上游数据源之一）。
    {
      const { setFlagSettings, setEnabledSettingSources } =
        await import("@sid-code/core/config/settings/index.ts");
      // --setting-sources：限定磁盘来源子集（flag/policy 始终保留）。
      setEnabledSettingSources(cliArgs.settingSources ?? null);
      // --settings：文件路径或内联 JSON，作为 flagSettings 内存源注入（优先级最高的磁盘外覆盖）。
      if (cliArgs.extraSettings) {
        const raw = String(cliArgs.extraSettings).trim();
        try {
          let json: any;
          if (raw.startsWith("{")) {
            json = JSON.parse(raw); // 内联 JSON
          } else {
            const content = readFileSync(resolvePath(raw), "utf-8"); // 文件路径
            json = JSON.parse(content);
          }
          setFlagSettings(json);
        } catch (err: any) {
          console.error(
            `错误: --settings 解析失败（应为文件路径或内联 JSON）: ${err?.message ?? err}`,
          );
          process.exit(1);
        }
      }
    }

    // 执行数据迁移（幂等，失败不阻塞）
    // P1-4：补兜底 try——runner.ts 内部已自兜（setStoredMigrationVersion 包了
    // try/catch），但调用方也加一层，确保任何逃逸都不阻断启动
    profileCheckpoint("migrations_start");
    try {
      runMigrations();
    } catch (err) {
      // 迁移幂等，下次启动重跑即可；此处不可阻塞启动
      getLogger().debug("MIGRATION", `数据迁移失败（不阻塞启动）: ${err}`);
    }
    profileCheckpoint("migrations_end");

    profileCheckpoint("config_load_start");
    const config = await loadConfig(cliArgs);
    profileCheckpoint("config_load_end");

    // ── 工作区信任门控（SEC-AUDIT-2026-07-19 P1）─────────────────────────────
    //
    // 位置极其关键：必须在**配置生效之前**。此前这段逻辑在 app.ts 的 doInit（行 ~2248），
    // 而那里已经太晚了——按 cli.ts 的真实时序：
    //   loadConfig(965) → MCP connectAll(1825) → new App(2011，构造器里初始化 hooks)
    //   → app.init() → doInit 的信任检查
    // 也就是说：**危险配置早就生效了**，信任检查跑在它们后面。当时那段代码不仅"交互模式
    // 自动 trust() 从不询问"，连注释里"非交互模式下危险配置不会被加载"也是假的——
    // TrustManager 的信任状态全仓**没有任何消费者**（只有 app.ts 读它，读完什么也不做）。
    // 这是典型的「后端已实现 + 前端 TODO + 状态无人消费」三重空转。
    //
    // 现在改为 fail-closed：未信任 → **当场从 config 里 strip 掉危险配置**，再把快照
    // 交给 TUI 弹对话框。用户确认信任后持久化，下次启动 isTrusted() 为真即完整加载。
    // 拒绝 → 本会话就是被 strip 后的降级配置在跑，不是"标记一下但照常加载"。
    if (!config.skipPermissions && !config.yesMode) {
      try {
        const { TrustManager, setPendingTrust } =
          await import("@sid-code/core/permission/trust.ts");
        const trustMgr = new TrustManager(process.cwd());
        const dangerousItems = await trustMgr.scanDangerousConfigs();
        if (dangerousItems.length > 0 && !(await trustMgr.isTrusted())) {
          const log = getLogger();
          // fail-closed：先摘掉危险配置，无论后续是否有 UI 来问
          const stripped: string[] = [];
          for (const item of dangerousItems) {
            // hooks / mcpServers 是**非可选**字段（默认 {}，见 config.ts:319-320、795-796），
            // 所以清空成 {} 而不是 delete——delete 会让下游 `Object.keys(config.hooks)`
            // 这类无防护访问炸在 undefined 上。env 是可选字段，delete 安全。
            if (item.type === "hooks" && Object.keys(config.hooks ?? {}).length > 0) {
              config.hooks = {};
              stripped.push("hooks");
            } else if (
              item.type === "mcp_servers" &&
              Object.keys(config.mcpServers ?? {}).length > 0
            ) {
              config.mcpServers = {};
              stripped.push("mcpServers");
            }
            // env_vars / bash_permissions 不在此 strip，各有原因：
            // - env_vars：Config 上**没有**顶层 env 字段（env 只存在于 MCPServerConfig
            //   内部，见 config.ts:36）。settings.json 的 env 段目前不会进 Config，
            //   摘 mcpServers 时其内嵌 env 已一并失效。仍在 items 里上报，让用户看到
            //   项目声明了环境变量这个事实。
            // - bash_permissions：权限规则由 rule-loader 的 SECURITY_SENSITIVE_FIELDS
            //   走独立通道过滤，在此重复删会连带破坏 user 级规则。
          }
          log.warn(
            "TRUST",
            `未信任工作区：已跳过 ${stripped.join(" / ") || "（无可摘项）"}，共 ${dangerousItems.length} 项危险配置待确认`,
          );

          const interactive =
            !config.print && !(config.maxTurns !== undefined && config.maxTurns > 0);
          if (interactive) {
            // 交互模式：登记快照，待 TUI 就绪后弹 TrustDialog（app.ts 消费）
            setPendingTrust({ items: dangerousItems, workspacePath: process.cwd() });
          } else {
            // 非交互（-p / maxTurns）：无处可问，保持 strip 后的降级配置继续跑。
            // 这才真正兑现了原注释声称的"危险配置不会被加载"。
            log.warn("TRUST", "非交互模式：不询问信任，危险配置保持未加载");
          }
        }
      } catch (err: any) {
        // 信任检查本身失败不阻断启动，但要留痕（fail-closed 的例外：扫描失败时
        // 不 strip，因为无法区分"没有危险配置"与"读取失败"，强行 strip 会误伤正常项目）
        getLogger().warn("TRUST", `工作区信任检查失败（不阻断启动）: ${err?.message ?? err}`);
      }
    }

    // P2-1 item5 + P2-2：实例化企业策略管理器，读 managed settings，
    // 把功能开关（policy-limits）与模式管控（mode-policy: disabledModes / disableBypassPermissionsMode）注入全局。
    try {
      const { PolicyManager } = await import("@sid-code/core/config/policy.ts");
      const policyManager = new PolicyManager();
      const policy = await policyManager.load();
      if (policy) {
        // 功能级开关
        if (policy.policyLimits) {
          const { setPolicyLimits } = await import("@sid-code/core/config/policy-limits.ts");
          setPolicyLimits(policy.policyLimits);
        }
        // 定制化来源锁定（strictPluginOnlyCustomization）：屏蔽用户/项目级自带 skill 等，
        // 只保留 managed/plugin/builtin。必须在扩展扫描之前注入。
        {
          const { setPluginOnlyPolicy } =
            await import("@sid-code/core/config/plugin-only-policy.ts");
          setPluginOnlyPolicy(policy.strictPluginOnlyCustomization);
        }
        // 模式级管控（P2-2）
        const { setModePolicy, isBypassDisabledByPolicy, isModeDisabledByPolicy } =
          await import("@sid-code/core/permission/mode-policy.ts");
        setModePolicy(policy.disabledModes, policy.disableBypassPermissionsMode);

        // P2-2 fail-fast：策略禁用 bypass 时，若 CLI 显式传了 bypass 相关 flag/mode，明确报错退出
        const cliWantsBypass =
          cliArgs.skipPermissions === true ||
          cliArgs.permissionMode === "dangerously-skip-permissions" ||
          cliArgs.permissionMode === "always-allow";
        if (isBypassDisabledByPolicy() && cliWantsBypass) {
          console.error(
            "错误: 企业策略（managed settings: disableBypassPermissionsMode=disable）已禁用 bypass 权限模式，" +
              "--dangerously-skip-permissions / --permission-mode always-allow 不可用。",
          );
          process.exit(1);
        }
        // 通用 disabledModes fail-fast：CLI 显式请求了被策略禁用的模式 → 报错退出
        if (cliArgs.permissionMode && isModeDisabledByPolicy(String(cliArgs.permissionMode))) {
          console.error(
            `错误: 企业策略已禁用权限模式 "${cliArgs.permissionMode}"（managed settings: disabledModes）。`,
          );
          process.exit(1);
        }
        // 降级：策略禁用 bypass 时，抹掉从其它来源（settings 文件等）渗入的 skip/bypass 态
        if (isBypassDisabledByPolicy()) {
          if (config.skipPermissions) config.skipPermissions = false;
          if (
            config.permissionMode === "dangerously-skip-permissions" ||
            config.permissionMode === "always-allow"
          ) {
            config.permissionMode = "default";
          }
        }
      }
    } catch (err) {
      // P2-8：initLogger 之前（此处在 :980 之前）的 warn 命中 stderr 兜底分支，
      // 无颜色泄漏终端且不写 audit.log——两头落空。用户看到"企业策略加载跳过"
      // 也无从处置，降级 debug 静默吞掉（enabled:false 兜底实例下 debug 直接 return）
      getLogger().debug("POLICY", `企业策略加载跳过: ${err}`);
    }

    // Coordinator 模式：检查环境变量 SID_CODE_COORDINATOR_MODE=1
    // 设为 coordinator 后主循环角色切换为"编排者"，注入编排工作流提示词
    const { checkCoordinatorEnv } = await import("@sid-code/core/coordinator/mode.ts");
    checkCoordinatorEnv();

    // 启动期管家：生成配置目录 .gitignore + 按水位线节流的过期清理（幂等、不阻塞）
    //
    // ⚠ 必须传 selfSessionId：清理会 rmSync 过期的 checkpoint 会话目录，而本会话自己的
    // registerSession() 在下面 :2212 才跑 —— 这中间本会话不在活跃注册表里。平时无害，
    // 但 `--resume` 一个 30 天前的旧会话时会把用户正要恢复的那个会话的 checkpoint 删掉。
    try {
      const { runStartupHousekeeping } =
        await import("@sid-code/core/config/startup-housekeeping.ts");
      runStartupHousekeeping(Date.now(), { selfSessionId: config.sessionId });
    } catch (err) {
      getLogger().debug("CONFIG", `启动管家任务跳过: ${err}`);
    }

    // Settings 系统：Phase 1 安全环境变量（信任边界之前，仅可信来源 + 安全白名单）
    // 旧 safe-env.ts 从未被调用——此处首次接入两阶段环境变量应用。
    try {
      const { applySafeConfigEnvironmentVariables } =
        await import("@sid-code/core/config/settings/managed-env.ts");
      applySafeConfigEnvironmentVariables();
    } catch (err) {
      // P2-8：initLogger 之前的 warn 命中 stderr 兜底分支，降级 debug 静默
      getLogger().debug("ENV", `Phase 1 环境变量应用跳过: ${err}`);
    }

    // AppConfig：加载内部应用状态 + 递增启动计数（write-through，后台 watchFile）
    try {
      const { getAppConfig, incrementStartupCount } =
        await import("@sid-code/core/config/app-config.ts");
      getAppConfig();
      incrementStartupCount();
    } catch (err) {
      // P2-8：initLogger 之前的 warn 命中 stderr 兜底分支，降级 debug 静默
      getLogger().debug("CONFIG", `AppConfig 初始化跳过: ${err}`);
    }

    // 注册会话级插件目录（--plugin-dir），必须在任何插件加载前设置
    if (config.pluginDirs && config.pluginDirs.length > 0) {
      const { setInlinePluginDirs } = await import("./plugin/index.ts");
      setInlinePluginDirs(config.pluginDirs);
    }

    // 初始化调试日志
    if (config.debug) {
      const levelMap: Record<string, LogLevel> = {
        ERROR: LogLevel.ERROR,
        WARN: LogLevel.WARN,
        INFO: LogLevel.INFO,
        DEBUG: LogLevel.DEBUG,
      };
      const level = levelMap[config.debugLevel?.toUpperCase() || "DEBUG"] ?? LogLevel.DEBUG;

      const isTUI = !config.print;
      const logger = initLogger({
        enabled: true,
        level,
        logFile: config.debugLogFile,
        console: !isTUI,
        fileOnly: isTUI,
        mutedCategories: ["UI:MD", "TUI:STATE", "TUI:RESIZE", "STREAM_WRITER"],
      });

      logger.info("CLI", "调试模式已启用", {
        level: LogLevel[level],
        logFile: logger.getLogFilePath(),
      });
      logger.configLoaded("CLI", config);
    } else if (config.audit !== false) {
      // 零配置审计日志：不开 --debug 也常驻留痕。
      // 只落 WARN/ERROR 关键事件（空参数退化、循环、压缩、孤儿修复、上传失败等），
      // 不输出控制台、不写 DEBUG/INFO 噪音，出问题必有现场。只写本地、不外传。
      // logger 自带 10MB 大小轮转 + 仅留 1 备份，磁盘安全。
      initLogger({
        enabled: true,
        level: LogLevel.WARN,
        logFile: config.auditLogFile ?? "~/.sid-code/audit.log",
        console: false,
        fileOnly: true,
        append: true,
      });
    }

    // TUI 渲染模式判定留痕（2026-08-04 排查教训，见 resolveAlternateBufferDecision 注释）。
    // 必须放在 logger 就绪之后：判定本身发生在 parseCLIArgs（logger 尚未初始化），
    // 此处重算一次拿 reason 落日志。重算是纯函数、无副作用，不存在与实际生效值漂移的风险。
    // 走 info 级（不是 debug）：这条线的**唯一用途**就是"让用户开 --debug 后能自证
    // 本次判定"，而 debug 级会被 --debug-level INFO/WARN 静默丢掉——实测 level=INFO
    // 时这行直接消失，等于诊断手段在最需要它的时候失效。一次进程启动只打一行，
    // 量极小；且与紧邻的 fullscreen.ts `ink 实例已创建（X 模式）`（同为 TUI:RENDER
    // 的 info）保持一致：那条给出「值」，这条补上「依据」。
    // 未开 --debug 时走 audit 配置（level=WARN），本行不落盘，不污染 audit.log。
    {
      const decision = resolveAlternateBufferDecision({
        inline: process.argv.includes("--inline"),
        alternateBufferFlag: process.argv.includes("--alternate-buffer"),
        termProgram: process.env.TERM_PROGRAM,
      });
      getLogger().info(
        "TUI:RENDER",
        `渲染模式判定: alternateBuffer=${config.alternateBuffer}（CLI 层判定=${decision.value ?? "未覆盖"}，依据=${decision.reason}）`,
        {
          TERM_PROGRAM: process.env.TERM_PROGRAM ?? "<未设置>",
          TERM: process.env.TERM ?? "<未设置>",
          TMUX: process.env.TMUX ? "<在 tmux 中>" : "<不在 tmux>",
          最终生效值: config.alternateBuffer,
        },
      );
    }

    // logger 就绪后，统一输出配置校验诊断（loadConfig 阶段暂存的）。
    // warnings 走 debug（--debug 才显示明细，不刷首屏）；非致命 errors 走 warn（真信号该可见）。
    // 致命错误已在 loadConfig 内提前抛出，不会走到这里。
    if (config._validationDiagnostics) {
      const diag = config._validationDiagnostics;
      const logger = getLogger();
      if (diag.warnings.length > 0) {
        logger.debug("CONFIG", `配置有 ${diag.warnings.length} 条提示:`);
        for (const w of diag.warnings) {
          logger.debug("CONFIG", `  ⚠ ${w.path}: ${w.message}`);
        }
      }
      if (diag.errors.length > 0) {
        logger.warn("CONFIG", `配置验证发现 ${diag.errors.length} 个非致命错误:`);
        for (const e of diag.errors) {
          logger.warn("CONFIG", `  ✗ ${e.path}: ${e.message}`);
        }
      }
    }

    // P2-3 --betas：把用户指定的 anthropic-beta 头值注册为 sticky（会话期恒携带）。
    // 复用 G7 beta-header-latch 机制：只增不减，避免中途抖动废掉 prompt cache。放在 logger 就绪后。
    if (config.betas && config.betas.length > 0) {
      const { stickyBetaHeader } = await import("@sid-code/core/api/beta-header-latch.ts");
      for (const b of config.betas) {
        if (b && b.trim()) stickyBetaHeader(b.trim());
      }
      getLogger().info("LLM", `已注册 ${config.betas.length} 个 --betas anthropic-beta 头值。`);
    }

    // headless(--print) 模式：诊断默认可见（不依赖 --debug），有问题才输出、无问题零输出；
    // 固定走 stderr，不碰 stdout（--output-format json/stream-json 靠 stdout 输出结构化数据）。
    // 门控在 config.print 上，天然排除 TUI —— Ink 接管终端前的裸 console 输出会在正式渲染
    // 上方留下游离行（同一原因，恢复会话提示此前已从 console.log 改为 logger）。
    if (config.print && config._validationDiagnostics) {
      const diag = config._validationDiagnostics;
      const total = diag.warnings.length + diag.errors.length;
      if (total > 0) {
        console.error(
          `配置检查发现 ${total} 项提示（不影响本次启动，可能导致部分功能未按预期工作）:`,
        );
        for (const e of diag.errors) {
          console.error(`  ✗ [错误] ${e.path}: ${e.message}`);
        }
        for (const w of diag.warnings) {
          console.error(`  ⚠ [提示] ${w.path}: ${w.message}`);
        }
        const logPath = config.debug
          ? config.debugLogFile
          : (config.auditLogFile ?? "~/.sid-code/audit.log");
        console.error(`详情见 ${logPath}`);
      }
    }

    // 处理会话管理命令（不需要 API Key）
    if (cliArgs["list-sessions"]) {
      const { handleListSessions } = await import("@sid-code/core/session/commands.ts");
      await handleListSessions();
      return;
    }
    if (cliArgs["browse-sessions"]) {
      await handleBrowseSessions(config);
      return;
    }
    if (cliArgs["delete-session"]) {
      const { handleDeleteSession } = await import("@sid-code/core/session/commands.ts");
      await handleDeleteSession(cliArgs["delete-session"]);
      return;
    }
    if (cliArgs["cleanup-sessions"]) {
      await handleCleanupSessions(config);
      return;
    }

    // 手动触发重试队列（补传之前失败的上传）
    if (cliArgs["upload-traces"]) {
      await handleUploadTraces(config);
      return;
    }

    // 验证 API Key。
    // - headless（print）模式：缺 key 无法交互，按原样报错退出（文案指向配置位置）。
    // - TUI 模式：缺 key 不退出，标记 _needsOnboarding，进界面后由 OnboardingDialog 引导。
    //   （config.ts loadConfig 已处理"完全空配置"分支；此处覆盖"provider 有值但缺 key"。）
    // isMissingApiKey：空 / 纯空白 / 团队模板占位符 __YOUR_API_KEY__ 都算"未配置"。
    // 占位符是非空字符串，若只判空会漏过——新用户首次安装拿到的正是占位符，不识别就会撞 401。
    const usingPlaceholder =
      (config.provider === "anthropic" && config.anthropicKey?.trim() === PLACEHOLDER_API_KEY) ||
      (config.provider === "openai" && config.openaiKey?.trim() === PLACEHOLDER_API_KEY);
    const missingKey =
      (config.provider === "anthropic" && isMissingApiKey(config.anthropicKey)) ||
      (config.provider === "openai" && isMissingApiKey(config.openaiKey));
    if (missingKey) {
      if (config.print) {
        const keyName = config.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
        const hint = usingPlaceholder
          ? `检测到 API Key 仍是安装模板占位符 ${PLACEHOLDER_API_KEY}，尚未替换为真实密钥。\n`
          : `未配置 ${keyName}。\n`;
        console.error(
          `错误: ${hint}` +
            `请在 ~/.sid-code/settings.json 配置 availableModels[].api_key，或设置环境变量 ${keyName}。`,
        );
        process.exit(1);
      }
      config._needsOnboarding = true;
    }

    // Settings 系统：Phase 2 全量环境变量（信任边界之后）+ 启动文件变更监听。
    // 当前无独立信任对话框 UI，以"通过 API Key 校验、确定在此项目运行"为信任边界。
    if (!config.print) {
      try {
        const { applyAllConfigEnvironmentVariables } =
          await import("@sid-code/core/config/settings/managed-env.ts");
        applyAllConfigEnvironmentVariables();

        const { initializeChangeDetector } =
          await import("@sid-code/core/config/settings/change-detector.ts");
        const { getSettingsFilePaths } =
          await import("@sid-code/core/config/settings/constants.ts");
        initializeChangeDetector(getSettingsFilePaths());
      } catch (err) {
        getLogger().warn("SETTINGS", `Phase 2 / 变更监听初始化跳过: ${err}`);
      }
    }

    profileCheckpoint("init_start");

    // 创建 ProviderRegistry（Provider 工厂 + 缓存 + 子代理模型映射）
    const { ProviderRegistry } = await import("@sid-code/core/llm/registry.ts");
    // _needsOnboarding 时 provider 可能为空，给兜底名使 registry 可构造占位 Provider
    // （registry 仅对未知 provider 名 throw；空 model/key 构造 OpenAIProvider 无碍）。
    // 该 Provider 永不实际发起 LLM 调用（TUI 弹 OnboardingDialog 收集配置前不进查询循环）。
    if (config._needsOnboarding && !config.provider) {
      config.provider = "openai";
    }
    const providerRegistry = new ProviderRegistry(config, config.subAgentModels);
    let provider: import("@sid-code/core/llm/provider.ts").Provider;
    try {
      provider = providerRegistry.getProvider();
    } catch (err: any) {
      if (config._needsOnboarding) {
        // 兜底：构造失败也不退出，创建一个最简 OpenAI Provider 占位
        const { OpenAIProvider } = await import("@sid-code/core/llm/openai.ts");
        provider = new OpenAIProvider("", config.model || "placeholder");
      } else {
        console.error(`创建 Provider 失败: ${err.message}`);
        process.exit(1);
      }
    }

    // 记录 Provider 信息
    if (config.debug) {
      const { getLogger } = await import("@sid-code/core/debug/logger.ts");
      getLogger().info(
        "CONFIG",
        `Provider: ${config.provider} model=${config.model} baseURL=${config.baseURL || "(默认)"}`,
      );
    }

    // 注册内置工具（共享 FileReadTracker 实例）
    profileCheckpoint("tool_reg_start");
    const { Registry: ToolRegistry } = await import("@sid-code/core/tool/registry.ts");
    const { FileReadTracker } = await import("@sid-code/core/tool/file-read-tracker.ts");
    const { MemoryStore } = await import("@sid-code/core/memory/store.ts");
    const toolRegistry = new ToolRegistry();
    // P0-2：延迟加载豁免名单（高频工具强制首轮可见，省每会话 tool_search 往返）。
    // 在注册任何工具前设置即可——isToolDeferred 每次调用时实时读该名单。
    toolRegistry.setKeepLoaded(config.toolSearchKeepLoaded);
    const fileReadTracker = new FileReadTracker();
    // 设置会话上下文（用于并发冲突检测）
    fileReadTracker.applySessionContext({
      sessionId: config.sessionId,
      pid: process.pid,
      cwd: process.cwd(),
    });
    // Phase 2.4：冲突检测配置
    fileReadTracker.conflictDetection = config.conflictDetection ?? true; // 默认启用
    const VALID_SEVERITY = ["warn", "block", "off"] as const;
    const rawSeverity = config.conflictSeverity;
    if (rawSeverity && !VALID_SEVERITY.includes(rawSeverity as any)) {
      const { getLogger } = await import("@sid-code/core/debug/logger.ts");
      getLogger().warn("CONFIG", `conflictSeverity 非法值 "${rawSeverity}"，已回退 warn`);
      fileReadTracker.conflictSeverity = "warn";
    } else {
      fileReadTracker.conflictSeverity = (rawSeverity as any) ?? "warn"; // 默认弹框
    }
    const memoryStore = new MemoryStore(process.cwd());

    const { BashTool } = await import("@sid-code/core/tool/bash.ts");
    const { GrepTool } = await import("@sid-code/core/tool/grep.ts");
    const { GlobTool } = await import("@sid-code/core/tool/glob.ts");
    const { LsTool } = await import("@sid-code/core/tool/ls.ts");
    const { WebFetchTool } = await import("@sid-code/core/tool/web-fetch.ts");
    const { MemoryTool } = await import("@sid-code/core/tool/memory.ts");
    const { createStatefulTools } = await import("@sid-code/core/tool/stateful-tools.ts");

    // 有状态工具（read/edit/read_many/write）经工厂用同一 tracker 构造，
    // 与子代理隔离路径（sub-agent.ts）共用工厂，避免构造逻辑漂移。
    // write 已并入工厂（与 edit 共享 tracker 做先读后写 + 写后回写），不再单独注册。
    for (const t of createStatefulTools(fileReadTracker)) toolRegistry.register(t);
    toolRegistry.register(new BashTool());
    toolRegistry.register(new GrepTool());
    // G21：glob/ls 需接权限 deny 规则做列举过滤，但 permissionChecker 此刻尚未创建，
    // 先留引用，待 checker 就绪后 setPathHiddenFilter 后置注入（见下方权限检查器创建处）。
    const globTool = new GlobTool();
    const lsTool = new LsTool();
    toolRegistry.register(globTool);
    toolRegistry.register(lsTool);
    toolRegistry.register(new WebFetchTool());
    toolRegistry.register(new MemoryTool(memoryStore));

    // 注册 LSP 代码智能查询工具（goToDefinition/findReferences/hover/documentSymbol 等 9 操作）。
    // isEnabled 自动检测：LSP 初始化成功/进行中才进上下文，无配置时不暴露给模型（零配置体验）。
    const { LSPTool } = await import("@sid-code/core/tool/lsp.ts");
    toolRegistry.register(new LSPTool());

    // 注册 web_search 工具（始终可用，DuckDuckGo 兜底）
    const { createSearchBackend } = await import("@sid-code/core/tool/search-backends/factory.ts");
    const { WebSearchTool } = await import("@sid-code/core/tool/web-search.ts");
    const searchBackend = createSearchBackend(config.search);
    toolRegistry.register(new WebSearchTool(searchBackend));

    // 创建 Plan Mode 管理器 + 注册 Plan Mode 工具
    const { PlanModeManager } = await import("@sid-code/core/plan/state.ts");
    const { EnterPlanModeTool } = await import("@sid-code/core/tool/enter-plan-mode.ts");
    const { ExitPlanModeTool } = await import("@sid-code/core/tool/exit-plan-mode.ts");
    const planManager = new PlanModeManager();
    toolRegistry.register(new EnterPlanModeTool(planManager));
    toolRegistry.register(new ExitPlanModeTool(planManager));

    // 注册 TodoWrite 工具（执行阶段进度追踪，防 Plan Mode 套娃）
    const { TodoWriteTool } = await import("@sid-code/core/tool/todo-write.ts");
    toolRegistry.register(new TodoWriteTool());

    // 注册结构化提问工具（对标 cc AskUserQuestion）：模型遇关键岔路口时向用户抛
    // 选择题、收集决策。alwaysLoad 首轮常驻可见（内置流程如 /commit 刚需，避免模型
    // 没看到 schema 就凭记忆猜参数盲调）；TUI 模式弹交互对话框，headless 模式自动
    // 降级为"无法提问"提示（见 ask-user-question-bridge.ts）。
    const { AskUserQuestionTool } = await import("@sid-code/core/tool/ask-user-question.ts");
    toolRegistry.register(new AskUserQuestionTool());

    // G11：注册 NotebookEdit 工具（cell 级 .ipynb 编辑，与 Read 的 notebook 支持配套）。
    // shouldDefer，由 tool_search 按需调出——多数会话不涉及 notebook。
    const { NotebookEditTool } = await import("@sid-code/core/tool/notebook-edit.ts");
    toolRegistry.register(new NotebookEditTool());

    // G19：注册 think 工具——全仓首个用新泛型 buildTool() 定义、经 toLegacyTool() bridge
    // 适配到产线 registry 的工具，验证新接口 → bridge → registry 链路真实可用。
    const { createThinkTool } = await import("@sid-code/core/tool/think.ts");
    toolRegistry.register(createThinkTool());

    // 注册假设登记表工具（环节③：把"怀疑自己的假设"从模型自律外化为 harness 机制）。
    // register 工具持有 ledger，challenge 工具复用同一实例；turnProvider 暂用占位（轮次仅用于
    // 证据追溯，非关键路径）。queryLoop 经 deps.getHypothesisLedger 读取做矛盾中断 + 交付门禁。
    // 2026-08-01：整段受 isHypothesisEnabled() gate 保护，**默认关闭**，
    // 需 SID_ENABLE_HYPOTHESIS=1 显式开启。依据是受控 A/B：ON/OFF 准确率同为 5.00/5，
    // 而 ON 多花 +75% input、+61% 墙钟（详见 hypothesis-ledger.ts 的开关注释）。
    // 不注册工具时 deps.getHypothesisLedger 也拿不到 ledger，矛盾中断/交付门禁一并静默。
    const { isHypothesisEnabled } = await import("@sid-code/core/query/hypothesis-ledger.ts");
    if (isHypothesisEnabled()) {
      const { HypothesisRegisterTool, HypothesisChallengeTool } =
        await import("@sid-code/core/tool/hypothesis.ts");
      const hypothesisRegisterTool = new HypothesisRegisterTool();
      toolRegistry.register(hypothesisRegisterTool);
      toolRegistry.register(new HypothesisChallengeTool(hypothesisRegisterTool.getLedger()));
    }

    // 注册子代理工具
    const { SubAgentTool } = await import("@sid-code/core/agent/tool.ts");
    toolRegistry.register(new SubAgentTool(providerRegistry, toolRegistry));

    // 注册工具搜索工具（延迟加载机制的调出入口，alwaysLoad 强制首轮可见）
    const { ToolSearchTool } = await import("@sid-code/core/tool/tool-search.ts");
    const toolSearchTool = new ToolSearchTool(toolRegistry);
    toolRegistry.register(toolSearchTool);

    // 注册后台任务工具（运行态 shell/agent/workflow：bg_task_get/bg_task_list/task_output/task_stop）
    const { TaskOutputTool } = await import("@sid-code/core/tool/task-output.ts");
    const { TaskStopTool } = await import("@sid-code/core/tool/task-stop.ts");
    const { TaskListTool } = await import("@sid-code/core/tool/task-list.ts");
    const { TaskGetTool } = await import("@sid-code/core/tool/task-get.ts");
    const { SendMessageTool } = await import("@sid-code/core/tool/send-message.ts");
    toolRegistry.register(new TaskOutputTool());
    toolRegistry.register(new TaskStopTool());
    toolRegistry.register(new TaskListTool());
    toolRegistry.register(new TaskGetTool());
    toolRegistry.register(new SendMessageTool(providerRegistry, toolRegistry));

    // 注册结构化任务清单工具（带依赖/owner 的持久化 TODO：task_create/task_update/task_get/task_list）
    // 对标 claude-code TaskCreate/TaskUpdate/TaskGet/TaskList，服务多 agent 派活。
    const { TaskCreateTool } = await import("@sid-code/core/tool/structured-task-create.ts");
    const { TaskUpdateTool } = await import("@sid-code/core/tool/structured-task-update.ts");
    const { StructuredTaskGetTool } = await import("@sid-code/core/tool/structured-task-get.ts");
    const { StructuredTaskListTool } = await import("@sid-code/core/tool/structured-task-list.ts");
    toolRegistry.register(new TaskCreateTool());
    toolRegistry.register(new TaskUpdateTool());
    toolRegistry.register(new StructuredTaskGetTool());
    toolRegistry.register(new StructuredTaskListTool());

    // 注册 Worktree 隔离工具（D27: 仅在 git 仓库或配置了 WorktreeCreate/Remove hook 时注册）
    {
      const { findGitRoot } = await import("@sid-code/core/worktree/manager.ts");
      const { hasWorktreeCreateHook, hasWorktreeRemoveHook } =
        await import("@sid-code/core/worktree/hooks.ts");
      const gitRoot = findGitRoot(process.cwd());
      if (gitRoot || hasWorktreeCreateHook() || hasWorktreeRemoveHook()) {
        const { EnterWorktreeTool } = await import("@sid-code/core/tool/enter-worktree.ts");
        const { ExitWorktreeTool } = await import("@sid-code/core/tool/exit-worktree.ts");
        toolRegistry.register(new EnterWorktreeTool());
        toolRegistry.register(new ExitWorktreeTool());
      }
    }

    // 注册 Cron 调度工具
    const { CronCreateTool } = await import("@sid-code/core/tool/cron-create.ts");
    const { CronDeleteTool } = await import("@sid-code/core/tool/cron-delete.ts");
    const { CronListTool } = await import("@sid-code/core/tool/cron-list.ts");
    const { ScheduleWakeupTool } = await import("@sid-code/core/tool/schedule-wakeup.ts");
    toolRegistry.register(new CronCreateTool());
    toolRegistry.register(new CronDeleteTool());
    toolRegistry.register(new CronListTool());
    toolRegistry.register(new ScheduleWakeupTool());

    // 注册 Swarm 多代理协作工具
    const { TeamCreateTool } = await import("@sid-code/core/tool/team-create.ts");
    toolRegistry.register(new TeamCreateTool(providerRegistry, toolRegistry));
    // P1-3：团队成员之间/成员→leader 的消息投递（mailbox 写入口，补齐双向通信）。
    // 主代理调用会明确报错（不在团队上下文），只有团队成员执行链里可用。
    const { TeamMessageTool } = await import("@sid-code/core/tool/team-message.ts");
    toolRegistry.register(new TeamMessageTool());

    // 注册 Dynamic Workflows 编排工具(延迟工具,由 tool_search 在多 agent 编排场景按需调出)
    const { WorkflowTool } = await import("@sid-code/core/tool/workflow.ts");
    toolRegistry.register(new WorkflowTool(providerRegistry, toolRegistry));

    // 注册内置命令
    const { Registry: CommandRegistry } = await import("./command/registry.ts");
    const { registerBuiltins } = await import("./command/builtins.ts");
    const commandRegistry = new CommandRegistry();
    await registerBuiltins(commandRegistry);

    // 注：Bundled Skills（/commit /review 等）不再桥接进旧 Registry。
    // 它们由新命令体系（UnifiedCommandRegistry → loadSkillCommands → loadBundledSkills）
    // 原生加载，App 的 TUI 命令获取/执行走新体系。旧 Registry 仅作回退路径。

    // 加载自定义命令（带信任检查）
    const { CustomCommandLoader } = await import("./command/custom.ts");
    const { TrustManager } = await import("@sid-code/core/extension/trust.ts");
    const trustManager = new TrustManager();
    const scanOptions = {
      trustManager,
      trustProjectExtensions: config.trustProjectExtensions,
      onUntrusted: async (files: any[]) => {
        if (config.print) return [];
        const log = getLogger();
        log.warn("TRUST", `发现 ${files.length} 个未信任的项目级扩展，已自动信任`);
        return files;
      },
      // additional 层（对齐 CC）：--add-dir 授权的目录，其 .sid-code/{type}/ 与
      // .claude/{type}/ 下的 skills/commands/agents 一并加载。此前 --add-dir 只影响
      // 文件访问白名单，授权目录自带的 skill 加载不进来。
      additionalDirs: config.allowedDirectories,
    };
    const customCmds = await new CustomCommandLoader().loadAll(undefined, scanOptions);
    for (const { cmd, source } of customCmds) commandRegistry.register(cmd, source);

    // 加载 Skills（通过 SkillManager 统一管理）
    const { SkillManager } = await import("@sid-code/core/skill/manager.ts");
    const { SkillMetaTool } = await import("@sid-code/core/skill/meta-tool.ts");
    const { SkillCommand } = await import("./command/skill-command.ts");
    const skillManager = new SkillManager();
    await skillManager.discover(process.cwd(), scanOptions);

    if (config.disabledSkills && config.disabledSkills.length > 0) {
      skillManager.setDisabledSkills(config.disabledSkills);
    }

    // P0-1：单一 Skill 元工具（对齐 CC）。此前每个 skill 一个 skill__<name> 工具导致工具池膨胀
    // + 与摘要 listing 信息重复。改为全局唯一 `Skill` 工具按名分发，工具数不随 skill 增长。
    // 权限规则/hookSystem/permissionChecker 由 app.ts 的 wireTool* setter 回填。
    // permissionRules 在下方（checker 构造处）才加载，故此处只注册工具，
    // 权限规则/hookSystem/permissionChecker 统一由 app.ts 的 wireTool* setter 回填。
    const skillMetaTool = new SkillMetaTool(skillManager, providerRegistry, toolRegistry);
    toolRegistry.register(skillMetaTool);

    const skills = skillManager.getSkills();
    for (const skill of skills) {
      // 用户调用路径：注册为斜杠命令 /skill-name（除非显式禁止用户调用）
      // 此前缺失此步骤,导致 /bug-fix 等 skill 命令报"未知命令"。
      if (skill.userInvocable !== false) {
        commandRegistry.register(new SkillCommand(skill), "user");
      }
    }

    // P1-2/P2-2/P3-2：Skill 运行时激活协调器。init() 延后到插件 skills 也加载完毕后调用
    // （下方插件块），以便条件激活门控覆盖插件 skill。
    const { SkillActivationCoordinator } =
      await import("@sid-code/core/skill/activation-coordinator.ts");
    const skillActivationCoordinator = new SkillActivationCoordinator({
      manager: skillManager,
      cwd: process.cwd(),
    });

    // Bundled Skill 模型调用路径（Gap 1）：把 fork 模式且未禁止模型调用的
    // Bundled Skill 注册为工具，使 LLM 可自动调用（与磁盘 Skill 的 Skill 元工具对等）。
    // inline 模式语义是注入主对话、不返回结果，不适合做工具，仅保留斜杠命令。
    // 带强副作用的 skill（commit-push-pr / pr-workflow / pr-comments）已在各自定义里
    // 设 disableModelInvocation:true，仅 review(只读) 暴露给模型。
    try {
      const { loadBundledSkills } = await import("@sid-code/core/skill/bundled/index.ts");
      const { BundledSkillTool } = await import("@sid-code/core/skill/bundled/tool.ts");
      for (const cmd of loadBundledSkills()) {
        if (cmd.type !== "prompt") continue;
        if (cmd.context !== "fork") continue; // inline 不可包装
        if (cmd.disableModelInvocation) continue;
        toolRegistry.register(new BundledSkillTool(cmd, providerRegistry, toolRegistry));
      }
    } catch (err: any) {
      getLogger().debug("SKILL", `Bundled Skill 工具注册失败: ${err?.message ?? String(err)}`);
    }

    // 加载自定义 Agents（P2-4：只注册进统一聚合 registry，通过 sub_agent({type}) 访问；
    // 不再包装为 agent__xxx 独立工具——收敛到 CC 式单通道，自定义 agent 自动获得
    // sub_agent 的 run_in_background/isolation/fork/并发信号量能力）。
    const { CustomAgentLoader } = await import("@sid-code/core/agent/custom.ts");
    const { registerDynamicAgents } = await import("@sid-code/core/agent/agent-definition.ts");
    const { setAgentColor } = await import("@sid-code/core/agent/color.ts");
    // P1-2：把 frontmatter 声明的 color 注册进颜色映射；非法色名 warn 跳过（回退哈希分配）。
    const registerAgentColor = (agentType: string, color: string | undefined) => {
      if (!color) return;
      if (!setAgentColor(agentType, color)) {
        getLogger().warn(
          "AGENT",
          `Agent "${agentType}" 的 color="${color}" 非法，已回退自动分配色`,
        );
      }
    };
    const customAgents = await new CustomAgentLoader().loadAll(undefined, scanOptions);
    // 注册进聚合 registry：让 sub_agent 的 type 枚举能发现自定义 agent
    if (customAgents.length > 0) {
      registerDynamicAgents(
        customAgents.map((def) => ({
          agentType: def.name,
          description: def.description,
          whenToUse: def.description,
          systemPrompt: def.prompt,
          tools: def.tools.length > 0 ? def.tools : undefined,
          source: "userSettings" as const,
          filePath: def.filePath,
          // P0-2/P1-1/P1-2/P2-1：透传扩展 frontmatter 字段到 AgentDefinition。
          model: def.model,
          skills: def.skills,
          color: def.color,
          permissionMode: def.permissionMode,
          hooks: def.hooks,
          background: def.background,
          isolation: def.isolation,
        })),
      );
      for (const def of customAgents) registerAgentColor(def.name, def.color);
    }

    // P1-10 --agents：注入 CLI 指定的子代理定义（内联 JSON）。
    // 注册进聚合 registry（使 sub_agent 可发现）+ 注册为 CustomAgentTool（使模型可直接调用）。
    // 优先级高于自定义/插件 agent（overwrite=true 默认），CLI 显式注入应压过磁盘来源。
    if (config.injectedAgents && Object.keys(config.injectedAgents).length > 0) {
      const injected = Object.entries(config.injectedAgents).map(([name, def]) => ({
        agentType: name,
        description: def.description ?? name,
        whenToUse: def.description ?? name,
        systemPrompt: def.prompt,
        tools: def.tools && def.tools.length > 0 ? def.tools : undefined,
        model: def.model,
        source: "userSettings" as const,
      }));
      registerDynamicAgents(injected);
      // P2-4：不再注册 agent__xxx 独立工具，注入的 agent 统一通过 sub_agent({type}) 访问。
      getLogger().info(
        "AGENT",
        `--agents 注入 ${injected.length} 个子代理: ${injected.map((a) => a.agentType).join(", ")}`,
      );
    }

    // 加载插件组件（命令 / Agent；Hooks 和 MCP 在下方各自的初始化点接入）
    let pluginMcpServers: Record<
      string,
      import("@sid-code/core/config/config.ts").MCPServerConfig
    > = {};
    try {
      const { mergePluginCommands, loadPluginAgents, collectPluginMcpServers } =
        await import("./plugin/index.ts");

      // 插件命令（带 pluginName: 前缀，与内置/自定义命令隔离）
      const pluginCmdCount = await mergePluginCommands(commandRegistry);

      // P0-4：插件 Skills（带 pluginName: 前缀）。注入同一 skillManager（元工具据此分发），
      // 并把 userInvocable 的注册为 /pluginName:skill 斜杠命令。
      try {
        const { getPluginSkills } = await import("./plugin/loadPluginSkills.ts");
        const pluginSkills = await getPluginSkills();
        if (pluginSkills.length > 0) {
          skillManager.addPluginSkills(pluginSkills);
          for (const skill of pluginSkills) {
            if (skill.userInvocable !== false) {
              commandRegistry.register(new SkillCommand(skill), "user");
            }
          }
        }
      } catch (err: any) {
        getLogger().warn("PLUGIN", `插件 Skills 加载失败: ${err?.message ?? String(err)}`);
      }

      // 插件 Agent（注册为工具 + 注册进聚合 registry，overwrite=false：优先级低于用户自定义）
      const pluginAgents = await loadPluginAgents();
      if (pluginAgents.length > 0) {
        registerDynamicAgents(
          pluginAgents.map((def) => ({
            agentType: def.name,
            description: def.description,
            whenToUse: def.description,
            systemPrompt: def.prompt,
            tools: def.tools.length > 0 ? def.tools : undefined,
            source: "plugin" as const,
            filePath: def.filePath,
            // P0-2/P1-1/P1-2/P2-1：透传扩展 frontmatter 字段到 AgentDefinition。
            model: def.model,
            skills: def.skills,
            color: def.color,
            permissionMode: def.permissionMode,
            hooks: def.hooks,
            background: def.background,
            isolation: def.isolation,
          })),
          false,
        );
        for (const def of pluginAgents) registerAgentColor(def.name, def.color);
      }
      // P2-4：不再注册 agent__xxx 独立工具，插件 agent 统一通过 sub_agent({type}) 访问。

      // 收集插件 MCP 服务器（合并到 config.mcpServers，下方统一连接）
      pluginMcpServers = await collectPluginMcpServers();

      if (
        pluginCmdCount > 0 ||
        pluginAgents.length > 0 ||
        Object.keys(pluginMcpServers).length > 0
      ) {
        getLogger().info(
          "PLUGIN",
          `插件组件: ${pluginCmdCount} 命令, ${pluginAgents.length} Agent, ${Object.keys(pluginMcpServers).length} MCP 服务器`,
        );
      }
    } catch (err: any) {
      getLogger().error("PLUGIN", `插件组件加载失败: ${err.message}`);
    }

    // P1-2/P2-2：插件 skills 也加载完毕后，用全量 skill 初始化激活协调器
    // （分离条件激活 skill 并 gate，未触发前不进模型 listing）。
    skillActivationCoordinator.init(skillManager.getAllSkills());

    profileCheckpoint("tool_reg_end");

    // T-3.2 --dump-tools：把实际注册进 registry 的工具定义以 JSON 输出后退出。
    //
    // 位置刻意选在这里（内置工具注册全部完成之后、--tools 白名单裁剪与 MCP 连接之前）：
    //   - 之前 → 会漏掉 Skill 元工具 / Bundled Skill 工具 / worktree 等后段注册的工具；
    //   - 之后 → 产物会随 --tools 裁剪与本机 MCP 服务器配置变化，生成的文档
    //     就不是"内置工具全集"而是"这台机器这次会话恰好可见的工具"，pre-commit
    //     的 --check 会在不同人机器上给出不同结论（§4.5.2 问题 A 要防的正是这个）。
    //
    // 取 definitions() 而非 all()：它就是发给 LLM 的那份定义（含 usageGuide 拼接与
    // zodSchema→JSON Schema 转换），文档因此与模型看到的内容同源。
    // 不传 AssembleOptions（无 deny/mode 裁剪）= 内置工具全集，与文档语义一致。
    if (cliArgs.dumpTools) {
      // §5.2：MCP 资源工具（ListMcpResources / ReadMcpResource）此刻尚未注册——
      // 它们的真实注册在下方 cli.ts:1715，且受 `if (mcpManager)` 条件包裹（仅配了 MCP
      // 才注册）。而 dump 在此处（1539）早于注册点且紧接着 exit(0)，导致 dump 产物永远
      // 缺这两个内置工具，ref/tools.md 随之漏项。
      // 这里补注册带 noop getter 的实例：dump 只取 definitions()（走 zodSchema→JSON Schema，
      // 不调 execute），dump 后立即 exit，不进正常启动路径、不污染运行时工具集。
      // 若 mcpManager 已存在并已注册（防御性，当前时序不会发生），先到先得会跳过。
      if (!toolRegistry.get("ListMcpResources")) {
        const { ListMcpResourcesTool, ReadMcpResourceTool } =
          await import("@sid-code/core/tool/mcp-resources.ts");
        const noop: () => undefined = () => undefined;
        toolRegistry.register(new ListMcpResourcesTool(noop));
        toolRegistry.register(new ReadMcpResourceTool(noop));
      }
      const json = JSON.stringify(toolRegistry.definitions(), null, 2) + "\n";
      // 先等 stdout 排空再 exit：产物约 80KB，管道下（`--dump-tools | jq`）单次 write
      // 会遇背压，裸 process.exit() 会截断 JSON——生成器拿到半截 JSON 会解析失败。
      await new Promise<void>((resolve) => {
        if (process.stdout.write(json)) resolve();
        else process.stdout.once("drain", () => resolve());
      });
      // 必须显式 exit：走到这里已完成全套初始化（settings 变更监听、日志流、
      // early-input 的 stdin resume 等），仅 return 会让事件循环一直有活引用而挂住不退。
      // 与 bootstrap 的 --self-check 快速路径同套路。
      process.exit(0);
    }

    // P2-6 --tools：白名单替换整个内置工具集（未列出的内置工具不可见）。
    // 基础设施工具 tool_search 强制保留——它是延迟加载调度器，裁掉会破坏 ToolSearch 机制。
    // MCP 工具不受影响（由各 MCP server 决定其可用性）。
    if (config.toolsWhitelist && config.toolsWhitelist.length > 0) {
      const keep = [...config.toolsWhitelist, "tool_search"];
      const removed = toolRegistry.retainBuiltInByNames(keep);
      getLogger().info(
        "CONFIG",
        `--tools 白名单裁剪：保留 ${toolRegistry.builtInSize()} 个内置工具，移除 ${removed.length} 个${removed.length > 0 ? `（${removed.slice(0, 10).join(", ")}${removed.length > 10 ? "…" : ""}）` : ""}`,
      );
    }

    // P1-10 --agent（单数，会话级主代理人格）：让整个会话以指定子代理的人格运行。
    // 时序关键：必须在**所有** agent 来源（built-in / 自定义 / 插件 / --agents 注入）都
    // 已 registerDynamicAgents 之后再解析，否则 --agent 指向 --agents 注入的代理时会解析不到。
    // 接线策略（不改 buildSystemPrompt 签名，复用已有的全经路配线）：把该代理的 systemPrompt
    // 合流进 config.appendSystemPrompt——buildSystemPrompt 的初次构建 + CLAUDE.md/运行时重建
    // 三条路径都消费 appendSystemPrompt，一处合流即全经路生效。
    // 注：不在此处切换主模型——provider/providerRegistry 已在上方（cli.ts:1084-1092）用
    // config.model 解析完毕，此处再改 config.model 已无法回传到已实例化的 provider。
    // 会话级模型切换应由 --model（更高优先级、在 provider 解析前生效）承担。
    if (config.topLevelAgent) {
      const { resolveAgent, getActiveAgentTypes } =
        await import("@sid-code/core/agent/agent-definition.ts");
      const persona = resolveAgent(config.topLevelAgent);
      if (!persona) {
        console.error(
          `错误: --agent 指定的子代理 "${config.topLevelAgent}" 不存在。可用: ${getActiveAgentTypes().join(", ")}`,
        );
        process.exit(1);
      }
      // 人格 systemPrompt 合流进 appendSystemPrompt（置于用户 append 之前，人格是基线）。
      if (persona.systemPrompt && persona.systemPrompt.trim()) {
        config.appendSystemPrompt = config.appendSystemPrompt
          ? `${persona.systemPrompt}\n\n${config.appendSystemPrompt}`
          : persona.systemPrompt;
      }
      if (persona.model && persona.model !== config.model) {
        getLogger().warn(
          "AGENT",
          `--agent "${config.topLevelAgent}" 声明了 model "${persona.model}"，但会话级模型切换须用 --model（provider 已在更早阶段解析）。本次仅应用人格提示词，模型仍为 ${config.model}。`,
        );
      }
      getLogger().info("AGENT", `--agent 会话级主代理人格已应用: ${config.topLevelAgent}`);
    }

    // P1-7 --mcp-config：解析额外 MCP 配置源（文件路径或内联 JSON，可重复）。
    // 支持 { "mcpServers": {...} } 或直接 { "serverName": {...} } 两种形态（与 .mcp.json 一致）。
    let mcpConfigServers: Record<
      string,
      import("@sid-code/core/config/config.ts").MCPServerConfig
    > = {};
    if (config.mcpConfigSources && config.mcpConfigSources.length > 0) {
      for (const src of config.mcpConfigSources) {
        const raw = String(src).trim();
        try {
          let parsed: any;
          if (raw.startsWith("{")) {
            parsed = JSON.parse(raw); // 内联 JSON
          } else {
            parsed = JSON.parse(readFileSync(resolvePath(raw), "utf-8")); // 文件路径
          }
          const servers = parsed?.mcpServers || parsed?.mcp_servers || parsed;
          if (servers && typeof servers === "object" && !Array.isArray(servers)) {
            mcpConfigServers = { ...mcpConfigServers, ...servers };
          } else {
            getLogger().warn("MCP", `--mcp-config 源格式不正确（期望对象）: ${raw.slice(0, 60)}`);
          }
        } catch (err: any) {
          console.error(
            `错误: --mcp-config 解析失败 "${raw.slice(0, 60)}": ${err?.message ?? err}`,
          );
          process.exit(1);
        }
      }
    }

    // 初始化 MCP 服务器（后台连接，不阻塞启动）。
    // P1-7 --strict-mcp-config：严格模式仅用 --mcp-config 指定的服务器，忽略 settings/.mcp.json/插件来源；
    // 非严格模式：用户配置 + 插件 MCP + --mcp-config 合并（--mcp-config 优先级最高）。
    const allMcpServers = config.strictMcpConfig
      ? { ...mcpConfigServers }
      : { ...config.mcpServers, ...pluginMcpServers, ...mcpConfigServers };
    if (config.strictMcpConfig) {
      getLogger().info(
        "MCP",
        `严格 MCP 配置模式（--strict-mcp-config）：仅加载 --mcp-config 指定的 ${Object.keys(mcpConfigServers).length} 个服务器。`,
      );
    }
    let mcpManager: import("@sid-code/core/mcp/manager.ts").MCPManager | undefined;

    // IDE 自动连接需要 mcpManager（IDE 作为动态 MCP server 接入），
    // 因此即使没有配置 MCP 服务器，只要 IDE 自动连接生效也创建 manager
    const { shouldAutoConnect } = await import("@sid-code/core/ide/integration.ts");
    const ideAutoConnect = shouldAutoConnect(config.ide?.autoConnect);

    if (Object.keys(allMcpServers).length > 0 || ideAutoConnect) {
      const { MCPManager } = await import("@sid-code/core/mcp/manager.ts");
      mcpManager = new MCPManager();

      // 回填 tool_search 的 MCP pending 检测：搜索无果时若有 server 仍在连接中，
      // 提示模型稍后重试（避免启动初期 MCP 异步连接未完成时误判工具不存在）。
      const { MCPConnectionStatus } = await import("@sid-code/core/mcp/types.ts");
      const mgr = mcpManager;
      toolSearchTool.setPendingMcpServers(() =>
        mgr
          .getStatus()
          .filter(
            (s) =>
              s.status === MCPConnectionStatus.CONNECTING ||
              s.status === MCPConnectionStatus.RECONNECTING,
          )
          .map((s) => s.name),
      );

      mcpManager.onToolsRefresh = (serverName, tools) => {
        const prefix = `mcp__${serverName}__`;
        toolRegistry.removeByPrefix(prefix);
        for (const tool of tools) toolRegistry.register(tool);
        // 动态刷新（IDE/重连）换了工具集，清 paramText 缓存避免陈旧参数文本。
        toolRegistry.invalidateParamTextCache();
      };

      // G3 接线：注入 Elicitation 处理器（服务器请求额外信息时用终端交互处理）。
      // App 就绪后可用 UI 版覆盖（见 App）；此处提供 CLI 版兜底，避免默认 cancel 一切。
      {
        const { cliElicitationHandler } = await import("@sid-code/core/mcp/elicitation.ts");
        mcpManager.elicitationHandler = cliElicitationHandler;
      }

      if (Object.keys(allMcpServers).length > 0) {
        const mgrForSkills = mcpManager;
        mcpManager
          .connectAll(allMcpServers)
          .then(async (mcpTools) => {
            for (const tool of mcpTools) toolRegistry.register(tool);
            if (mcpTools.length > 0) {
              // 新工具进池后清 paramText 缓存：延迟工具集变化（含 schema 可能更新），
              // 避免 tool_search 命中陈旧参数文本（借鉴 CC ToolSearchTool 的缓存失效）。
              toolRegistry.invalidateParamTextCache();
              getLogger().info("MCP", `已连接，注册 ${mcpTools.length} 个工具`);
            }
            // P2-4：连接完成后发现 MCP server 暴露的 skill:// 资源，转成 loadedFrom="mcp" 的 skill。
            // 安全隔离已就位（prompt-processor 禁内联 shell、executor 拒 hooks、permission 敏感属性强制 ask）。
            try {
              const { discoverMcpSkills } = await import("@sid-code/core/mcp/skill-discovery.ts");
              const mcpSkills = await discoverMcpSkills(mgrForSkills);
              if (mcpSkills.length > 0) {
                skillManager.addPluginSkills(mcpSkills); // 复用 precedence 追加 + 热重载重放登记
                for (const skill of mcpSkills) {
                  if (skill.userInvocable !== false) {
                    commandRegistry.register(new SkillCommand(skill), "user");
                  }
                }
                // 新 skill 进 listing：走增量注入路径（system prompt 已在启动时建好、
                // 来不及含这些迟到 skill，故必须经 reminder 增量提醒，否则模型看不到）。
                skillActivationCoordinator.enqueueListingForNewSkills(
                  mcpSkills.filter((s) => !s.disableModelInvocation).map((s) => s.name),
                );
                getLogger().info(
                  "MCP",
                  `发现 ${mcpSkills.length} 个 MCP Skill: ${mcpSkills.map((s) => s.name).join(", ")}`,
                );
              }
            } catch (err: any) {
              getLogger().warn(
                "MCP",
                `MCP Skill 发现失败（不阻断）: ${err?.message ?? String(err)}`,
              );
            }
          })
          .catch((err: any) => {
            getLogger().error("MCP", `初始化失败: ${err.message}`);
          });
      }
    }

    // G1：注册 MCP 资源工具（ListMcpResources / ReadMcpResource）。
    // 用惰性 getter 持有 mcpManager 引用（此刻可能仍在异步连接，工具执行时才求值）。
    // 仅在存在 mcpManager 时注册，避免无 MCP 场景给模型塞无用工具。
    if (mcpManager) {
      const mgrRef = mcpManager;
      const { ListMcpResourcesTool, ReadMcpResourceTool } =
        await import("@sid-code/core/tool/mcp-resources.ts");
      toolRegistry.register(new ListMcpResourcesTool(() => mgrRef));
      toolRegistry.register(new ReadMcpResourceTool(() => mgrRef));
    }

    // IDE 自动发现与连接（后台进行，不阻塞启动）
    // 复用 mcpManager 的 onToolsRefresh 同步工具，IDE 作为动态 MCP server 接入
    if (mcpManager && ideAutoConnect) {
      const { getIDEIntegration } = await import("@sid-code/core/ide/integration.ts");
      const ideIntegration = getIDEIntegration(mcpManager, process.cwd(), {
        discoveryTimeout: config.ide?.discoveryTimeout,
      });
      void ideIntegration?.startAutoConnect().catch((err: any) => {
        getLogger().debug("IDE", `自动连接失败: ${err.message}`);
      });
    }

    // LSP 代码智能系统懒初始化（后台进行，不阻塞启动）
    // 无 LSP 配置或语言服务器不可用时自动降级为无操作
    try {
      const { initializeLSP } = await import("@sid-code/core/lsp/manager.ts");
      initializeLSP(process.cwd());
    } catch (err: any) {
      getLogger().debug("LSP", `LSP 初始化跳过: ${err.message}`);
    }

    // 记录注册的工具
    if (config.debug) {
      const { getLogger } = await import("@sid-code/core/debug/logger.ts");
      const toolNames = toolRegistry
        .all()
        .map((t) => t.name())
        .join(", ");
      getLogger().info("CONFIG", `注册工具: ${toolNames} (共${toolRegistry.size()}个)`);
    }

    // 创建权限检查器（加载五层权限规则）
    const { PermissionChecker } = await import("@sid-code/core/permission/checker.ts");
    const { loadPermissionRules } = await import("@sid-code/core/config/config.ts");
    const permissionRules = await loadPermissionRules();
    const permissionChecker = new PermissionChecker(config, permissionRules);
    permissionChecker.setPlanManager(planManager);

    // G21：把权限 deny 规则接入 glob/ls 列举过滤——被 deny 的敏感文件（.env / secrets/**）
    // 不再出现在列举结果里（对标 claude-code），而非仅在后续 Read 时才被拦。
    // isPathHidden 仅做静态 deny 规则匹配（无 LLM/交互/副作用），高频调用无成本；
    // 无 deny 规则时恒 false（零开销、行为不变）。绑定实例方法保留 this。
    {
      const hidden = (absPath: string) => permissionChecker.isPathHidden(absPath);
      globTool.setPathHiddenFilter(hidden);
      lsTool.setPathHiddenFilter(hidden);
    }

    // 注入 LLM 命令风险分类器（P0-3 迭代 II，第二道防线；默认关闭，enableLLMClassifier 开启）
    {
      const { BashClassifier } = await import("@sid-code/core/permission/bash-classifier.ts");
      const classifier = new BashClassifier({
        enabled: config.enableLLMClassifier === true,
        model: config.classifierModel,
      });
      if (config.enableLLMClassifier === true) {
        // 复用主 provider；模型默认跟主循环模型
        classifier.setProvider(
          providerRegistry.getProvider(),
          config.classifierModel || config.model,
        );
      }
      permissionChecker.setBashClassifier(classifier);
    }

    // G2 修复：注入泛化工具安全分类器（auto 权限模式核心）。
    // 此前 tool-classifier.ts + checker auto 分支写好了但生产从未调 setToolClassifier，
    // 导致 classifier 恒 null → auto 分支整段短路、行为等价 default（死档），
    // 且 Shift+Tab 循环主动跳过 auto 档。这里补上接线，让 auto 模式对用户可达。
    //
    // 分类器仅在 permissionMode === "auto" 时被 checker 调用（checker.ts:652），
    // 非 auto 模式下不产生任何 API 成本，故默认 enabled=true 恒设 provider 无副作用。
    // 复用主 provider + 主循环模型（与 BashClassifier 一致的注入路径）。
    {
      const { ToolClassifier } = await import("@sid-code/core/permission/tool-classifier.ts");
      const toolClassifier = new ToolClassifier({
        enabled: true,
        model: config.classifierModel,
      });
      toolClassifier.setProvider(
        providerRegistry.getProvider(),
        config.classifierModel || config.model,
      );
      permissionChecker.setToolClassifier(toolClassifier);
    }

    // SEC-AUDIT-2026-07-19 P0：注入 WebFetch 隔离提炼器。
    // 抓取的网页正文不再直返主上下文，先由独立小模型按 prompt 提炼（对齐 CC 用 Haiku 的设计）。
    // 未注入 provider 时 WebFetch 走降级路径（截断 + 不可信标注），不会退回"原文直返"。
    // webFetchIsolate 显式设 false 才跳过注入（默认启用）。
    if (config.webFetchIsolate !== false) {
      const { getSharedWebFetchExtractor } =
        await import("@sid-code/core/tool/web-fetch-extract.ts");
      getSharedWebFetchExtractor().setProvider(
        providerRegistry.getProvider(),
        config.webFetchExtractModel || config.model,
      );
    }

    if (config.debug && permissionRules) {
      const { getLogger } = await import("@sid-code/core/debug/logger.ts");
      const allowCount = permissionRules.allow?.length ?? 0;
      const denyCount = permissionRules.deny?.length ?? 0;
      const askCount = permissionRules.ask?.length ?? 0;
      getLogger().info(
        "CONFIG",
        `权限规则: ${allowCount}条 allow, ${denyCount}条 deny, ${askCount}条 ask`,
      );
    }

    // 沙箱初始化（macOS Seatbelt，默认关闭）
    if (config.enableSandbox) {
      const { SandboxManager, defaultSandboxConfig } =
        await import("@sid-code/core/permission/sandbox.ts");
      const sandboxConfig = { ...defaultSandboxConfig(), enabled: true };
      const sandboxManager = new SandboxManager(sandboxConfig, process.cwd());
      permissionChecker.setSandboxManager(sandboxManager);
      // 注入到 bash 工具（遍历工具注册表找 BashTool）
      for (const tool of toolRegistry.all()) {
        const maybeBash = tool as { setSandboxManager?: (m: typeof sandboxManager) => void };
        if (typeof maybeBash.setSandboxManager === "function") {
          maybeBash.setSandboxManager(sandboxManager);
        }
      }
      getLogger().info("CONFIG", "macOS Seatbelt 沙箱已启用");
    }

    profileCheckpoint("init_end");

    // 创建统一命令注册表（新体系）：承载 custom/skill(含 bundled)/builtin/plugin 四来源。
    // App 的 TUI 命令获取/执行走此注册表；旧 commandRegistry 仍传入作回退 + /help 摘要数据源。
    const { UnifiedCommandRegistry } = await import("./command/unified-registry.ts");
    const unifiedRegistry = new UnifiedCommandRegistry({
      scanOptions,
      disabledSkills: config.disabledSkills,
      // 关键：与 SkillMetaTool 共用同一个 SkillManager。否则 loadSkillCommands 会自建
      // manager 重扫磁盘，插件/MCP skill（运行时追加）在斜杠命令里不可见，
      // 且 gate/disable/热重载状态与模型路径分叉。
      skillManager,
    });
    // skill 集合运行时变更 → 斜杠命令快照失效。覆盖：插件 skills 追加、MCP skill 发现、
    // 动态发现、条件激活 gate 解除、热重载、/skills 启停。不接这条线的话，新 skill
    // 在 TUI 里既不补全也执行不了（getCommands 返回的是启动时的 cwd 缓存）。
    skillManager.onSkillsChanged(() => unifiedRegistry.invalidateSkillCommands());

    // 预加载插件命令快照（custom/skill/builtin 由 getCommands 按 cwd 懒加载并缓存）
    try {
      await unifiedRegistry.loadPlugins();
    } catch (err: any) {
      getLogger().warn("CLI", `预加载插件命令失败: ${err?.message}`);
    }

    // 创建 App
    const { App } = await import("./app.ts");
    const app = new App({
      config,
      provider,
      providerRegistry,
      toolRegistry,
      commandRegistry,
      unifiedRegistry,
      permissionChecker,
      mcpManager,
      planManager,
      fileReadTracker,
      skillActivationCoordinator,
      skillManager,
    });
    // 注册全局 App 弱引用（供 uncaughtException 等异常兜底使用）
    setLastApp(app);

    // 注册并发会话（Spec 18 §4）+ 启动 Cron 调度器（Spec 18 §5）
    {
      const { registerSession, unregisterSession } =
        await import("@sid-code/core/session/concurrent.ts");
      const sessionEntry = {
        sessionId: config.sessionId,
        pid: process.pid,
        kind: (config.print ? "headless" : "interactive") as "headless" | "interactive",
        cwd: process.cwd(),
        startedAt: Date.now(),
        model: config.model,
      };
      registerSession(sessionEntry);

      // Cron 调度器：onFire 把 prompt 注入 App 主循环；isLoading 避免 REPL 忙时触发
      const { getScheduler } = await import("@sid-code/core/cron/scheduler.ts");
      const scheduler = getScheduler({
        onFire: (prompt: string) => {
          void app.enqueueScheduledPrompt?.(prompt);
        },
        isLoading: () => app.isBusy?.() ?? false,
        sessionId: config.sessionId,
        workspaceDir: process.cwd(),
      });
      scheduler.start();

      // 退出时注销会话 + 停止调度器 + 清理文件意图
      const cleanup = () => {
        try {
          unregisterSession(config.sessionId);
        } catch {
          /* 忽略 */
        }
        try {
          scheduler.stop();
        } catch {
          /* 忽略 */
        }
        try {
          clearFileIntent(config.sessionId);
        } catch {
          /* 忽略 */
        }
      };
      // ASYNC-2 修复：只挂 exit 兜底，不再注册同步 process.exit 的信号 handler。
      // 原先 cli.ts 在此处注册 SIGINT/SIGTERM → cleanup() + 同步 process.exit，
      // 会抢先于 app.ts:registerSignalHandlers 的异步 SessionEnd 落盘（fireSessionEndEvent
      // + finalizeSessionStore 需要 await），导致 Ctrl+C 时 trajectory 只剩 metadata、消息丢失。
      // 现统一由 app.ts 的 onSignal 异步落盘后再 process.exit；其 process.exit 会触发本 'exit'
      // 事件，cleanup（注销并发会话 + 停止调度器，均为同步操作）仍会被执行，幂等无副作用。
      process.once("exit", cleanup);
    }

    // 启动时自动清理过期会话（后台静默执行）
    if (!config.print) {
      const { cleanupExpiredSessions, getRetentionSettings } =
        await import("@sid-code/core/session/cleanup.ts");
      const retentionSettings = getRetentionSettings(config);
      if (retentionSettings.enabled) {
        cleanupExpiredSessions(config, retentionSettings, config.sessionId)
          .then((result) => {
            if (result.deleted > 0 && config.debug) {
              getLogger().info("CLEANUP", `自动清理: 删除 ${result.deleted} 个过期会话`);
            }
          })
          .catch((err: any) => {
            if (config.debug) {
              getLogger().error("CLEANUP", `自动清理失败: ${err.message}`);
            }
          });
      }
    }

    // 启动时恢复并清理 Worktree（P0-1 / P1-9 / D16），以及 --worktree 启动 flag（P1-2）
    if (!config.print) {
      try {
        const { findGitRoot, restoreWorktreeSession, setCurrentWorktreeSession } =
          await import("@sid-code/core/worktree/index.ts");
        const gitRoot = findGitRoot(process.cwd());
        if (gitRoot) {
          let activeWtPath: string | undefined;

          // P1-2：--worktree [name] 启动即创建并进入（优先于 resume）
          if (cliArgs.worktree !== undefined) {
            try {
              const { WorktreeManager } = await import("@sid-code/core/worktree/manager.ts");
              const { enterWorktreeCwd } = await import("@sid-code/core/worktree/canonical.ts");
              const { saveWorktreeState } = await import("@sid-code/core/worktree/persistence.ts");
              const { logWorktreeEvent } = await import("@sid-code/core/worktree/analytics.ts");
              const { generateWordSlug } = await import("@sid-code/core/plan/slug.ts");
              const { join } = await import("path");
              const worktreesDir = join(gitRoot, ".sid-code", "worktrees");
              const name =
                typeof cliArgs.worktree === "string" && cliArgs.worktree
                  ? cliArgs.worktree
                  : generateWordSlug(worktreesDir);
              const manager = new WorktreeManager(gitRoot);
              const wtSession = await manager.create(name);
              await enterWorktreeCwd(wtSession.worktreePath);
              setCurrentWorktreeSession(wtSession);
              saveWorktreeState(wtSession);
              activeWtPath = wtSession.worktreePath;
              logWorktreeEvent("worktree_created", {
                slug: wtSession.worktreeName,
                hookBased: !!wtSession.hookBased,
                durationMs: wtSession.creationDurationMs,
                viaFlag: true,
              });
              getLogger().info("WORKTREE", `--worktree 启动进入: ${wtSession.worktreePath}`);
            } catch (err: any) {
              getLogger().error("WORKTREE", `--worktree 创建失败: ${err.message}`);
              console.error(`错误: --worktree 创建失败: ${err.message}`);
              process.exit(1);
            }
          } else {
            // P0-1：恢复上次会话的 worktree（进程重启/crash 后）
            const { session, cleared } = restoreWorktreeSession(gitRoot);
            if (session) {
              const { enterWorktreeCwd } = await import("@sid-code/core/worktree/canonical.ts");
              const { logWorktreeEvent } = await import("@sid-code/core/worktree/analytics.ts");
              try {
                await enterWorktreeCwd(session.worktreePath);
                setCurrentWorktreeSession(session);
                activeWtPath = session.worktreePath;
                logWorktreeEvent("worktree_resume", { slug: session.worktreeName, success: true });
                getLogger().info("WORKTREE", `已恢复 worktree 会话: ${session.worktreeName}`);
              } catch (err: any) {
                getLogger().warn("WORKTREE", `恢复 worktree cwd 失败: ${err.message}`);
              }
            } else if (cleared && config.debug) {
              getLogger().info("WORKTREE", "持久化的 worktree 已失效，已清除状态");
            }
          }

          // D16：后台清理过期临时 worktree（跳过当前活跃 session）
          const { cleanupStaleWorktrees } = await import("@sid-code/core/worktree/cleanup.ts");
          cleanupStaleWorktrees(gitRoot, 30, activeWtPath)
            .then((n) => {
              if (n > 0 && config.debug) {
                getLogger().info("WORKTREE", `自动清理: 删除 ${n} 个过期临时 Worktree`);
              }
            })
            .catch(() => {
              /* 忽略 */
            });
        }
      } catch (err: any) {
        getLogger().warn("WORKTREE", `worktree 启动处理失败（不阻断）: ${err.message}`);
      }
    }

    // P2-G9：--from-pr <number>——从 PR 恢复会话上下文。放在会话恢复分支之前：
    //   - PR body 内嵌会话 id → 设 config.resume，转下方正常 resume 流程。
    //   - 否则把 PR 上下文（标题/描述/改动文件）拼进初始 prompt，注入新会话。
    // gh 不可用 / PR 不存在 → 报错退出（PR 恢复失败用户需要知道，不静默降级为空会话）。
    if (cliArgs.fromPr) {
      try {
        const { loadFromPr } = await import("@sid-code/core/session/from-pr.ts");
        const result = await loadFromPr(cliArgs.fromPr, process.cwd());
        if (result.sessionId) {
          getLogger().info(
            "CLI",
            `--from-pr ${result.prNumber}：内嵌会话 id ${result.sessionId}，转为 resume`,
          );
          config.resume = result.sessionId;
        } else if (result.contextText) {
          getLogger().info("CLI", `--from-pr ${result.prNumber}：注入 PR 上下文到新会话`);
          // 把 PR 上下文前置到用户 prompt（若有）之前；纯 --from-pr 无 prompt 时，
          // 上下文本身即首条输入。
          cliArgs.prompt = cliArgs.prompt
            ? `${result.contextText}\n\n---\n\n${cliArgs.prompt}`
            : result.contextText;
        }
      } catch (err: any) {
        console.error(`错误: --from-pr 失败：${err?.message ?? String(err)}`);
        process.exit(1);
      }
    }

    // 会话恢复：--continue / --resume <id> / --resume（无值开选择器，对标 CC）
    if (config.continue || config.resume || cliArgs.resumePicker) {
      const { SessionStore } = await import("@sid-code/core/session/store.ts");
      const { SessionSelector } = await import("@sid-code/core/session/utils.ts");
      const { sidPaths } = await import("@sid-code/core/config/paths.ts");
      const store = new SessionStore();
      let session: import("@sid-code/core/session/store.ts").SessionData | null = null;

      // 无头模式（--print）不能弹交互选择器：缺 stdin 无法选择。
      if (cliArgs.resumePicker && config.print) {
        console.error(
          "错误: 无头模式（--print）下 --resume 必须带会话 ID。用法: sid-code -p --resume <id>",
        );
        process.exit(1);
      }

      if (cliArgs.resumePicker) {
        // -r 不带值 → 打开交互式选择器（进入即搜索，CC 风格）
        const selectedId = await runSessionPicker(config, { searchFirst: true });
        if (!selectedId) {
          // 用户取消选择：直接退出，不进入空会话（对齐 CC）
          getLogger().info("CLI", "用户取消会话选择");
          process.exit(0);
        }
        session = await store.load(selectedId);
        if (!session) {
          console.error(`错误: 无法加载会话 ${selectedId}`);
          process.exit(1);
        }
      } else if (config.resume) {
        // -r <value>：先按 ID / 索引精确解析；命中即恢复。
        let resolvedId: string | null = null;
        try {
          const selector = new SessionSelector(sidPaths.sessions());
          const info = await selector.findSession(config.resume);
          resolvedId = info.id;
        } catch {
          resolvedId = null;
        }

        if (resolvedId) {
          session = await store.load(resolvedId);
        }

        if (!session) {
          // 未精确命中 → 把值当搜索词带进选择器（对齐 CC：no exact match → search term）。
          if (config.print) {
            console.error(`错误: 未找到会话 ${config.resume}`);
            process.exit(1);
          }
          const selectedId = await runSessionPicker(config, {
            searchFirst: true,
            initialSearchQuery: config.resume,
          });
          if (!selectedId) {
            getLogger().info("CLI", "用户取消会话选择");
            process.exit(0);
          }
          session = await store.load(selectedId);
          if (!session) {
            console.error(`错误: 无法加载会话 ${selectedId}`);
            process.exit(1);
          }
        }
      } else {
        session = await store.loadLatest();
        if (!session) {
          console.error("错误: 没有可恢复的历史会话");
          process.exit(1);
        }
      }

      // 不再 console.log：TUI 渲染前的裸输出会留在 banner 上方的终端 scrollback 里，
      // 用户看到一行游离的「恢复会话: …」。恢复进度只写日志，TUI 首屏会自然呈现历史消息。
      getLogger().info("CLI", `恢复会话: ${session.id} (${session.messages.length} 条消息)`);
      await app.restoreSession(session);
    }

    // 根据模式路由
    if (cliArgs.bridgeUrl) {
      // Bridge 远程控制模式（spec 16 §7）：常驻进程，接受远程客户端连接
      startupTimer.end();
      await app.runBridge({
        url: cliArgs.bridgeUrl,
        authToken: cliArgs.bridgeToken,
      });
    } else if (config.print) {
      if (!cliArgs.prompt) {
        console.error("错误: 无头模式需要提供提示词");
        process.exit(1);
      }
      // 解析 --json-schema 文件 → config.jsonSchema（结构化输出约束）
      if (cliArgs.jsonSchemaFile) {
        try {
          const { readFileSync } = await import("node:fs");
          config.jsonSchema = JSON.parse(readFileSync(cliArgs.jsonSchemaFile, "utf-8"));
        } catch (err) {
          console.error(
            `错误: 无法读取/解析 --json-schema 文件 "${cliArgs.jsonSchemaFile}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          process.exit(1);
        }
      }
      startupTimer.end();
      await app.runHeadless(cliArgs.prompt);
    } else {
      profileCheckpoint("render_start");
      const startupDuration = startupTimer.end();
      if (config.debug) {
        getLogger().info("CLI", `启动完成，耗时 ${startupDuration.toFixed(0)}ms`);
      }
      await app.runTUI(cliArgs.prompt);
    }
  } catch (err) {
    console.error("错误:", err);
    process.exit(1);
  }
}
