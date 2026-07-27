#!/usr/bin/env bun
/**
 * 参考页生成器 —— 从源码生成 website/ref/ 下 6 页 + public/llms.txt。
 *
 * 完整设计见 docs/reference/官网与文档站设计方案.md §4.5。核心原则（§4.5.2 机制二）：
 * **优先运行时自省，不静态解析源码文本**。凡是能让运行时自己吐出真值的（工具定义、
 * 斜杠命令、Hook 枚举、zod schema），一律 import 真对象；只有 help.ts 这类
 * "本来就是给人看的文本"才做文本解析，且必须配一个结构化源做交叉对账。
 *
 * 数据源与对账关系：
 *
 *   ref/tools           `--dump-tools`（运行时 registry 真值，与发给 LLM 的定义同源）
 *   ref/slash-commands  loadBuiltinCommands()（已迁移 BUILTIN_COMMANDS + legacy 桥接）
 *   ref/hooks           HookEventName 枚举 + 源码注释
 *   ref/settings        SettingsSchema().shape（骨架）× Config 接口（补 passthrough 漏项）
 *   ref/cli             src/cli.ts parseArgs（权威：能不能用）× src/help.ts（素材：怎么说人话）
 *   ref/env             src/help.ts 环境变量段 × 源码 process.env 扫描
 *
 * 用法:
 *   bun run scripts/docs-gen-reference.ts            # 写入
 *   bun run scripts/docs-gen-reference.ts --check    # 对账：不一致退 1（pre-commit 门禁调用）
 *   bun run scripts/docs-gen-reference.ts --stale    # 报告 >90 天未复核的指南页（只告警不阻塞）
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const WEBSITE = join(ROOT, "website");
const REF = join(WEBSITE, "ref");

const CHECK = process.argv.includes("--check");
const STALE = process.argv.includes("--stale");

/**
 * 沿用 docs-index-gen.ts 的标记约定，不发明新格式（标记内覆盖，标记外保留）。
 *
 * ⚠ START 必须用**带后缀说明的完整串**匹配，不能用 `<!-- AUTO-GEN:START` 前缀匹配：
 * 各参考页的「请勿手工编辑」提示语里字面写着 `<!-- AUTO-GEN:START -->`（给人看的说明），
 * 位置在真标记之前。前缀匹配会命中提示语里那个，splice 出的文件会把正文吃掉。
 * 导出供测试复用同一常量，避免测试自己再写一份易错的匹配。
 */
export const MARKER_START =
  "<!-- AUTO-GEN:START 由 scripts/docs-gen-reference.ts 生成，勿手工编辑 -->";
export const MARKER_END = "<!-- AUTO-GEN:END -->";
const START = MARKER_START;
const END = MARKER_END;

