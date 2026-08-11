/**
 * Claude Code -> sid-code 迁移端对端测试
 *
 * 目的：验证迁移「准不准」。分三段：
 *   A. 造一个隔离的完整 Claude Code 配置夹具（覆盖各分类分支）。
 *   B. 跑 inspector --format json，逐项断言分类正确（compatibleInPlace / migratable /
 *      needsDecision / conflicts / reportOnly / unsupported / alreadyMigrated，以及
 *      transport 推导、hooks 展开统计、memory 双 sanitize 目标路径）。
 *   C. 按 references/mapping.md 执行真正的迁移转换（MCP type->transport、hooks 结构展开、
 *      memory 双 sanitize 复制、settings patch 合并），把产物用 sid-code 的**真实加载器**
 *      验证能加载：SettingsSchema(Zod) / mergeMcpConfigs / SkillLoader / CustomCommandLoader /
 *      CustomAgentLoader / loadAllOutputStyles。
 *
 * 全程隔离在临时目录（HOME + SID_CONFIG_DIR + CLAUDE_CONFIG_DIR），不碰真实 ~/.claude 或 ~/.sid-code。
 *
 * 用法：bun run scripts/e2e-claude-migration.ts
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const REPO = dirname(import.meta.dir); // scripts/ 的上一级
const INSPECTOR = join(REPO, "packages/core/src/skill/builtin/claude-code-migration/scripts/inspect-migration.mjs");

// ─── 断言工具 ───
let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(title: string) { console.log(`\n── ${title} ──`); }

// ─── 隔离夹具根 ───
const ROOT = join(tmpdir(), `cc-mig-e2e-${process.pid}`);
const HOME = ROOT;                              // os.homedir() 读 HOME（output-styles 用）
const CLAUDE = join(ROOT, ".claude");           // Claude Code 用户配置
const SID = join(ROOT, ".sid-code");            // sid-code 用户配置（迁移目标）
const PROJECT = join(ROOT, "workspace", "demo-proj");
const PROJ_CLAUDE = join(PROJECT, ".claude");
const PROJ_SID = join(PROJECT, ".sid-code");

function w(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}
function j(path: string, obj: unknown) { w(path, JSON.stringify(obj, null, 2)); }

function buildFixture() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  // 让项目成为 git 仓库根（memory/项目匹配依赖 .git）
  mkdirSync(join(PROJECT, ".git"), { recursive: true });

  // ── 用户级 Claude settings：覆盖 permissions / hooks / mcpServers / env / model /
  //    enabledPlugins / outputStyle / 空值 / 未知字段 ──
  j(join(CLAUDE, "settings.json"), {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    permissions: { allow: ["Bash(ls:*)"], deny: ["Read(./secrets/**)"] },
    env: { ANTHROPIC_AUTH_TOKEN: "sk-xxx", TAVILY_API_KEY: "tvly-xxx", MY_FLAG: "1" },
    model: "claude-sonnet-4",
    outputStyle: "concise",
    enabledPlugins: { "some-marketplace": ["plugin-a@1.0.0"] },
    extraKnownMarketplaces: { "some-marketplace": { source: { source: "github", repo: "x/y" } } },
    hooks: {
      PreToolUse: [
        {
          matcher: "Write",
          hooks: [
            { type: "command", command: "echo pre $CLAUDE_PROJECT_DIR", timeout: 5 },
            { type: "command", command: "python3 ~/.claude/hooks/check.py" },
          ],
        },
      ],
      SessionStart: [
        { hooks: [{ type: "command", command: "echo start" }] },
      ],
    },
    mcpServers: {
      "user-stdio": { type: "stdio", command: "npx", args: ["-y", "srv"], env: { K: "v" } },
    },
    emptyObj: {},
    emptyArr: [],
    someUnknownField: { a: 1 },
  });

  // ── 用户级 ~/.claude.json：顶层 mcpServers + 当前项目条目的 mcpServers ──
  j(join(ROOT, ".claude.json"), {
    mcpServers: {
      "http-srv": { type: "http", url: "https://example.com/mcp" },
      "sse-srv": { type: "sse", url: "https://example.com/sse" },
      "notype-cmd": { command: "mytool", args: ["--serve"] }, // 无 type，应推 stdio
      "notype-url": { url: "wss://example.com/ws" },           // 无 type 有 url，应推 http
    },
    projects: {
      [PROJECT]: {
        mcpServers: {
          "proj-local-srv": { type: "stdio", command: "proj-tool" },
        },
      },
    },
  });

  // ── 项目共享 settings：mcpServers（应去 .mcp.json）+ permissions ──
  j(join(PROJ_CLAUDE, "settings.json"), {
    permissions: { allow: ["Bash(git:*)"] },
    mcpServers: { "shared-srv": { type: "stdio", command: "shared-tool" } },
  });

  // ── 项目本地 settings ──
  j(join(PROJ_CLAUDE, "settings.local.json"), {
    permissions: { allow: ["Bash(npm:*)"] },
  });

  // ── 项目根已有 .mcp.json（compatibleInPlace，不迁移）──
  j(join(PROJECT, ".mcp.json"), {
    mcpServers: { "inplace-srv": { transport: "stdio", command: "inplace-tool" } },
  });

  // ── commands / skills / agents / output-styles（用户级 + 项目级）──
  w(join(CLAUDE, "commands", "greet.md"), "---\ndescription: say hi\n---\nHello $ARGUMENTS");
  w(join(CLAUDE, "commands", ".hidden.md"), "should be ignored"); // 点前缀应被忽略
  mkdirSync(join(CLAUDE, "commands", ".git"), { recursive: true }); // .git 应被忽略
  w(join(CLAUDE, "commands", ".git", "HEAD"), "ref: x");
  w(join(PROJ_CLAUDE, "commands", "build.md"), "---\ndescription: build it\n---\nRun build");

  w(join(CLAUDE, "skills", "helper", "SKILL.md"),
    "---\nname: helper\ndescription: a helper skill\n---\nDo helpful things.");
  w(join(PROJ_CLAUDE, "skills", "proj-skill", "SKILL.md"),
    "---\nname: proj-skill\ndescription: project skill\n---\nProject-specific.");

  w(join(CLAUDE, "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: reviews code\ntools: read, grep\n---\nReview carefully.");

  w(join(CLAUDE, "output-styles", "concise.md"),
    "---\nname: concise\ndescription: terse replies\n---\nBe terse.");

  // ── 记忆/规则：compatibleInPlace（sid-code 原生读 .claude）──
  w(join(CLAUDE, "CLAUDE.md"), "# 全局记忆\n用中文。");
  w(join(PROJECT, "CLAUDE.md"), "# 项目记忆\n遵守项目规范。");
  w(join(PROJECT, "CLAUDE.local.md"), "# 本地记忆\n私有。");
  w(join(PROJ_CLAUDE, "rules", "style.md"), "# 风格规则\n两空格缩进。");

  // ── 项目 auto-memory（源用 Claude sanitize 规则算目录名）──
  const ccProjId = sanitizeClaudeProjectId(PROJECT);
  const memDir = join(CLAUDE, "projects", ccProjId, "memory");
  w(join(memDir, "MEMORY.md"), "# 记忆索引\n- [[topic-a]]");
  w(join(memDir, "topic-a.md"), "记忆内容 A（可能含隐私）");
  w(join(memDir, "team", "shared.md"), "团队记忆");

  // ── keybindings（reportOnly）──
  j(join(CLAUDE, "keybindings.json"), { "ctrl+k": "clear" });
}

// 源侧 sanitize（复刻 Claude Code；与 inspector 内一致）
function sanitizeClaudeProjectId(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9]/g, "-");
  return s.length <= 200 ? s : s.slice(0, 200);
}
// 目标侧 sanitize（复刻 sid-code sanitizeProjectKey）
function sanitizeSidProjectKey(raw: string): string {
  const c = raw
    .replace(/^[\\/]+|[\\/]+$/g, "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return c || "default";
}

function runInspector(extraArgs: string[] = []): any {
  // 不设 CLAUDE_CONFIG_DIR：让 --home 驱动 ~/.claude 与 ~/.claude.json 的解析，
  // 复刻真实机器布局（.claude.json 位于 $HOME/.claude.json，是 .claude/ 的同级）。
  const env: Record<string, string> = { ...process.env, SID_CONFIG_DIR: SID };
  delete env.CLAUDE_CONFIG_DIR;
  const out = execFileSync(
    "node",
    [INSPECTOR, "--project", PROJECT, "--home", HOME, "--format", "json", ...extraArgs],
    { encoding: "utf8", env },
  );
  return JSON.parse(out);
}

// 便捷查找
const has = (arr: any[], pred: (x: any) => boolean) => arr.some(pred);
const find = (arr: any[], pred: (x: any) => boolean) => arr.find(pred);

function assertInspectorClassification(plan: any) {
  section("B. inspector 分类断言");

  // compatibleInPlace：项目根 .mcp.json 的 server + 各记忆/规则文件
  check("inplace: 项目 .mcp.json server", has(plan.compatibleInPlace, x => x.server === "inplace-srv"));
  check("inplace: 用户 CLAUDE.md", has(plan.compatibleInPlace, x => (x.source || "").endsWith("/.claude/CLAUDE.md")));
  check("inplace: 项目 CLAUDE.md", has(plan.compatibleInPlace, x => x.source === join(PROJECT, "CLAUDE.md")));
  check("inplace: 项目 CLAUDE.local.md", has(plan.compatibleInPlace, x => x.source === join(PROJECT, "CLAUDE.local.md")));
  check("inplace: 项目 .claude/rules 目录", has(plan.compatibleInPlace, x => x.source === join(PROJ_CLAUDE, "rules")));

  // MCP transport 推导
  const mcp = (name: string) => find(plan.needsDecision, x => x.server === name);
  check("mcp user-stdio -> stdio", mcp("user-stdio")?.transport === "stdio", JSON.stringify(mcp("user-stdio")?.transport));
  check("mcp http-srv -> http", mcp("http-srv")?.transport === "http");
  check("mcp sse-srv -> sse", mcp("sse-srv")?.transport === "sse");
  check("mcp notype-cmd -> stdio(推导)", mcp("notype-cmd")?.transport === "stdio");
  check("mcp notype-url -> http(推导)", mcp("notype-url")?.transport === "http");
  check("mcp proj-local-srv -> stdio", mcp("proj-local-srv")?.transport === "stdio");
  check("mcp shared-srv 目标为 .mcp.json", mcp("shared-srv")?.target?.includes(".mcp.json"),
    JSON.stringify(mcp("shared-srv")?.target));
  // transforms 里含 type->transport 提示
  check("mcp transforms 提示 type->transport", (mcp("user-stdio")?.transforms || []).some((t: string) => t.includes("transport")));
  // env/headers 敏感标记
  check("mcp user-stdio env 敏感", (mcp("user-stdio")?.sensitive || []).includes("env"));

  // settings 字段
  const nd = (field: string, tgtIncludes: string) =>
    find(plan.needsDecision, x => x.path === field && (x.target || "").includes(tgtIncludes));
  check("permissions(用户级)需确认", !!nd("permissions", ".sid-code/settings.json"));
  check("hooks(用户级)需确认", !!nd("hooks", ".sid-code/settings.json"));
  check("outputStyle(用户级)需确认", !!nd("outputStyle", ".sid-code/settings.json"));
  check("env(用户级)需确认+敏感", (nd("env", ".sid-code/settings.json")?.sensitive || []).includes("env"));
  // env 只列 key 名，不含值
  const envItem = nd("env", ".sid-code/settings.json");
  check("env 只列 key 名", Array.isArray(envItem?.envKeys) && envItem.envKeys.includes("ANTHROPIC_AUTH_TOKEN"));
  check("env 不泄漏 value", JSON.stringify(envItem || {}).indexOf("sk-xxx") === -1);

  // hooks 展开统计：PreToolUse 2 条内层 + SessionStart 1 条 = 3 条 flatEntries，2 事件
  const hookItem = nd("hooks", ".sid-code/settings.json");
  check("hooks 事件数=2", hookItem?.hookShape?.events === 2, JSON.stringify(hookItem?.hookShape));
  check("hooks 展开=3 条", hookItem?.hookShape?.flatEntries === 3, JSON.stringify(hookItem?.hookShape));
  check("hooks 检出 CLAUDE_/claude 引用", (hookItem?.hookShape?.claudeTokenHits || 0) >= 1);

  // 项目级 permissions
  check("permissions(项目共享)需确认", !!find(plan.needsDecision, x => x.path === "permissions" && (x.target || "").includes(".sid-code/settings.json") && x.sourceScope === "project"));
  check("permissions(项目本地)需确认", !!find(plan.needsDecision, x => x.path === "permissions" && (x.target || "").includes("settings.local.json")));

  // reportOnly：model / plugins / keybindings
  check("model 只报告", has(plan.reportOnly, x => x.path === "model"));
  check("enabledPlugins 只报告", has(plan.reportOnly, x => x.path === "enabledPlugins"));
  check("extraKnownMarketplaces 只报告", has(plan.reportOnly, x => x.path === "extraKnownMarketplaces"));
  check("keybindings 只报告", has(plan.reportOnly, x => (x.source || "").endsWith("keybindings.json")));

  // unknown / emptySkipped
  check("someUnknownField 归 unknown", has(plan.unknown, x => x.path === "someUnknownField"));
  check("emptyObj 归 emptySkipped", has(plan.emptySkipped, x => x.path === "emptyObj"));
  check("emptyArr 归 emptySkipped", has(plan.emptySkipped, x => x.path === "emptyArr"));

  // commands / skills / agents / output-styles 可迁移
  const mig = (label: string) => has(plan.migratable, x => (x.label || "").includes(label));
  check("命令 greet.md 可迁移", mig("greet.md"));
  check("命令 build.md 可迁移(项目)", mig("build.md"));
  check("skill helper 可迁移", mig("helper"));
  check("agent reviewer.md 可迁移", mig("reviewer.md"));
  check("output-style concise.md 可迁移", mig("concise.md"));
  // 点前缀/.git 被忽略
  check(".hidden.md 被忽略", !has([...plan.migratable, ...plan.needsDecision], x => (x.label || "").includes(".hidden")));
  check(".git 被忽略", !has([...plan.migratable, ...plan.needsDecision], x => (x.label || "").includes(".git")));

  // memory：敏感需确认 + 双 sanitize 目标路径
  const sidKey = sanitizeSidProjectKey(PROJECT);
  const memItems = plan.needsDecision.filter((x: any) => (x.label || "").startsWith("项目 memory"));
  check("memory 作为敏感需确认", memItems.length >= 1 && memItems.every((x: any) => x.sensitive === true));
  check("memory 目标用 sid sanitize key", memItems.every((x: any) => x.target.includes(`/projects/${sidKey}/memory/`)),
    `期望 key=${sidKey}；实际样本=${memItems[0]?.target}`);
  check("memory 源用 claude sanitize key", memItems.every((x: any) => x.source.includes(`/projects/${sanitizeClaudeProjectId(PROJECT)}/memory/`)));
  check("memory 源/目标 key 不同(验证双规则)", sanitizeClaudeProjectId(PROJECT) !== sidKey);
  // memory 内容不泄漏
  check("memory 内容未打印进计划", JSON.stringify(plan).indexOf("可能含隐私") === -1);
  check("team 子目录作为一项", has(memItems, (x: any) => x.item === "team" && x.itemKind === "directory"));

  // 计划不含任何 secret 值
  check("整个计划不泄漏 secret", ["sk-xxx", "tvly-xxx"].every(s => JSON.stringify(plan).indexOf(s) === -1));
}

// ─── C. 执行真正的迁移转换 + 真实加载器验证 ───

function inferTransport(cfg: any): string | null {
  const t = typeof cfg.type === "string" ? cfg.type.toLowerCase() : "";
  if (["stdio", "http", "sse", "ws"].includes(t)) return t;
  if (cfg.command) return "stdio";
  if (cfg.url) return "http";
  return null;
}
const MCP_FIELDS = new Set(["transport","command","args","env","url","headers","enabled","timeout","retries","includeTools","excludeTools"]);
function migrateMcpServer(cfg: any): any {
  const out: any = { transport: inferTransport(cfg) };
  for (const [k, v] of Object.entries(cfg)) {
    if (k === "type") continue;
    if (k === "disabled") { out.enabled = v === true ? false : true; continue; }
    if (MCP_FIELDS.has(k)) out[k] = v;
  }
  return out;
}
// hooks：Claude 两层 -> sid-code 扁平
function migrateHooks(claudeHooks: any): any {
  const out: any = {};
  for (const [event, groups] of Object.entries<any>(claudeHooks)) {
    out[event] = [];
    for (const group of groups as any[]) {
      const matcher = group.matcher;
      const inner = Array.isArray(group.hooks) ? group.hooks : [group];
      for (const h of inner) {
        const entry: any = { ...h, event };
        if (matcher !== undefined) entry.matcher = matcher;
        delete entry.hooks;
        if (typeof entry.command === "string") {
          entry.command = entry.command
            .replace(/\$CLAUDE_PROJECT_DIR/g, "$SID_CODE_PROJECT_DIR")
            .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, "${SID_CODE_PROJECT_DIR}");
        }
        out[event].push(entry);
      }
    }
  }
  return out;
}
function patchMergeSettings(targetPath: string, patch: Record<string, unknown>) {
  let base: any = {};
  if (existsSync(targetPath)) base = JSON.parse(readFileSync(targetPath, "utf8"));
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in base)) base[k] = v; // 只补缺失顶层键，不覆盖
  }
  j(targetPath, base);
}

function performMigration() {
  section("C. 执行迁移转换 + 真实加载器验证");

  const ccUser = JSON.parse(readFileSync(join(CLAUDE, "settings.json"), "utf8"));
  const ccJson = JSON.parse(readFileSync(join(ROOT, ".claude.json"), "utf8"));
  const ccProjShared = JSON.parse(readFileSync(join(PROJ_CLAUDE, "settings.json"), "utf8"));
  const ccProjLocal = JSON.parse(readFileSync(join(PROJ_CLAUDE, "settings.local.json"), "utf8"));

  // 用户级 settings.json：迁移 permissions + hooks(展开) + env + mcpServers(转换) + outputStyle
  const userMcp: any = {};
  for (const [n, c] of Object.entries<any>(ccUser.mcpServers || {})) userMcp[n] = migrateMcpServer(c);
  for (const [n, c] of Object.entries<any>(ccJson.mcpServers || {})) userMcp[n] = migrateMcpServer(c);
  patchMergeSettings(join(SID, "settings.json"), {
    permissions: ccUser.permissions,
    hooks: migrateHooks(ccUser.hooks),
    env: ccUser.env,
    outputStyle: ccUser.outputStyle,
    mcpServers: userMcp,
  });

  // 项目共享 mcpServers -> 项目根 .mcp.json（合并进已有，不覆盖 inplace-srv）
  const existingMcp = JSON.parse(readFileSync(join(PROJECT, ".mcp.json"), "utf8"));
  for (const [n, c] of Object.entries<any>(ccProjShared.mcpServers || {})) {
    if (!existingMcp.mcpServers[n]) existingMcp.mcpServers[n] = migrateMcpServer(c);
  }
  j(join(PROJECT, ".mcp.json"), existingMcp);

  // 项目共享 permissions -> 项目 .sid-code/settings.json
  patchMergeSettings(join(PROJ_SID, "settings.json"), { permissions: ccProjShared.permissions });

  // 项目本地 permissions + project 条目 mcpServers -> .sid-code/settings.local.json
  const localMcp: any = {};
  const projEntry = ccJson.projects?.[PROJECT];
  for (const [n, c] of Object.entries<any>(projEntry?.mcpServers || {})) localMcp[n] = migrateMcpServer(c);
  patchMergeSettings(join(PROJ_SID, "settings.local.json"), {
    permissions: ccProjLocal.permissions,
    mcpServers: localMcp,
  });

  // 资源目录 copy
  const cp = (src: string, dst: string) => { if (existsSync(src)) cpSync(src, dst, { recursive: true }); };
  cp(join(CLAUDE, "commands", "greet.md"), join(SID, "commands", "greet.md"));
  cp(join(PROJ_CLAUDE, "commands", "build.md"), join(PROJ_SID, "commands", "build.md"));
  cp(join(CLAUDE, "skills", "helper"), join(SID, "skills", "helper"));
  cp(join(PROJ_CLAUDE, "skills", "proj-skill"), join(PROJ_SID, "skills", "proj-skill"));
  cp(join(CLAUDE, "agents", "reviewer.md"), join(SID, "agents", "reviewer.md"));
  cp(join(CLAUDE, "output-styles", "concise.md"), join(SID, "output-styles", "concise.md"));

  // memory：源(claude key) -> 目标(sid key)，整体 copy
  const srcMem = join(CLAUDE, "projects", sanitizeClaudeProjectId(PROJECT), "memory");
  const dstMem = join(SID, "projects", sanitizeSidProjectKey(PROJECT), "memory");
  mkdirSync(dirname(dstMem), { recursive: true });
  cpSync(srcMem, dstMem, { recursive: true });

  return { userMcp, dstMem };
}

async function validateWithRealLoaders(migrated: { userMcp: any; dstMem: string }) {
  // 隔离环境变量后再 import 真实模块
  process.env.SID_CONFIG_DIR = SID;
  process.env.HOME = HOME;

  // 1. SettingsSchema (Zod) 校验用户级 settings.json
  const { SettingsSchema } = await import(join(REPO, "packages/core/src/config/settings/types.ts"));
  const userSettings = JSON.parse(readFileSync(join(SID, "settings.json"), "utf8"));
  const parsed = SettingsSchema().safeParse(userSettings);
  check("真实 SettingsSchema 通过", parsed.success, parsed.success ? "" : JSON.stringify(parsed.error?.issues?.slice(0, 3)));

  // hooks 结构：扁平 + event 字段 + token 已替换 + 无内层 hooks 包裹
  const migHooks = userSettings.hooks;
  check("hooks PreToolUse 扁平为 2 条", Array.isArray(migHooks?.PreToolUse) && migHooks.PreToolUse.length === 2);
  check("hooks 每条带 event", migHooks?.PreToolUse?.every((h: any) => h.event === "PreToolUse"));
  check("hooks matcher 保留", migHooks?.PreToolUse?.[0]?.matcher === "Write");
  check("hooks token 已替换", migHooks?.PreToolUse?.[0]?.command?.includes("$SID_CODE_PROJECT_DIR"));
  check("hooks 无内层 hooks 包裹", migHooks?.PreToolUse?.every((h: any) => h.hooks === undefined));

  // MCP：每个 server 有 transport（Zod 必填），无残留 type
  const mcpVals = Object.values<any>(userSettings.mcpServers || {});
  check("MCP 全部有 transport", mcpVals.every(s => ["stdio","http","sse","ws"].includes(s.transport)));
  check("MCP 无残留 type 字段", mcpVals.every(s => s.type === undefined));

  // 2. mergeMcpConfigs：合并三源，签名去重后仍可用
  const { mergeMcpConfigs } = await import(join(REPO, "packages/core/src/mcp/config.ts"));
  const rootMcp = JSON.parse(readFileSync(join(PROJECT, ".mcp.json"), "utf8")).mcpServers;
  const localSettings = JSON.parse(readFileSync(join(PROJ_SID, "settings.local.json"), "utf8"));
  const merged = mergeMcpConfigs([
    { scope: "user", servers: userSettings.mcpServers },
    { scope: "project", servers: rootMcp },
    { scope: "local", servers: localSettings.mcpServers },
  ]);
  check("mergeMcpConfigs 含 user-stdio", !!merged["user-stdio"]);
  check("mergeMcpConfigs 含 shared-srv(.mcp.json)", !!merged["shared-srv"]);
  check("mergeMcpConfigs 含 proj-local-srv", !!merged["proj-local-srv"]);
  check("mergeMcpConfigs 含 inplace-srv", !!merged["inplace-srv"]);
  check("merged server 带 scope", Object.values<any>(merged).every(s => !!s.scope));

  // 3. SkillLoader：用户级 + 项目级 skill 都能加载
  const { SkillLoader } = await import(join(REPO, "packages/core/src/skill/loader.ts"));
  const skills = await new SkillLoader().loadAll(PROJECT, { trustProjectExtensions: true });
  const skillNames = skills.map((s: any) => s.name);
  check("真实 SkillLoader 加载 helper", skillNames.includes("helper"), JSON.stringify(skillNames));
  check("真实 SkillLoader 加载 proj-skill", skillNames.includes("proj-skill"));

  // 4. CustomCommandLoader
  const { CustomCommandLoader } = await import(join(REPO, "packages/cli/src/command/custom.ts"));
  const cmds = await new CustomCommandLoader().loadAll(PROJECT, { trustProjectExtensions: true });
  const cmdNames = cmds.map((c: any) => c.cmd.name());
  check("真实 CommandLoader 加载 greet", cmdNames.includes("greet"), JSON.stringify(cmdNames));
  check("真实 CommandLoader 加载 build", cmdNames.includes("build"));

  // 5. CustomAgentLoader
  const { CustomAgentLoader } = await import(join(REPO, "packages/core/src/agent/custom.ts"));
  const agents = await new CustomAgentLoader().loadAll(PROJECT, { trustProjectExtensions: true });
  check("真实 AgentLoader 加载 reviewer", agents.map((a: any) => a.name).includes("reviewer"));

  // 6. output-styles —— loadAllOutputStyles 用 os.homedir()，而 homedir() 在进程启动时
  //    已缓存、不响应运行时 process.env.HOME 变更。故在子进程里预设 HOME 后再加载。
  const stylesOut = execFileSync(
    "bun",
    ["-e", `import {loadAllOutputStyles} from ${JSON.stringify(join(REPO, "packages/core/src/config/output-styles.ts"))}; console.log(JSON.stringify(loadAllOutputStyles().map(s=>s.name)))`],
    { encoding: "utf8", env: { ...process.env, HOME, SID_CONFIG_DIR: SID } },
  ).trim().split("\n").pop() as string;
  const styleNames = JSON.parse(stylesOut);
  check("真实 output-styles 加载 concise", styleNames.includes("concise"), stylesOut);

  // 7. memory 复制正确性
  check("memory MEMORY.md 已复制", existsSync(join(migrated.dstMem, "MEMORY.md")));
  check("memory topic-a.md 已复制", existsSync(join(migrated.dstMem, "topic-a.md")));
  check("memory team/ 结构保留", existsSync(join(migrated.dstMem, "team", "shared.md")));
}

function assertStateAwareness() {
  section("D. 状态感知（已迁移跳过 + force 逃生阀）");
  // 造状态文件：把 greet.md 目标标记为已迁移
  const statePath = join(SID, "state", "cc-migration-state.json");
  const greetTarget = join(SID, "commands", "greet.md");
  j(statePath, {
    version: 1,
    tool: "claude-code-to-sid-code-migration",
    userScope: { items: [greetTarget], migratedAt: "2026-01-01T00:00:00Z" },
    projects: {},
  });
  const plan = runInspector();
  check("已迁移的 greet.md 归 alreadyMigrated",
    has(plan.alreadyMigrated, x => (x.label || "").includes("greet")),
    JSON.stringify(plan.alreadyMigrated.map((x: any) => x.label)));
  check("greet.md 不再出现在 migratable/needsDecision",
    !has([...plan.migratable, ...plan.needsDecision], x => (x.label || "").includes("greet.md")));

  const forced = runInspector(["--force-user"]);
  check("--force-user 后 greet.md 重新出现",
    has([...forced.migratable, ...forced.needsDecision, ...forced.conflicts], x => (x.label || "").includes("greet")));
}

// ─── main ───
async function main() {
  section("A. 构建隔离 Claude Code 夹具");
  buildFixture();
  check("夹具已创建", existsSync(join(CLAUDE, "settings.json")));
  console.log(`夹具根: ${ROOT}`);

  const plan = runInspector();
  assertInspectorClassification(plan);

  const migrated = performMigration();
  await validateWithRealLoaders(migrated);

  assertStateAwareness();

  // ─── 汇总 ───
  section("结果");
  console.log(`通过: ${passed}`);
  if (failures.length) {
    console.log(`失败: ${failures.length}`);
    for (const f of failures) console.log("  " + f);
  } else {
    console.log("全部通过 ✓");
  }

  // 清理
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
