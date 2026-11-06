/**
 * 无头形态（`-p` 文本/JSON、stream-json、Bridge）的斜杠命令分发。
 *
 * 修复前 runHeadless / runHeadlessSDK / runBridge 都把输入直接交给 `queryEngine.submitMessage`，
 * 只有 TUI 的 onSlashCommand 会分发命令。于是 `-p "/plugin market"` 被原样当成提示词，
 * 模型自己去 strings 二进制、读源码找"/plugin 是什么"（实测 110s 未结束），
 * CI / 脚本既装不了插件，也确定性地调不了 skill —— 能调上只是模型碰巧认出了名字。
 *
 * 本模块只做**判定与结果映射**，不碰 App 状态：
 * - 提示词类命令（自定义命令 / skill / 插件 / MCP prompt，以及显式 `headless: true` 的 builtin）
 *   走与 TUI 同一个 CommandExecutor，展开后的提示词再交给模型；
 * - 交互 / 管理类 builtin 直接报错（退出码非 0），并指向对应的 CLI 子命令；
 * - 不是命令的输入（`/tmp/x.log 看一下`、`--disable-slash-commands`）原样提交。
 *
 * 为什么不让无头全量走 executor：AppContext 里大量回调依赖 TUI（beginForkedRun 的 spinner、
 * dialog、confirm、状态栏 notify…），全量放行的结果是一半命令能跑、一半静默失效——
 * 正是「死接线零报错」那一类。宁可明确拒绝，也不让 CI 拿到一个假成功。
 */

import type { HeadlessAllowlist, HeadlessModality } from "@sid-code/core/command-contract/types.ts";
import type { CommandExecutionResult, UnifiedCommand } from "./types.ts";
import { parseSlashCommand } from "./parser.ts";

/** 分发结果：调用方（App）据此决定提交给模型、直接输出、还是报错退出。 */
export type HeadlessSlashOutcome =
  /** 不是命令（或斜杠命令已禁用）：把 input 原样交给模型 */
  | { kind: "not_command"; input: string }
  /** 命令展开为提示词：交给模型，displayCommand 用于落盘/展示时只显示触发命令本身 */
  | {
      kind: "submit";
      prompt: string;
      displayCommand: string;
      allowedTools?: string[];
      allowedToolsTrusted?: boolean;
    }
  /** 命令在本地执行完毕（fork skill 的回答、文本结果）：直接作为本轮答复，不再调模型 */
  | { kind: "output"; text: string; displayCommand: string }
  /** 拒绝或执行失败：调用方按错误收尾（退出码非 0） */
  | { kind: "error"; message: string };

/** 执行器的最小接口（便于单测注入；生产传 CommandExecutor 实例）。 */
export interface HeadlessExecutor {
  findCommand(name: string, commands: UnifiedCommand[]): UnifiedCommand | undefined;
  executeSlashCommand(input: string, commands: UnifiedCommand[]): Promise<CommandExecutionResult>;
}

/**
 * 交互 / 管理类 builtin 在无头下的替代入口。
 * 只列**真实存在**的子命令（bootstrap.ts 快速路径），写一个不存在的子命令比不写更糟。
 */
const CLI_ALTERNATIVES: Readonly<Record<string, string>> = {
  plugin: "sid-code plugin <list|market|install|update|uninstall|enable|disable|info>",
  plugins: "sid-code plugin <list|market|install|update|uninstall|enable|disable|info>",
  mcp: "sid-code mcp <list|get|add|remove|pending|approve|reject>",
  agents: "sid-code agents",
  hooks: "sid-code hooks list",
};

/**
 * 命令能否在无头下执行。返回 null = 放行；否则返回给用户看的拒绝原因。
 *
 * 判定口径的**唯一实现**（契约字段 `CommandBase.headless` 的注释指向这里）。
 *
 * 声明形态三态：
 * - `true`：三形态、全部子命令放行（`/init` 与 A 档只读命令）；
 * - 结构体 `{ modes?, subcommands? }`：白名单，任一维度不满足即拒绝（fail-closed）；
 * - 缺省：按来源判——非 builtin（提示词模板）放行，builtin 拒绝。
 */
