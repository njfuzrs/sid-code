#!/usr/bin/env bun
/**
 * 命令体系三道机械门禁（P3 + G3）。
 *
 * ## 为什么需要它
 *
 * 本次修的七条缺陷里有**三条是同一个形态**：代码在、调用为零，而没有任何东西会报警。
 *
 *   - `immediate`：27 处声明 / 0 处生产读取，字段是纯装饰（P0-2）
 *   - `isFilePath`：定义在 parser.ts，全仓零调用，连测试都没有（P1-1）
 *   - `InputRouter` + `CommandQueue` + `QueueProcessor` + `useQueueProcessor`：
 *     246 行零引用，**而且 queue.ts 还有一个跑得好好的绿测试**（P2-1）
 *
 * 最后那条是关键教训：**测试覆盖率把它算成"已覆盖"，而那个类在生产路径上
 * 一次都不会被实例化。** 测试证明的是"这段代码能工作"，不是"这段代码在工作"。
 * 所以靠 `bun test` 绿是发现不了这类问题的，必须有一道单独数**生产调用点**的门禁。
 *
 * ## 两道门禁
 *
 * ### G1 —— 命令体系导出零生产调用（死代码棘轮）
 *
 * 扫 `packages/cli/src/command/` 下每个导出符号，数它在**生产代码**里的引用数
 * （排除：定义自身、测试、类型定义文件）。零引用的进"死导出"清单。
 *
 * 用**棘轮**而非"必须为 0"：首次接入一定会报出一批存量（实测见 BASELINE），
 * 硬卡会被直接 `--no-verify` 绕过或干脆关掉，那就退化成第二个「防线全在、调用全 0」。
 * 棘轮只禁止**新增**，允许存量慢慢清 —— 数字只能降不能升。
 *
 * ### G2 —— 旧命令体系只允许缩小（防倒退）
 *
 * 命令体系迁移未完成：新体系 30 个命令目录，旧体系 `builtins.ts` 仍有 35 条
 * `registry.register`，`adapter.ts` 自己写着"最终移除本文件"。
 * 但**没有任何东西阻止往 builtins.ts 再加一条新命令**。
 *
 * 渐进迁移最大的风险不是慢，是**边迁边往旧体系加新东西，永远迁不完**。
 * 所以这道门禁只有一句话：那个条数只允许减少。
 *
 * ### G3 —— 门控字段「声明-消费配对」+ 补全链路逐跳（硬门禁，无基线）
 *
 * G1 数的是**导出符号**有没有人调，看不见「字段声明了但没人读」：
 * `disableModelInvocation` 曾在 26 个命令目录里声明、命令体系内 0 处读取（D11）；
 * `argumentHint` 则是「有人读，但链路中段被丢」—— loadCommandList 的 .map() 漏搬，
 * 行内补全永远拿不到它，而 `/commands` 面板那一处读取让字段级计数看起来是活的（D10）。
 * 所以 G3 分两层：
 *
 *   - **G3a 配对**：对 UnifiedCommand 的每个门控字段，声明数 > 0 而消费数 = 0 → 违规。
 *     消费只数 `x.field` 形态的读取，**不数 `field: x.field` 这种纯透传**——
 *     透传搬得再勤也不改变任何行为，算进去就是 P0-2 `immediate` 的原始形态又被放行。
 *   - **G3b 逐跳**：行内补全需要的字段，链路上每一跳文件都必须在代码（非注释）里出现它。
 *     字段级配对拦不住「读了但半路丢了」，只有按跳检查才拦得住（§17.3 的诚实结论）。
 *
 * 不用棘轮：接入时实测违规为 0，硬卡没有存量要豁免。
 *
 * ## 用法
 *
 *   bun run scripts/command-system-gate.ts            # 校验（超基线则退 1）
 *   bun run scripts/command-system-gate.ts --report    # 只打印现状，不判定
 *   bun run scripts/command-system-gate.ts --update-baseline  # 清理后收紧棘轮
 *
 * ⚠️ `--update-baseline` **只允许收紧**（新值必须 ≤ 旧值）。若允许放宽，
 * 棘轮就成了摆设 —— 加一条死代码顺手把基线调高，门禁全程绿。
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const COMMAND_DIR = join(ROOT, "packages/cli/src/command");
const BUILTINS = join(ROOT, "packages/cli/src/command/builtins.ts");
const BASELINE_PATH = join(import.meta.dir, "command-system-gate.baseline.json");

/**
 * 不参与 G1 死导出扫描的文件。每条都必须写明理由 —— 否则这份名单会变成
 * "把报错的文件加进来就绿了"的垃圾桶，门禁随之失效。
 */