/** 表格单元格转义：| 会截断 markdown 表格，换行会破行 */
function cell(s: string): string {
  return String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 描述类文本：截断过长内容（工具描述动辄上千字，表格放全文没法读）+ 转义 Vue 语法。
 *
 * 必须转义 `<` 与 `{{`：VitePress 会把 markdown 渲染结果交给 Vue 编译器，
 * 源码里的描述带尖括号占位符是常态（`/loop 5m <任务>`、`<start|stop>`），
 * 未转义会被当成未闭合 HTML 标签 → **整站构建失败**（已实测撞到）；
 * `{{ }}` 会被当成 Vue 插值求值。
 *
 * 只对**非** backtick 包裹的列做这层转义：代码列走 markdown 行内代码，
 * markdown-it 自己会转义，再转一遍会把 `&lt;` 字面显示出来。
 */
function clip(s: string, max: number): string {
  const t = cell(s);
  const truncated = t.length <= max ? t : t.slice(0, max - 1) + "…";
  return truncated.replace(/</g, "&lt;").replace(/\{\{/g, "&#123;&#123;");
}

// ============================================================
// 数据源 1：内置工具（运行时自省 —— --dump-tools）
// ============================================================

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

/**
 * 取工具定义。走 `bun run src/entrypoints/bootstrap.ts --dump-tools` 而非编译好的
 * ./sid-code 二进制：二进制可能是旧版（忘了 make rebuild），那样生成的文档会对应
 * 上一次编译时的源码——正是本生成器要防的漂移。从源码跑保证与工作区一致。
 */
function loadTools(): ToolDef[] {
  const proc = Bun.spawnSync(
    ["bun", "run", join(ROOT, "src/entrypoints/bootstrap.ts"), "--dump-tools"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `--dump-tools 失败（exit ${proc.exitCode}）：${proc.stderr.toString().slice(0, 500)}`,
    );
  }
  const raw = proc.stdout.toString();
  let defs: ToolDef[];
  try {
    defs = JSON.parse(raw);
  } catch {
    throw new Error(`--dump-tools 输出不是合法 JSON（前 200 字：${raw.slice(0, 200)}）`);
  }
  if (!Array.isArray(defs) || defs.length === 0) {
    throw new Error("--dump-tools 返回空列表——registry 没吐出工具，生成会产出空表");
  }
  return defs;
}

/** 从 JSON Schema 抽必填/可选参数名（供参数列展示） */
function schemaParams(schema: Record<string, any>): { required: string[]; optional: string[] } {
  const props = schema?.properties ?? {};
  const req = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);
  const required: string[] = [];
  const optional: string[] = [];
  for (const k of Object.keys(props)) (req.has(k) ? required : optional).push(k);
  return { required, optional };
}

function renderTools(tools: ToolDef[]): string {
  let out = `> 共 **${tools.length}** 个内置工具，由 \`--dump-tools\` 从运行时注册表导出——\n`;
  out += `> 与发给模型的工具定义同源。表里的名称就是你在权限规则、\`--allowed-tools\`、\n`;
  out += `> 子代理 \`tools\` 清单、Hook matcher 里要写的字符串。\n\n`;
  out += `| 工具名 | 用途 | 必填参数 | 可选参数 |\n|---|---|---|---|\n`;
  for (const t of tools) {
    const { required, optional } = schemaParams(t.input_schema);
    // 描述取首行：完整描述含使用指南，动辄上千字，表格放不下
    const firstLine = String(t.description ?? "").split(/\n/)[0];
    out += `| \`${cell(t.name)}\` | ${clip(firstLine, 110)} | ${
      required.length ? required.map((p) => `\`${p}\``).join(" ") : "—"
    } | ${optional.length ? optional.map((p) => `\`${p}\``).join(" ") : "—"} |\n`;
  }
  return out;
}

// ============================================================
// 数据源 2：斜杠命令（运行时自省 —— loadBuiltinCommands）
// ============================================================

interface SlashCmd {
  name: string;
  description: string;
  aliases: string[];
  argumentHint: string;
}

/**
 * 取斜杠命令。
 *
 * ⚠ 与设计文档 T-3.1 的结论有一处修正：文档说数据源是 `BUILTIN_COMMANDS`，但实测
 * 那只是**已迁移到 commands/ 目录的 29 个**；另有 33 个仍在 builtins.ts 里由
 * `loadBuiltinCommands()` 经 adaptLegacyCommand 桥接。只读 BUILTIN_COMMANDS 会漏掉
 * 一半命令（/help /cost /clear /config /theme 这些高频命令全在 legacy 那半边），
 * 文档就成了"能用的没写全"。故改用 loadBuiltinCommands() 拿全集。
 */
async function loadSlashCommands(): Promise<SlashCmd[]> {
  const { loadBuiltinCommands } = await import(join(ROOT, "src/command/loaders.ts"));
  const cmds = await loadBuiltinCommands();
  return cmds
    .map((c: any) => ({
      name: c.name,
      description: c.description ?? "",
      aliases: Array.isArray(c.aliases) ? c.aliases : [],
      argumentHint: c.argumentHint ?? "",
    }))
    .sort((a: SlashCmd, b: SlashCmd) => a.name.localeCompare(b.name));
}

function renderSlashCommands(cmds: SlashCmd[]): string {
  let out = `> 共 **${cmds.length}** 个内置斜杠命令，从运行时命令注册表导出。\n`;
  out += `> 在交互模式输入 \`/\` 会看到同一份列表（补全列表与本表同源）。\n\n`;
  out += `| 命令 | 说明 | 别名 | 参数 |\n|---|---|---|---|\n`;
  for (const c of cmds) {
    out += `| \`/${cell(c.name)}\` | ${clip(c.description, 110)} | ${
      c.aliases.length ? c.aliases.map((a) => `\`/${a}\``).join(" ") : "—"
    } | ${c.argumentHint ? `\`${cell(c.argumentHint)}\`` : "—"} |\n`;
  }
  return out;
}

// ============================================================
// 数据源 3：Hook 事件（HookEventName 枚举 + 源码注释）
// ============================================================

/**
 * 抽 enum 成员的前置注释（`/** ... *\/` 或连续 `//` 行）。
 * 注释是"人写给人看的描述"，源码里没有别处存这个信息，只能文本提取——
 * 但**成员清单本身**走运行时枚举（loadHookEvents），所以漏读注释最多是描述空缺
 * （会被非空断言抓到），不会漏掉事件本身。
 */
function extractEnumComments(file: string, enumName: string): Map<string, string> {
  const src = readFileSync(file, "utf8");
  const s = src.indexOf(`export enum ${enumName} {`);
  if (s < 0) throw new Error(`${file} 里找不到 enum ${enumName}——源码结构变了，生成器需同步`);
  const e = src.indexOf("\n}", s);
  const lines = src.slice(s, e).split("\n");
  const out = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*["']/);
    if (!m) continue;
    const buf: string[] = [];
    for (let j = i - 1; j >= 0; j--) {
      const p = lines[j].trim();
      if (p.startsWith("/**") || p === "*/" || p.startsWith("*") || p.startsWith("//")) {
        buf.unshift(p.replace(/^\/\*\*|^\*\/$|^\*|^\/\//g, "").replace(/\*\/$/, "").trim());
      } else break;
    }
    const text = buf.filter(Boolean).join(" ").trim();
    if (text) out.set(m[1], text);
  }
  return out;
}

interface HookEvent {
  name: string;
  description: string;
}

async function loadHookEvents(): Promise<HookEvent[]> {
  const mod = await import(join(ROOT, "src/hook/types.ts"));
  const enumObj = mod.HookEventName as Record<string, string>;
  const comments = extractEnumComments(join(ROOT, "src/hook/types.ts"), "HookEventName");
  return Object.keys(enumObj).map((k) => ({
    name: k,
    description: comments.get(k) ?? "",
  }));
}

function renderHookEvents(events: HookEvent[]): string {
  let out = `> 共 **${events.length}** 类 Hook 事件，从 \`HookEventName\` 枚举导出。\n`;
  out += `> 配置写在 \`settings.json\` 的 \`hooks\` 段，键名用下表的事件名\n`;
  out += `> （旧的 snake_case 写法仍兼容）。标「预留」的事件枚举已定义但当前无触发点，\n`;
  out += `> 配了不会被调用——这是实现现状，不是文档遗漏。\n\n`;
  out += `| 事件名 | 触发时机 |\n|---|---|\n`;
  for (const e of events) {
    out += `| \`${cell(e.name)}\` | ${clip(e.description, 160)} |\n`;
  }
  return out;
}

// ============================================================
// 数据源 4：settings.json 字段（SettingsSchema × Config 接口）
// ============================================================

/** zod v3 类型对象 → 人能读的类型串。用 `.shape` 遍历（v4 的 toJSONSchema 在此版本会抛）。 */
function zodTypeName(z: any): {
  type: string;
  enumValues: string[];
  constraint: string;
} {
  let cur = z;
  for (let i = 0; i < 10 && cur?._def; i++) {
    const t = cur._def.typeName;
    if (t === "ZodOptional" || t === "ZodDefault" || t === "ZodNullable") cur = cur._def.innerType;
    else break;
  }
  const t: string = cur?._def?.typeName ?? "?";
  const enumValues: string[] = Array.isArray(cur?._def?.values) ? cur._def.values : [];
  let constraint = "";
  if (Array.isArray(cur?._def?.checks)) {
    constraint = cur._def.checks
      .map((c: any) =>
        c.kind === "min"
          ? `≥${c.value}`
          : c.kind === "max"
            ? `≤${c.value}`
            : c.kind === "int"
              ? "整数"
              : "",
      )
      .filter(Boolean)
      .join(" ");
  }
  const map: Record<string, string> = {
    ZodString: "string",
    ZodNumber: "number",
    ZodBoolean: "boolean",
    ZodEnum: "enum",
    ZodObject: "object",
    ZodArray: "array",
    ZodRecord: "object",
    ZodUnion: "union",
  };
  return { type: map[t] ?? t.replace(/^Zod/, "").toLowerCase(), enumValues, constraint };
}

/** 抽 TS 接口/对象字面量里字段的前置注释或行尾注释 */
function extractFieldComments(file: string, anchor: string, stopAt: string): Map<string, string> {
  const src = readFileSync(file, "utf8");
  const s = src.indexOf(anchor);
  if (s < 0) throw new Error(`${file} 里找不到锚点 "${anchor}"——源码结构变了，生成器需同步`);
  const rest = src.slice(s);
  const stop = stopAt ? rest.indexOf(stopAt) : -1;
  const lines = (stop > 0 ? rest.slice(0, stop) : rest).split("\n");
  const out = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s{2,6}([a-zA-Z][a-zA-Z0-9]*)\??:\s*/);
    if (!m) continue;
    const field = m[1];
    if (out.has(field)) continue;
    // 行尾注释优先（短，正好当描述）
    const inline = lines[i].split(/\s\/\/\s*/)[1]?.trim();
    if (inline) {
      out.set(field, inline);
      continue;
    }
    const buf: string[] = [];
    for (let j = i - 1; j >= 0; j--) {
      const p = lines[j].trim();
      if (p.startsWith("/**") || p === "*/" || p.startsWith("*") || p.startsWith("//")) {
        buf.unshift(p.replace(/^\/\*\*|^\*\/$|^\*|^\/\//g, "").replace(/\*\/$/, "").trim());
      } else break;
    }
    const text = buf.filter(Boolean).join(" ").trim();
    if (text) out.set(field, text);
  }
  return out;
}

interface SettingField {
  name: string;
  type: string;
  enumValues: string[];
  constraint: string;
  description: string;
  /** true = schema 未声明、靠 .passthrough() 生效的字段（写了能用，但拼错不报错） */
  passthroughOnly: boolean;
}

/**
 * passthrough 漏项：help.ts 明确列为"支持的配置段"、Config 接口有类型、但 schema 未声明。
 * 这批字段用户写了能生效，漏写进文档 = 文档比实际能力少一截。
 *
 * 白名单显式列出（而不是把 Config 的 95 个一级字段全倒进来）：Config 里大半是
 * 运行时字段（betas / toolsWhitelist / mcpConfigSources 等，注释写着"不落盘"），
 * 它们不是 settings.json 可配项，倒进来会造出"写了也没用"的假字段——比漏写更糟。
 */
const PASSTHROUGH_FIELDS: Array<[string, string]> = [
  ["trace", "object"],
  ["telemetry", "object"],
  ["analytics", "object"],
  ["ide", "object"],
  ["teamMemory", "object"],
  ["sessionRetention", "object"],
  ["checkpoint", "object"],
  ["toolSearch", "union"],
  ["pluginDirs", "array"],
  ["showLineNumbers", "boolean"],
  ["goal", "object"],
];

/**
 * 取 settings 字段。三方合流（§4.5.6 裁决）：
 *   骨架 = SettingsSchema().shape（运行时自省，权威类型/枚举/约束）
 *   补全 = PASSTHROUGH_FIELDS（schema 没声明但用户写了能生效的那批）
 *   描述 = 源码注释（`.describe()` 覆盖率实测 0，只能取注释；Config 的 JSDoc 更全，优先）
 */
async function loadSettingFields(): Promise<SettingField[]> {
  const mod = await import(join(ROOT, "src/config/settings/types.ts"));
  const shape = mod.SettingsSchema().shape as Record<string, any>;

  const schemaComments = extractFieldComments(
    join(ROOT, "src/config/settings/types.ts"),
    "export const SettingsSchema = lazySchema(",
    ".passthrough()",
  );
  const configComments = extractFieldComments(
    join(ROOT, "src/config/config.ts"),
    "export interface Config {",
    "\n}\n",
  );

  const fields: SettingField[] = [];
  for (const name of Object.keys(shape)) {
    const { type, enumValues, constraint } = zodTypeName(shape[name]);
    fields.push({
      name,
      type,
      enumValues,
      constraint,
      description: configComments.get(name) ?? schemaComments.get(name) ?? "",
      passthroughOnly: false,
    });
  }

  for (const [name, type] of PASSTHROUGH_FIELDS) {
    if (shape[name]) continue; // schema 后来补声明了 → 已在上面收录，跳过
    fields.push({
      name,
      type,
      enumValues: [],
      constraint: "",
      description: configComments.get(name) ?? "",
      passthroughOnly: true,
    });
  }

  return fields.sort((a, b) => a.name.localeCompare(b.name));
}

function renderSettingFields(fields: SettingField[]): string {
  const pass = fields.filter((f) => f.passthroughOnly);
  let out = `> 共 **${fields.length}** 个顶层字段。其中 ${fields.length - pass.length} 个由\n`;
  out += `> \`SettingsSchema\` 声明（类型/枚举/约束经运行时自省导出），${pass.length} 个标 ⚠ 的字段\n`;
  out += `> 靠 schema 的 \`.passthrough()\` 生效——**写了能用，但字段名拼错不会报错，只会静默不生效**。\n\n`;
  out += `配置文件位置：\`~/.sid-code/settings.json\`（用户级）、\`.sid-code/settings.json\`（项目级，优先）、\n`;
  out += `\`.sid-code/settings.local.json\`（项目级本地，gitignore，最优先）。\n\n`;
  out += `| 字段 | 类型 | 取值 / 约束 | 说明 |\n|---|---|---|---|\n`;
  for (const f of fields) {
    const values = f.enumValues.length
      ? f.enumValues.map((v) => `\`${v}\``).join(" / ")
      : f.constraint || "—";
    out += `| \`${cell(f.name)}\`${f.passthroughOnly ? " ⚠" : ""} | ${f.type} | ${cell(
      values,
    )} | ${clip(f.description, 120)} |\n`;
  }
  return out;
}

// ============================================================
// 数据源 5：CLI 参数（parseArgs × help.ts 双源交叉对账）
// ============================================================

/**
 * help.ts 里写了但顶层 parseArgs 没声明的 flag —— 合法差异白名单（§4.5.5 实测裁决）。
 * 加白名单必须写理由；理由说不出来的就是真缺陷，应该改代码而不是加白名单。
 */
export const HELP_ONLY_WHITELIST: Record<string, string> = {
  // 可选值语义（`-r` 可不带值开选择器），parseArgs 的 type:"string" 表达不了，
  // 走 src/cli.ts 的 extractResumeArg 预处理
  resume: "可选值语义，走 extractResumeArg 预处理",
  // 取反式 flag，由 allowNegative 生成，不单独声明
  "no-trace": "取反式 flag（allowNegative）",
  // 以下均为子命令级参数，由各子命令自己解析，不进顶层 parseArgs
  diff: "review 子命令参数（src/command/review.ts）",
  timeout: "review 子命令参数（src/command/review.ts）",
  webhook: "daemon 子命令参数（src/command/daemon.ts）",
  interval: "daemon 子命令参数（src/command/daemon.ts）",
  "max-concurrent": "daemon 子命令参数（src/command/daemon.ts）",
  json: "agents / mcp / auth 子命令参数",
  scope: "mcp 子命令参数（src/command/mcp-cli.ts）",
};

/** 顶层 parseArgs 声明了但刻意不写进 --help 的 flag —— 内部出口，不是用户功能 */
export const HIDDEN_FLAGS: Record<string, string> = {
  "dump-tools": "文档生成器内部出口（T-3.2），非用户功能",
};

export interface CliReconcile {
  /** parseArgs 声明的 flag（权威：能不能用） */
  parseArgsFlags: string[];
  /** help.ts 出现的 long flag（素材：怎么描述） */
  helpFlags: string[];
  /** 能用但 help 没写 —— 真实文档缺口，基线应为 0 */
  missingInHelp: string[];
  /** help 写了但顶层没声明、且不在白名单 —— 最坏情况（用户照抄会报错） */
  unknownInHelp: string[];
}

/** 从 src/cli.ts 的 parseArgs options 对象抽 flag 名。用花括号配平定位，不硬编码行号。 */
export function extractParseArgsFlags(cliSrc: string): string[] {
  const anchor = cliSrc.indexOf("const result = parseArgs({");
  if (anchor < 0) throw new Error("src/cli.ts 里找不到 parseArgs({ ——源码结构变了，生成器需同步");
  const optIdx = cliSrc.indexOf("options: {", anchor);
  if (optIdx < 0) throw new Error("src/cli.ts 的 parseArgs 里找不到 options: { ——生成器需同步");
  const open = cliSrc.indexOf("{", optIdx + "options:".length);
  let depth = 0;
  let close = -1;
  for (let j = open; j < cliSrc.length; j++) {
    if (cliSrc[j] === "{") depth++;
    else if (cliSrc[j] === "}") {
      depth--;
      if (depth === 0) {
        close = j;
        break;
      }
    }
  }
  if (close < 0) throw new Error("src/cli.ts 的 parseArgs options 花括号不配平");
  const block = cliSrc.slice(open, close);
  const flags = [
    ...block.matchAll(/(?:^|\n)\s*"?([a-zA-Z][a-zA-Z0-9-]*)"?\s*:\s*\{\s*type:/g),
  ].map((m) => m[1]);
  return [...new Set(flags)].sort();
}

/** 从 help 文本抽出现过的 long flag */
export function extractHelpFlags(helpSrc: string): string[] {
  return [...new Set([...helpSrc.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]))].sort();
}

/** 双源交叉对账（§4.5.5）。导出供 tests/website/gen-reference.test.ts 复用同一实现。 */
export function reconcileCli(cliSrc: string, helpSrc: string): CliReconcile {
  const parseArgsFlags = extractParseArgsFlags(cliSrc);
  const helpFlags = extractHelpFlags(helpSrc);
  const helpSet = new Set(helpFlags);
  const cliSet = new Set(parseArgsFlags);
  return {
    parseArgsFlags,
    helpFlags,
    missingInHelp: parseArgsFlags.filter((f) => !helpSet.has(f) && !(f in HIDDEN_FLAGS)),
    unknownInHelp: helpFlags.filter((f) => !cliSet.has(f) && !(f in HELP_ONLY_WHITELIST)),
  };
}

/** help 文本 → 分组的条目。help.ts 本身就是给人看的分组文本，是好文档素材。 */
interface HelpEntry {
  group: string;
  flags: string;
  desc: string;
}

/** 取 printHelp 的模板字符串正文 */
function helpBody(helpSrc: string): string[] {
  const s = helpSrc.indexOf("console.log(`");
  const e = helpSrc.lastIndexOf("`);");
  if (s < 0 || e < 0) throw new Error("src/help.ts 里找不到 printHelp 的模板字符串——生成器需同步");
  return helpSrc.slice(s + "console.log(`".length, e).split("\n");
}

/** 参数段：段名不在排除表里的，都当参数分组收（新增分组自动进表，不用改生成器） */
const NON_FLAG_SECTIONS = new Set(["用法", "环境变量", "配置文件", "子命令", "示例"]);

function parseHelpFlagSections(helpSrc: string): HelpEntry[] {
  const lines = helpBody(helpSrc);
  const entries: HelpEntry[] = [];
  let group = "";
  let last: HelpEntry | null = null;
  for (const line of lines) {
    const head = line.match(/^(\S.*):\s*$/);
    if (head) {
      group = head[1].trim();
      last = null;
      continue;
    }
    if (!group || NON_FLAG_SECTIONS.has(group)) continue;
    // 形如 "  -m, --model <name>          模型名称"
    const m = line.match(/^ {2}(-{1,2}\S.*?)(?:\s{2,}(.*))?$/);
    if (m) {
      last = { group, flags: m[1].trim(), desc: (m[2] ?? "").trim() };
      entries.push(last);
      continue;
    }
    // 续行：接到上一条描述后
    const cont = line.match(/^\s{6,}(\S.*)$/);
    if (cont && last) last.desc = `${last.desc} ${cont[1].trim()}`.trim();
  }
  return entries;
}

function parseHelpSubcommands(helpSrc: string): HelpEntry[] {
  const lines = helpBody(helpSrc);
  const entries: HelpEntry[] = [];
  let inSection = false;
  let last: HelpEntry | null = null;
  for (const line of lines) {
    const head = line.match(/^(\S.*):\s*$/);
    if (head) {
      inSection = head[1].trim() === "子命令";
      last = null;
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^ {2}([a-z][a-z-]*)\s{2,}(.*)$/);
    if (m) {
      last = { group: "子命令", flags: m[1], desc: m[2].trim() };
      entries.push(last);
      continue;
    }
    const cont = line.match(/^\s{6,}(\S.*)$/);
    if (cont && last) last.desc = `${last.desc} ${cont[1].trim()}`.trim();
  }
  return entries;
}

function renderCli(helpSrc: string, rec: CliReconcile): string {
  const entries = parseHelpFlagSections(helpSrc);
  const subs = parseHelpSubcommands(helpSrc);

  let out = `> 共 **${entries.length}** 个参数条目、**${subs.length}** 个子命令。\n`;
  out += `> 描述取自 \`sid-code --help\`，并与 \`src/cli.ts\` 的 \`parseArgs\` 声明\n`;
  out += `> （**参数能不能用的唯一权威**，共 ${rec.parseArgsFlags.length} 个 flag）交叉对账：\n`;
  out += `> "能用但没写"和"写了但不能用"两类缺陷都会让对账测试失败。\n\n`;

  out += `## 子命令\n\n| 子命令 | 说明 |\n|---|---|\n`;
  for (const s of subs) out += `| \`sid-code ${cell(s.flags)}\` | ${clip(s.desc, 200)} |\n`;

  let group = "";
  for (const e of entries) {
    if (e.group !== group) {
      group = e.group;
      out += `\n## ${group}\n\n| 参数 | 说明 |\n|---|---|\n`;
    }
    out += `| \`${cell(e.flags)}\` | ${clip(e.desc, 200)} |\n`;
  }
  return out;
}

// ============================================================
// 数据源 6：环境变量（help.ts 环境变量段 × 源码 process.env 扫描）
// ============================================================

interface EnvVar {
  group: string;
  name: string;
  desc: string;
}

function parseHelpEnvVars(helpSrc: string): EnvVar[] {
  const lines = helpBody(helpSrc);
  const out: EnvVar[] = [];
  let inSection = false;
  let group = "通用";
  let last: EnvVar | null = null;
  for (const line of lines) {
    const head = line.match(/^(\S.*):\s*$/);
    if (head) {
      inSection = head[1].trim() === "环境变量";
      group = "通用";
      last = null;
      continue;
    }
    if (!inSection) continue;
    // 段内二级分组，形如 "  LLM 配置:"
    const sub = line.match(/^ {2}([^A-Z\s][^:]*|[A-Z][^:]*[一-龥][^:]*):\s*$/);
    if (sub && !/^ {2}[A-Z][A-Z0-9_]*\s/.test(line)) {
      group = sub[1].trim();
      last = null;
      continue;
    }
    const m = line.match(/^ {2}([A-Z][A-Z0-9_]*)\s{2,}(.*)$/);
    if (m) {
      last = { group, name: m[1], desc: m[2].trim() };
      out.push(last);
      continue;
    }
    const cont = line.match(/^\s{6,}(\S.*)$/);
    if (cont && last) last.desc = `${last.desc} ${cont[1].trim()}`.trim();
  }
  return out;
}

/**
 * 扫源码里实际读取的 SID_* / CLAUDE_CODE_* / *_API_KEY 环境变量，与 help 段对账。
 * 只用来算「代码读了但 help 没写」并列在页尾，不当门禁：源码里有大量内部/测试
 * 用途的 env，全要求写进用户文档不合理。
 */
function scanSourceEnvVars(): Set<string> {
  const found = new Set<string>();
  const glob = new Glob("**/*.ts");
  const PREFIX = /^(SID|CLAUDE_CODE|ANTHROPIC|OPENAI)/;
  for (const file of glob.scanSync(join(ROOT, "src"))) {
    const src = readFileSync(join(ROOT, "src", file), "utf8");
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      if (PREFIX.test(m[1])) found.add(m[1]);
    }
    for (const m of src.matchAll(/process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g)) {
      if (PREFIX.test(m[1])) found.add(m[1]);
    }
  }
  return found;
}

function renderEnv(vars: EnvVar[], scanned: Set<string>): string {
  const documented = new Set(vars.map((v) => v.name));
  const undocumented = [...scanned].filter((n) => !documented.has(n)).sort();

  let out = `> 共 **${vars.length}** 个环境变量，取自 \`sid-code --help\` 的环境变量段，\n`;
  out += `> 并与源码里实际的 \`process.env\` 读取点（扫到 ${scanned.size} 个）交叉核对。\n\n`;
  out += `> 优先级：环境变量 > \`settings.json\`。\`SID_*\` 前缀的变量只对 sid-code 生效，\n`;
  out += `> 不与同机的其他工具共享。\n`;

  let group = "";
  for (const v of vars) {
    if (v.group !== group) {
      group = v.group;
      out += `\n## ${group}\n\n| 变量 | 说明 |\n|---|---|\n`;
    }
    out += `| \`${cell(v.name)}\` | ${clip(v.desc, 160)} |\n`;
  }

  if (undocumented.length) {
    out += `\n## 未列入上表的读取点（${undocumented.length}）\n\n`;
    out += `源码里有读取、但未写进 \`--help\` 环境变量段的变量。多为内部/测试用途，`;
    out += `**不保证向后兼容，不建议依赖**：\n\n`;
    out += undocumented.map((n) => `\`${n}\``).join("、") + "\n";
  }
  return out;
}

// ============================================================
// llms.txt（T-3.3b）：全站页面清单 + 每页一行摘要
// ============================================================

function parseFrontmatter(body: string): Record<string, string> {
  if (!body.startsWith("---")) return {};
  const end = body.indexOf("\n---", 3);
  if (end < 0) return {};
  const fm: Record<string, string> = {};
  for (const line of body.slice(4, end).split("\n")) {
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_]*):\s*(.+)$/);
    if (m) fm[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return fm;
}

/** 站内 md → URL 路径（与 cleanUrls: true 一致：无 .html，index 收敛到目录） */
function mdPathToUrl(rel: string): string {
  const noExt = rel.replace(/\.md$/, "");
  return "/" + (noExt === "index" ? "" : noExt.replace(/\/index$/, "/"));
}

interface SitePage {
  url: string;
  title: string;
  description: string;
  section: string;
}

const SECTION_NAMES: Record<string, string> = {
  start: "入门",
  use: "使用",
  extend: "进阶定制",
  ref: "参考（脚本生成）",
  team: "企业与团队",
  "": "站点",
};

function collectSitePages(): SitePage[] {
  const glob = new Glob("**/*.md");
  const pages: SitePage[] = [];
  for (const file of glob.scanSync(WEBSITE)) {
    const rel = file.replace(/\\/g, "/");
    if (rel.startsWith("node_modules/") || rel.startsWith(".vitepress/")) continue;
    const body = readFileSync(join(WEBSITE, rel), "utf8");
    const fm = parseFrontmatter(body);
    const h1 = body.match(/^#\s+(.+)$/m);
    pages.push({
      url: mdPathToUrl(rel),
      title: fm.title || (h1 ? h1[1].trim() : rel),
      description: fm.description || "",
      section: SECTION_NAMES[rel.includes("/") ? rel.split("/")[0] : ""] ?? rel.split("/")[0],
    });
  }
  return pages.sort((a, b) => a.url.localeCompare(b.url));
}

function renderLlmsTxt(pages: SitePage[]): string {
  let out = `# sid-code\n\n`;
  out += `> 跑在终端的 coding agent —— 多 provider 可插拔、功能自主、数据自主。\n\n`;
  out += `本文件是给大模型读的全站索引（共 ${pages.length} 页）。\n`;
  out += `\`/ref/\` 下的参考页由 \`scripts/docs-gen-reference.ts\` 从源码生成，与实现同源。\n\n`;

  const bySection = new Map<string, SitePage[]>();
  for (const p of pages) {
    if (!bySection.has(p.section)) bySection.set(p.section, []);
    bySection.get(p.section)!.push(p);
  }
  for (const [section, ps] of bySection) {
    out += `## ${section}\n\n`;
    for (const p of ps) {
      out += `- [${p.title}](${p.url})${p.description ? `: ${p.description}` : ""}\n`;
    }
    out += `\n`;
  }
  return out;
}

// ============================================================
// --stale：>90 天未复核的指南页（只告警不阻塞，§4.5.3 机制三）
// ============================================================

/**
 * 刻意设计成不阻塞：阻塞会逼人改日期而不是改内容，制造假信号。
 * @param today 基准日（YYYY-MM-DD）。显式传入而非内部取 now，便于测试。
 */
export function findStalePages(
  today: string,
  threshold = 90,
): { stale: Array<{ file: string; last: string; days: number }>; missing: string[]; invalid: string[] } {
  const glob = new Glob("**/*.md");
  const stale: Array<{ file: string; last: string; days: number }> = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  const todayMs = Date.parse(today + "T00:00:00Z");
  for (const file of glob.scanSync(WEBSITE)) {
    const rel = file.replace(/\\/g, "/");
    if (rel.startsWith("node_modules/") || rel.startsWith(".vitepress/")) continue;
    // 参考页由脚本生成、有 --check 兜底，天然不漂移，不需要人工复核
    if (rel.startsWith("ref/") && rel !== "ref/glossary.md") continue;
    const fm = parseFrontmatter(readFileSync(join(WEBSITE, rel), "utf8"));
    if (!fm.lastReviewed) {
      missing.push(rel);
      continue;
    }
    const ms = Date.parse(fm.lastReviewed + "T00:00:00Z");
    if (Number.isNaN(ms)) {
      invalid.push(rel);
      continue;
    }
    const days = Math.floor((todayMs - ms) / 86400000);
    if (days > threshold) stale.push({ file: rel, last: fm.lastReviewed, days });
  }
  stale.sort((a, b) => b.days - a.days);
  return { stale, missing, invalid };
}

function reportStale(today: string): number {
  const { stale, missing, invalid } = findStalePages(today);
  console.log(`docs-gen-reference --stale（基准日 ${today}，阈值 90 天）：`);
  if (missing.length) {
    console.log(`  ${missing.length} 个页面没有 lastReviewed —— 内容写完（阶段 5）后补上即可。`);
  }
  for (const f of invalid) {
    console.log(`  ⚠ ${f}: lastReviewed 格式非法（应为 YYYY-MM-DD）`);
  }
  if (stale.length === 0) {
    console.log(`  ✓ 没有超过 90 天未复核的页面。`);
  } else {
    for (const r of stale) console.log(`  · ${r.file}（${r.last}，${r.days} 天前）`);
  }
  console.log(`  提示：本报告只告警不阻塞——阻塞会逼人改日期而不是改内容。`);
  return 0;
}

// ============================================================
// 写入 / 对账
// ============================================================

interface Page {
  file: string;
  body: string;
}

/** 用 AUTO-GEN 标记替换目标文件的自动区，保留标记外的人工内容 */
export function spliceAutoGen(current: string, generated: string, file: string): string {
  const s = current.indexOf(START);
  // END 必须从 START 之后找：各参考页的「请勿手工编辑」提示语里就**字面写着**
  // `<!-- AUTO-GEN:END -->`（那是给人看的说明文字，位置在真标记之前）。
  // 用裸 indexOf(END) 会命中提示语里那个、拿到比 START 更小的下标，
  // splice 出来的文件会把提示语后半段和正文一起吃掉。
  const e = s < 0 ? -1 : current.indexOf(END, s + START.length);
  if (s < 0 || e < 0) {
    throw new Error(
      `${file} 缺少 AUTO-GEN 标记对——无法确定自动区边界。` +
        `请恢复标记（骨架见 website/.vitepress/scaffold-pages.ts）`,
    );
  }
  return current.slice(0, s) + START + "\n\n" + generated + "\n" + current.slice(e);
}

async function build(): Promise<{ pages: Page[]; llms: Page; rec: CliReconcile }> {
  const cliSrc = readFileSync(join(ROOT, "src/cli.ts"), "utf8");
  const helpSrc = readFileSync(join(ROOT, "src/help.ts"), "utf8");

  const tools = loadTools();
  const [slash, hooks, settings] = await Promise.all([
    loadSlashCommands(),
    loadHookEvents(),
    loadSettingFields(),
  ]);
  const rec = reconcileCli(cliSrc, helpSrc);

  const pages: Page[] = [
    { file: join(REF, "tools.md"), body: renderTools(tools) },
    { file: join(REF, "slash-commands.md"), body: renderSlashCommands(slash) },
    { file: join(REF, "hooks.md"), body: renderHookEvents(hooks) },
    { file: join(REF, "settings.md"), body: renderSettingFields(settings) },
    { file: join(REF, "cli.md"), body: renderCli(helpSrc, rec) },
    { file: join(REF, "env.md"), body: renderEnv(parseHelpEnvVars(helpSrc), scanSourceEnvVars()) },
  ];

  const llms: Page = {
    file: join(WEBSITE, "public/llms.txt"),
    body: renderLlmsTxt(collectSitePages()),
  };

  return { pages, llms, rec };
}

async function main(): Promise<void> {
  if (STALE) {
    // 基准日走 git 的提交日期而非 new Date()：脚本在 pre-commit 里跑，
    // 用当次提交日期作基准可复现（同一 commit 重跑结论一致）。取不到则回退系统日期。
    const proc = Bun.spawnSync(["git", "log", "-1", "--format=%cs"], { cwd: ROOT, stdout: "pipe" });
    const gitDate = proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
    const today = /^\d{4}-\d{2}-\d{2}$/.test(gitDate)
      ? gitDate
      : new Date().toISOString().slice(0, 10);
    process.exit(reportStale(today));
  }

  const { pages, llms, rec } = await build();

  // ── 对账诊断：两类真缺陷（§4.5.5）。写入模式也报，让人当场看到。──
  if (rec.missingInHelp.length) {
    console.error(
      `✘ 对账失败：以下 flag 在 src/cli.ts 的 parseArgs 里声明了（能用），` +
        `但 src/help.ts 没写（文档漏写）：${rec.missingInHelp.map((f) => "--" + f).join(" ")}`,
    );
  }
  if (rec.unknownInHelp.length) {
    console.error(
      `✘ 对账失败：以下 flag 在 src/help.ts 写了，但顶层 parseArgs 没声明、也不在白名单——` +
        `用户照抄会报"未知选项"：${rec.unknownInHelp.map((f) => "--" + f).join(" ")}`,
    );
  }
  const reconcileFailed = rec.missingInHelp.length > 0 || rec.unknownInHelp.length > 0;

  const drift: string[] = [];
  for (const p of [...pages, llms]) {
    const isLlms = p.file === llms.file;
    const cur = existsSync(p.file) ? readFileSync(p.file, "utf8") : "";
    const next = isLlms ? p.body : spliceAutoGen(cur, p.body, p.file);
    const rel = p.file.slice(ROOT.length + 1);

    if (CHECK) {
      if (cur !== next) drift.push(rel);
    } else if (cur !== next) {
      writeFileSync(p.file, next);
      console.log(`  ✓ 已更新 ${rel}`);
    }
  }

  if (CHECK) {
    if (drift.length) {
      console.error(
        `✘ 参考页与源码不一致（${drift.length} 个文件）：\n` +
          drift.map((f) => `    ${f}`).join("\n") +
          `\n  源码改了但参考页没跟着改。跑 \`bun run docs:gen-reference\` 重新生成后再提交。`,
      );
    }
    if (drift.length || reconcileFailed) process.exit(1);
    console.log("✓ docs-gen-reference --check：参考页与源码一致，CLI 双源对账通过。");
    process.exit(0);
  }

  console.log(
    `docs-gen-reference：6 页参考文档 + llms.txt 已生成（源码为唯一真源，勿手改 AUTO-GEN 区）。`,
  );
  if (reconcileFailed) process.exit(1);
}

// 作为脚本直接运行时才执行 main（被测试 import 时只取上面导出的纯函数）
if (import.meta.main) {
  await main();
}