function headlessRefusal(
  cmd: UnifiedCommand,
  typedName: string,
  gateCtx: HeadlessGateContext,
): string | null {
  const decl = cmd.headless;
  const gate: boolean | HeadlessAllowlist =
    decl === undefined ? (cmd.source ?? "builtin") !== "builtin" : decl;
  if (gate === true) return null;
  if (gate !== false) {
    // 形态维度：`modes` 给了就只放这些形态。T6 的 /compact、/loop 靠它区分
    // 「-p 单轮拒绝、长驻形态放行」——判定依据是形态，不是「第几轮」。
    if (gate.modes && !gate.modes.includes(gateCtx.mode)) {
      return `/${typedName} 在${MODALITY_LABEL[gateCtx.mode]}形态下不可用（仅支持：${gate.modes
        .map((m) => MODALITY_LABEL[m])
        .join(" / ")}）。`;
    }
    // 子命令维度：按参数首词判（命令自己的 subCommands() 不是判定依据——/cron /hooks
    // 用 switch 解析参数，没有 subCommands 声明）。无参调用始终放行：它是查看状态/用法，
    // 不构成写操作；无参返回 dialog 的命令由分发层明确报错（非 0），不是假成功。
    const sub = firstArgWord(gateCtx.args);
    if (gate.subcommands && sub && !gate.subcommands.includes(sub)) {
      return `/${typedName} ${sub} 在无头模式下不可用（该命令只放行子命令：${gate.subcommands.join(
        " / ",
      )}）。`;
    }
    return null;
  }
  return refusalText(cmd, typedName);
}

/** 无头形态 → 拒绝文案里的可读标签。 */
const MODALITY_LABEL: Readonly<Record<HeadlessModality, string>> = {
  p: "-p 单轮",
  "stream-json": "stream-json 多轮",
  bridge: "Bridge 长驻",
};

/** 取参数首词（子命令名）；无参返回空串。 */
function firstArgWord(args: string): string {
  return args.trim().split(/\s+/).filter(Boolean)[0] ?? "";
}

/** 整条命令被拒绝时的文案（交互 / 管理类 builtin）。 */
function refusalText(cmd: UnifiedCommand, typedName: string): string {
  if (cmd.name === "reload-plugins") {
    return "/reload-plugins 在无头模式下不需要：每次启动都会重新加载插件。";
  }
  const alt = CLI_ALTERNATIVES[cmd.name] ?? CLI_ALTERNATIVES[typedName];
  const base = `/${typedName} 是交互命令，无头模式（-p / stream-json / Bridge）下不可用。`;
  return alt ? `${base}\n请改用 CLI 子命令: ${alt}` : base;
}

/**
 * 判定上下文：本次输入所处的无头形态 + 斜杠命令之后的原始参数（子命令判定用）。
 *
 * `mode` 做成显式参数而不是读全局：形态判定错了会让「按形态放行」的命令静默走错分支，
 * 所以由调用方（App）传入、测试直接构造。
 *
 * 刻意**不 export**：生产侧只有本文件的 `headlessRefusal` 一个消费点，导出它就多一个
 * 零生产调用的符号（命令体系门禁 G1 会拦，实测 8→9）。
 */
interface HeadlessGateContext {
  mode: HeadlessModality;
  /** `parseSlashCommand().args`：斜杠命令名之后的原始参数字符串。 */
  args: string;
}

/**
 * 由配置与进程级 Bridge 标记推断当前无头形态。
 *
 * 三个调用方（`-p` 文本/JSON、stream-json、Bridge）走同一个 `submitHeadlessInput`，
 * 形态信号都已存在：bridge 是进程级标记（`trace/session-flags.ts`），stream-json 看
 * input/output 格式任一命中（与 `runHeadless` 选择 SDK 路径的判据同源），
 * `-p` 文本/JSON 是剩下的兜底。
 *
 * 抽成纯函数是为了可单测：这段判错会让 T6 的「`-p` 拒绝、长驻放行」整体走反。
 */