const G1_EXEMPT_FILES = [
  // 纯类型定义：类型导出被 `import type` 消费，形态与函数调用不同，
  // 单独扫会产出大量假阳性（类型在 .d 位置被用，grep 命名口径对不上）。
  "types.ts",
  // 命令自身的 index.ts：它们由 loaders.ts 按目录约定动态加载（非静态 import），
  // 静态引用数天然为 0，扫它们等于把全部 30 条命令报成死代码。
  "/commands/",
];

/**
 * G1 豁免的具体符号（连同理由）。
 *
 * ⚠️ **刻意保持为空。** 这份名单的存在是为了让"确实需要豁免"的情形有个带理由的
 * 落点，不是为了让报错消失 —— 往里加一条就少一条被门禁看住的代码。
 * 本次修复时曾想把新写的 `StreamingGateCommand` / `extractCommandName` 加进来，
 * 最后改成**不导出它们**：没有外部消费者的符号本就不该 export，
 * 豁免自己刚添的符号等于第一天就开始糊门禁。
 */
const G1_EXEMPT_SYMBOLS = new Map<string, string>([]);

interface Baseline {
  /** G1：命令体系里零生产调用的导出数量上限 */
  deadExports: number;
  /** G2：builtins.ts 里 registry.register 的条数上限 */
  legacyBuiltins: number;
  /** 记录基线是怎么来的，便于下一个人判断能不能动 */
  note: string;
}

function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

/** 递归列出目录下所有 .ts / .tsx 文件（仓库相对路径）。 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    out.push(relative(ROOT, full));
  }
  return out;
}

/** 提取一个文件里的顶层导出符号名。 */
export function extractExportedSymbols(source: string): string[] {
  const names = new Set<string>();
  // export function foo / export async function foo / export class Foo
  // export const foo / export interface Foo / export type Foo
  const re =
    /^export\s+(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of source.matchAll(re)) names.add(m[1]);
  return [...names];
}

function isExemptFile(relPath: string): boolean {
  return G1_EXEMPT_FILES.some((frag) => relPath.includes(frag));
}

/**
 * 数一个符号在生产代码里的引用数（不含定义所在文件本身、不含测试）。
 *
 * 刻意用**全仓源码扫描**而不是 grep 子进程：
 * 口径要能在测试里被直接调用与变异自证，外挂 grep 做不到。
 */
export function countProductionReferences(
  symbol: string,
  definedIn: string,
  files: Array<{ path: string; source: string }>,
): number {
  // \b 边界避免 `immediate` 命中 `immediatePropagation`
  const re = new RegExp(`\\b${symbol.replace(/[$]/g, "\\$")}\\b`);
  let count = 0;
  for (const f of files) {
    if (f.path === definedIn) continue;
    if (f.path.includes(".test.")) continue;
    // 注释行不算引用 —— 「注释描述的是意图，不是行为」，本次三条缺陷都栽在这上面。
    for (const line of f.source.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (re.test(line)) {
        count++;
        break;
      }
    }
  }
  return count;
}

export interface DeadExport {
  symbol: string;
  file: string;
}

/** G1：找出命令体系里零生产调用的导出。 */
export function findDeadExports(): DeadExport[] {
  const commandFiles = listSourceFiles(COMMAND_DIR);
  // 引用可能出现在 cli 包任何角落（含 ui/），所以扫描面是整个 cli + core 的 src。
  const all = [
    ...listSourceFiles(join(ROOT, "packages/cli/src")),
    ...listSourceFiles(join(ROOT, "packages/core/src")),
  ];
  const sources = all.map((p) => ({ path: p, source: readFileSync(join(ROOT, p), "utf8") }));

  const dead: DeadExport[] = [];
  for (const file of commandFiles) {
    if (isExemptFile(file)) continue;
    const src = readFileSync(join(ROOT, file), "utf8");
    for (const symbol of extractExportedSymbols(src)) {
      if (G1_EXEMPT_SYMBOLS.has(symbol)) continue;
      if (countProductionReferences(symbol, file, sources) === 0) {
        dead.push({ symbol, file });
      }
    }
  }
  return dead;
}

/** G2：数 builtins.ts 里的 registry.register 条数。 */
export function countLegacyBuiltins(): number {
  const src = readFileSync(BUILTINS, "utf8");
  return (src.match(/registry\.register/g) ?? []).length;
}

// ============================================================
// G3：门控字段声明-消费配对 + 补全链路逐跳
// ============================================================

/** UnifiedCommand 的门控 / 展示字段（core/src/command-contract/types.ts CommandBase）。 */
export const G3_GATE_FIELDS = [
  "immediate",
  "isHidden",
  "userInvocable",
  "requiresArgs",
  "disableModelInvocation",
  "whenToUse",
  "argumentHint",
] as const;