export function resolveHeadlessModality(signals: {
  inputFormat?: string;
  outputFormat?: string;
  bridge: boolean;
}): HeadlessModality {
  // Bridge 优先：桥接会话的输出不走 stdout 的 stream-json 通道，两个格式字段对它无意义。
  if (signals.bridge) return "bridge";
  if (signals.inputFormat === "stream-json" || signals.outputFormat === "stream-json") {
    return "stream-json";
  }
  return "p";
}

/**
 * 解析并（在放行时）执行一条无头输入。
 *
 * @param disableSlashCommands `--disable-slash-commands`：为 true 时一律原样提交，与 TUI 同口径。
 * @param mode 当前无头形态。**必填**：给默认值会让「按形态放行」的命令（T6 的 /compact、/loop）
 *   在调用方忘传时静默走错分支——那正是「声明的放行粒度与实现不符」最隐蔽的一种。
 */
export async function resolveHeadlessSlash(
  input: string,
  opts: {
    commands: UnifiedCommand[];
    executor: HeadlessExecutor;
    mode: HeadlessModality;
    disableSlashCommands?: boolean;
  },
): Promise<HeadlessSlashOutcome> {
  if (opts.disableSlashCommands) return { kind: "not_command", input };
  const parsed = parseSlashCommand(input);
  if (!parsed) return { kind: "not_command", input };

  const displayCommand = input.trim();
  // 门控看顶层命令：`/plugin install x` 的叶子是 legacy 适配出的子命令，不带来源与门控字段。
  const top = opts.executor.findCommand(parsed.commandName, opts.commands);
  if (top) {
    const refusal = headlessRefusal(top, parsed.commandName, {
      mode: opts.mode,
      args: parsed.args,
    });
    if (refusal) return { kind: "error", message: refusal };
  }

  // 未命中的输入也交给 executor：它负责「未知命令」与「/tmp 这类真实路径 passthrough」的区分，
  // 那条判定（含 stat）只该有一份实现。
  const result = await opts.executor.executeSlashCommand(input, opts.commands);
  const outcome = mapExecutionResult(result, displayCommand);
  if (outcome.kind === "error") outcome.message = toCliHint(outcome.message);
  return outcome;
}

/**
 * 把提示文本里的 `/plugin <子命令>` 改写成 `sid-code plugin <子命令>`。
 *
 * executor 的提示是给 TUI 写的（如已下沉 skill 的迁移提示「/plugin install compliance@sid-code」），
 * 无头下 `/plugin` 本身会被拒绝——照着提示做会再碰一次壁。只改写错误文本，不动 TUI 那份。
 */
function toCliHint(message: string): string {
  return message.replace(/(^|[\s：:（(])\/plugin(?=\s)/g, "$1sid-code plugin");
}

/** CommandExecutionResult → 无头分发结果（单测经 resolveHeadlessSlash 注入假 executor 穷举）。 */
function mapExecutionResult(
  result: CommandExecutionResult,
  displayCommand: string,
): HeadlessSlashOutcome {
  switch (result.type) {
    case "submit_prompt":
      return {
        kind: "submit",
        prompt: result.value,
        displayCommand,
        ...(result.allowedTools?.length
          ? {
              allowedTools: result.allowedTools,
              allowedToolsTrusted: result.allowedToolsTrusted === true,
            }
          : {}),
      };
    case "passthrough":
      return { kind: "not_command", input: result.value };
    case "message":
      return { kind: "output", text: result.value, displayCommand };
    case "compact":
      return { kind: "output", text: result.summary, displayCommand };
    case "quit":
      return { kind: "output", text: result.message ?? "", displayCommand };
    case "skip":
      return { kind: "output", text: "", displayCommand };
    case "error":
      return { kind: "error", message: result.message };
    // 以下三类需要人在场（弹窗 / 二次确认 / 清屏重置 TUI 状态）。放行的命令不应产出它们；
    // 产出了就是命令声明与实现不符，明确报错，不假装成功。
    case "dialog":
    case "confirm":
    case "clear":
      return {
        kind: "error",
        message: `${displayCommand} 需要交互界面（${result.type}），无头模式下无法完成。`,
      };
  }
}