/**
 * 「消费 UnifiedCommand」的 UI / 宿主文件。不扫整个 ui/：SkillsDialog 读的是
 * SkillDefinition 的同名字段（skill 侧确有模型调用路径），算进来会让内置命令上的
 * 空声明被 skill 侧的读取「顶」成活的 —— D11 正是这么藏住的。
 */
const G3_UI_CONSUMERS = [
  "packages/cli/src/app.ts",
  "packages/cli/src/ui/App.tsx",
  "packages/cli/src/ui/InputArea.tsx",
  "packages/cli/src/ui/hooks/useSlashCompletion.ts",
  "packages/cli/src/ui/components/SuggestionsDisplay.tsx",
  "packages/cli/src/ui/components/CommandsDialog.tsx",
];

/**
 * 行内补全链路（UnifiedCommand → 屏幕）的每一跳，按字段列。
 * requiresArgs 决定回车回填，argumentHint 告诉用户该填什么——同一个交互的两半（§14.3）。
 *
 * 每一跳要求的是**值层面的读取**（`x.field`），类型声明 `field?: string;` 不算：
 * 变异自证时实测过，只删 completion-list.ts 的透传、留着接口里的字段声明，
 * 「文件里出现过该字段」这种判据照样绿——那正是 D10 的原始形态。
 * TUIState（App.tsx）只是类型、不搬值，所以不在链上；它的缺失由 tsc 之外的
 * 端到端断言（cli/tests/command/argument-hint-chain.test.tsx）兜。
 */
export const G3_COMPLETION_CHAIN: Readonly<Record<string, readonly string[]>> = {
  requiresArgs: [
    "packages/cli/src/command/completion-list.ts", // UnifiedCommand → TUIState.commands
    "packages/cli/src/command/suggestions.ts", // RankableCommandInfo → RankedCommandSuggestion
    "packages/cli/src/ui/hooks/useSlashCompletion.ts", // → Suggestion
    "packages/cli/src/ui/InputArea.tsx", // 回车：回填还是执行
  ],
  argumentHint: [
    "packages/cli/src/command/completion-list.ts",
    "packages/cli/src/command/suggestions.ts",
    "packages/cli/src/ui/hooks/useSlashCompletion.ts",
    "packages/cli/src/ui/components/SuggestionsDisplay.tsx", // 渲染
  ],
};

export interface SourceFile {
  path: string;
  source: string;
}

function codeLines(source: string): string[] {
  return source.split("\n").filter((line) => {
    const t = line.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  });
}

/** 数字段的声明次数（`field:` 赋值，非注释行）。 */
export function countFieldDeclarations(field: string, files: SourceFile[]): number {
  const re = new RegExp(`\\b${field}\\s*:`, "g");
  let n = 0;
  for (const f of files) for (const line of codeLines(f.source)) n += (line.match(re) ?? []).length;
  return n;
}

/** 数字段的消费次数：`x.field` 读取，排除 `field: x.field` 纯透传。 */
export function countFieldConsumers(field: string, files: SourceFile[]): number {
  const read = new RegExp(`\\.${field}\\b`);
  const passthrough = new RegExp(`\\b${field}\\s*:\\s*[\\w$.]+\\.${field}\\b`);
  let n = 0;
  for (const f of files) {
    if (f.path.includes(".test.")) continue;
    for (const line of codeLines(f.source)) {
      if (read.test(line) && !passthrough.test(line)) n++;
    }
  }
  return n;
}

export interface UnconsumedField {
  field: string;
  declared: number;
  consumed: number;
}

/** G3a：声明 > 0 且消费 = 0 的字段。 */
export function findUnconsumedFields(
  declFiles: SourceFile[],
  consumerFiles: SourceFile[],
): UnconsumedField[] {
  const out: UnconsumedField[] = [];
  for (const field of G3_GATE_FIELDS) {
    const declared = countFieldDeclarations(field, declFiles);
    if (declared === 0) continue;
    const consumed = countFieldConsumers(field, consumerFiles);
    if (consumed === 0) out.push({ field, declared, consumed });
  }
  return out;
}

export interface ChainBreak {
  field: string;
  file: string;
}

/** G3b：链路上没有值层面读取该字段（`x.field`，非注释代码）的那一跳。 */
export function findChainBreaks(
  chain: Readonly<Record<string, readonly string[]>>,
  files: SourceFile[],
): ChainBreak[] {
  const byPath = new Map(files.map((f) => [f.path, f.source]));
  const out: ChainBreak[] = [];
  for (const [field, hops] of Object.entries(chain)) {
    const re = new RegExp(`\\.${field}\\b`);
    for (const hop of hops) {
      const src = byPath.get(hop) ?? "";
      if (!codeLines(src).some((l) => re.test(l))) out.push({ field, file: hop });
    }
  }
  return out;
}

function readSource(path: string): SourceFile {
  return { path, source: readFileSync(join(ROOT, path), "utf8") };
}

/** 收集 G3 的三组真实源码（测试里用它做变异自证）。 */
export function collectG3Sources(): {
  decl: SourceFile[];
  consumers: SourceFile[];
  chain: SourceFile[];
} {
  const commandFiles = listSourceFiles(COMMAND_DIR);
  // 声明面：新体系命令定义 + legacy 门控表（loaders.ts 的 LEGACY_BUILTIN_GATES）
  const decl = commandFiles
    .filter((p) => /\/commands\/[^/]+\/index\.ts$/.test(p) || p.endsWith("command/loaders.ts"))
    .map(readSource);
  // 消费面：命令体系本身（不含命令定义与类型文件）+ 消费 UnifiedCommand 的 UI / 宿主
  const consumers = [
    ...commandFiles.filter((p) => !p.includes("/commands/") && !p.endsWith("/types.ts")),
    ...G3_UI_CONSUMERS,
  ].map(readSource);
  const chain = [...new Set(Object.values(G3_COMPLETION_CHAIN).flat())].map(readSource);
  return { decl, consumers, chain };
}

function main(): void {
  const args = process.argv.slice(2);
  const report = args.includes("--report");
  const update = args.includes("--update-baseline");

  const dead = findDeadExports();
  const legacy = countLegacyBuiltins();
  const baseline = readBaseline();

  console.log("命令体系门禁");
  console.log(`  G1 死导出（零生产调用）: ${dead.length}  基线 ${baseline.deadExports}`);
  console.log(`  G2 旧体系 registry.register: ${legacy}  基线 ${baseline.legacyBuiltins}`);
  const g3 = collectG3Sources();
  const unconsumed = findUnconsumedFields(g3.decl, g3.consumers);
  const breaks = findChainBreaks(G3_COMPLETION_CHAIN, g3.chain);
  console.log(`  G3a 门控字段声明无消费: ${unconsumed.length}  （硬门禁，须为 0）`);
  console.log(`  G3b 补全链路断跳: ${breaks.length}  （硬门禁，须为 0）`);
  for (const u of unconsumed) console.log(`    - ${u.field}：声明 ${u.declared} / 消费 0`);
  for (const b of breaks) console.log(`    - ${b.field} 在 ${b.file} 断了`);
  if (dead.length > 0) {
    console.log("\n  死导出清单:");
    for (const d of dead) console.log(`    - ${d.symbol}  (${d.file})`);
  }

  if (update) {
    if (dead.length > baseline.deadExports || legacy > baseline.legacyBuiltins) {
      console.error("\n✗ --update-baseline 只允许收紧（新值必须 ≤ 旧值）。");
      console.error("  放宽基线等于取消门禁：加一条死代码顺手调高数字，全程绿。");
      process.exit(1);
    }
    const next: Baseline = {
      deadExports: dead.length,
      legacyBuiltins: legacy,
      note: baseline.note,
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n");
    console.log("\n✓ 基线已收紧。");
    return;
  }

  if (report) return;

  let failed = false;
  if (dead.length > baseline.deadExports) {
    console.error(
      `\n✗ G1：死导出从 ${baseline.deadExports} 增至 ${dead.length}。` +
        `\n  新增了零生产调用的导出 —— 要么接线，要么删掉，不要留着骗下一个人。` +
        `\n  （清理后跑 --update-baseline 收紧基线。）`,
    );
    failed = true;
  }
  if (legacy > baseline.legacyBuiltins) {
    console.error(
      `\n✗ G2：旧体系命令从 ${baseline.legacyBuiltins} 增至 ${legacy}。` +
        `\n  新命令请加到 packages/cli/src/command/commands/<name>/ 新体系。` +
        `\n  边迁边往旧体系加新东西 = 永远迁不完。`,
    );
    failed = true;
  }
  if (unconsumed.length > 0) {
    console.error(
      `\n✗ G3a：${unconsumed.map((u) => u.field).join(", ")} 有声明、无消费。` +
        `\n  字段写了不生效 = 教下一个人照抄一个假开关（D11）。要么接线，要么删掉声明。`,
    );
    failed = true;
  }
  if (breaks.length > 0) {
    console.error(
      `\n✗ G3b：补全链路断跳 —— ${breaks.map((b) => `${b.field}@${b.file}`).join(", ")}。` +
        `\n  链路中段漏搬一个字段，前半段的注释会让人以为整条是通的（D10）。`,
    );
    failed = true;
  }
  if (failed) process.exit(1);
  console.log("\n✓ 三道门禁通过。");
}

if (import.meta.main) main();
