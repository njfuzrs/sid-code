#!/usr/bin/env node
/**
 * Claude Code -> sid-code 只读迁移检查脚本
 *
 * 确定性扫描：读取 Claude Code 配置源（~/.claude、~/.claude.json、<project>/.claude、
 * <project>/.mcp.json），对照 sid-code 目标位置，产出结构化迁移计划。
 *
 * 铁律：只读。绝不写文件、不安装、不联网。唯一读的「状态」是本 skill 的记账文件
 * ~/.sid-code/state/cc-migration-state.json（也只读）。
 *
 * 与 Claude->Qoder 迁移脚本的关键差异（见 references/mapping.md）：
 * - memory 目录：源(Claude)与目标(sid-code)用两套不同 sanitize 规则，不可假定相同。
 * - CLAUDE.md / .claude/rules / CLAUDE.local.md：sid-code 原生读取 .claude 位置，
 *   归入 compatibleInPlace（只报告，不迁移）。
 * - MCP：sid-code 要求 transport 字段，需从 Claude 的 type 推导。
 * - hooks：sid-code 是扁平结构，需从 Claude 的两层(matcher 分组)结构展开。
 * - plugins（enabledPlugins/extraKnownMarketplaces）：sid-code 无对应字段，只报告。
 * - 状态文件避开 ~/.sid-code/state/migrations.json（内核迁移水位线，绝不触碰）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** sid-code 支持的 MCP server 字段（见 src/config/settings/types.ts MCPServerSchema） */
const MCP_FIELDS = new Set([
  "transport",
  "command",
  "args",
  "env",
  "url",
  "headers",
  "enabled",
  "timeout",
  "retries",
  "includeTools",
  "excludeTools",
]);

/** analyzeSettings 显式处理的顶层字段；其余落 unknown */
const SETTINGS_HANDLED = new Set([
  "$schema",
  "mcpServers",
  "permissions",
  "hooks",
  "outputStyle",
  "env",
  "model",
  "fallbackModel",
  "enabledPlugins",
  "extraKnownMarketplaces",
]);

const IGNORED_DIR_ENTRIES = new Set([".DS_Store"]);

let STATE_CTX = {
  force: false,
  forceUser: false,
  userItems: new Set(),
  projectItems: new Set(),
};

function parseArgs(argv) {
  const opts = {
    project: process.cwd(),
    home: os.homedir(),
    format: "markdown",
    state: null,
    force: false,
    forceUser: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project") opts.project = argv[++i];
    else if (arg === "--home") opts.home = argv[++i];
    else if (arg === "--format") opts.format = argv[++i];
    else if (arg === "--state") opts.state = argv[++i];
    else if (arg === "--force") opts.force = true;
    else if (arg === "--force-user") opts.forceUser = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "用法: inspect-migration.mjs [--project PATH] [--home PATH] [--state PATH] [--force] [--force-user] [--format markdown|json]",
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  opts.project = path.resolve(opts.project);
  opts.home = path.resolve(opts.home);
  if (opts.state) opts.state = path.resolve(opts.state);
  if (!["markdown", "json"].includes(opts.format)) {
    throw new Error("--format 必须是 markdown 或 json");
  }
  return opts;
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 去掉 JSON 里的 // 和 /* *\/ 注释（Claude settings 允许 JSONC 风格） */
function stripJsonComments(input) {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function readJson(pathname) {
  if (!exists(pathname)) return { exists: false };
  try {
    const raw = fs.readFileSync(pathname, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw));
    return { exists: true, parsed, raw };
  } catch (error) {
    return { exists: true, error: error.message };
  }
}

/** 从任意 JSON 文件读取 mcpServers（兼容 mcp_servers 别名与顶层直写） */
function readMcpServersFromJsonFile(pathname) {
  const result = readJson(pathname);
  if (!result.exists) return { exists: false, servers: {} };
  if (result.error) return { exists: true, servers: {}, error: result.error };
  const parsed = result.parsed;
  const mcpServers = parsed?.mcpServers ?? parsed?.mcp_servers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return { exists: true, servers: {} };
  }
  return { exists: true, servers: mcpServers };
}

function listFiles(dir) {
  if (!isDir(dir)) return [];
  const result = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) result.push(p);
    }
  };
  walk(dir);
  return result.sort();
}

function listTopLevelItems(dir, options = {}) {
  if (!isDir(dir)) return [];
  const skipDotPrefix = !!options.skipDotPrefix;
  const items = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIR_ENTRIES.has(entry.name)) continue;
    // 资源目录（commands/skills/agents/output-styles）与 sid-code ExtensionLoader 一致：
    // 忽略 '_' / '.' 前缀的文件与目录（如 .git、_draft），避免把它们当成可迁移项。
    if (skipDotPrefix && (entry.name.startsWith(".") || entry.name.startsWith("_"))) continue;
    const itemPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      items.push({
        name: entry.name,
        path: itemPath,
        files: listFiles(itemPath),
        kind: "directory",
      });
    } else if (entry.isFile()) {
      items.push({
        name: entry.name,
        path: itemPath,
        files: [itemPath],
        kind: "file",
      });
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function projectEntryCandidates(project) {
  const candidates = new Set([project]);
  try {
    candidates.add(fs.realpathSync(project));
  } catch {
    // ignore
  }
  let current = project;
  while (current && current !== path.dirname(current)) {
    if (exists(path.join(current, ".git"))) candidates.add(current);
    current = path.dirname(current);
  }
  return [...candidates];
}

function normalizeProjectKeyForMatch(value) {
  let normalized = String(value).replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return normalized;
}

function projectKeyMatches(key, candidates) {
  const normalizedKey = normalizeProjectKeyForMatch(key);
  return candidates.some((candidate) => normalizeProjectKeyForMatch(candidate) === normalizedKey);
}

/** sid-code 配置根目录：SID_CONFIG_DIR 覆盖 > <home>/.sid-code */
function sidHome(home) {
  if (process.env.SID_CONFIG_DIR) return path.resolve(process.env.SID_CONFIG_DIR);
  return path.join(home, ".sid-code");
}

/** Claude Code 配置根目录：CLAUDE_CONFIG_DIR 覆盖 > <home>/.claude */
function claudeSettingsHome(home) {
  if (process.env.CLAUDE_CONFIG_DIR) return path.resolve(process.env.CLAUDE_CONFIG_DIR);
  return path.join(home, ".claude");
}

function claudeStatePath(home) {
  if (process.env.CLAUDE_CONFIG_DIR)
    return path.join(path.resolve(process.env.CLAUDE_CONFIG_DIR), ".claude.json");
  return path.join(home, ".claude.json");
}

// ─── 两套 sanitize 规则（关键差异） ───

const MAX_CC_SANITIZED_LENGTH = 200;

function djb2Hash(input) {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return hash;
}

/** Claude Code 的项目目录名 sanitize（源侧）：[^a-zA-Z0-9]->'-'，不折叠、不去首尾、保留前导 '-' */
function sanitizeClaudeProjectId(name) {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_CC_SANITIZED_LENGTH) return sanitized;
  const hash = Math.abs(djb2Hash(name)).toString(36);
  return `${sanitized.slice(0, MAX_CC_SANITIZED_LENGTH)}-${hash}`;
}

/**
 * sid-code 的项目目录名 sanitize（目标侧，对齐 src/memory/paths.ts sanitizeProjectKey）：
 * 去首尾分隔符 -> 分隔符转 '-' -> [^a-zA-Z0-9._-] 转 '-' -> 折叠连续 '-' -> 去首尾 '-'；空则 'default'。
 */
function sanitizeSidProjectKey(raw) {
  const cleaned = raw
    .replace(/^[\\/]+|[\\/]+$/g, "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "default";
}

function add(plan, section, item) {
  plan[section].push(item);
}

function scopeLabel(scope) {
  return (
    {
      user: "用户级",
      project: "项目级",
      local: "项目本地",
    }[scope] || scope
  );
}

// ─── 目标索引：判断目标中是否已存在同名 MCP / settings 字段 ───

function addTargetMcpFile(plan, index, label, pathname) {
  const result = readMcpServersFromJsonFile(pathname);
  if (!result.exists) return;
  if (result.error) {
    add(plan, "unsupported", {
      source: pathname,
      path: "mcpServers",
      reason: `目标 MCP 冲突检查已跳过: ${result.error}`,
    });
    return;
  }
  if (!index[label]) index[label] = {};
  for (const name of Object.keys(result.servers)) {
    if (!index[label][name]) index[label][name] = [];
    index[label][name].push(pathname);
  }
}

function buildTargetMcpIndex(plan, sHome, sProject, project) {
  const index = {};
  addTargetMcpFile(plan, index, "~/.sid-code/settings.json", path.join(sHome, "settings.json"));
  addTargetMcpFile(
    plan,
    index,
    "<project>/.sid-code/settings.local.json",
    path.join(sProject, "settings.local.json"),
  );
  addTargetMcpFile(plan, index, "<project>/.mcp.json", path.join(project, ".mcp.json"));
  addTargetMcpFile(plan, index, "<project>/.mcp.json", path.join(sProject, "settings.json"));
  return index;
}

function existingMcpTargets(targetMcpIndex, target, serverName) {
  return targetMcpIndex?.[target]?.[serverName] ?? [];
}

function buildTargetSettingsIndex(sHome, sProject) {
  const index = {};
  const record = (label, file) => {
    const result = readJson(file);
    const parsed = result.exists && !result.error ? result.parsed : null;
    index[label] = new Set(
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [],
    );
  };
  record("~/.sid-code/settings.json", path.join(sHome, "settings.json"));
  record("<project>/.sid-code/settings.json", path.join(sProject, "settings.json"));
  record("<project>/.sid-code/settings.local.json", path.join(sProject, "settings.local.json"));
  return index;
}

function targetSettingsFieldExists(index, target, field) {
  return index?.[target]?.has(field) ?? false;
}

function stringSet(items) {
  return new Set(Array.isArray(items) ? items.filter((x) => typeof x === "string") : []);
}

// ─── 迁移状态文件（记账，只读） ───

function readMigrationState(statePath) {
  const result = readJson(statePath);
  if (!result.exists) return { exists: false, data: null };
  if (result.error) return { exists: true, error: result.error, data: null };
  const data = result.parsed;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { exists: true, error: "状态文件不是 JSON 对象", data: null };
  }
  if (data.version !== 1 || data.tool !== "claude-code-to-sid-code-migration") {
    return {
      exists: true,
      error: "version 或 tool 字段不匹配，非本 skill 的迁移状态文件",
      data: null,
    };
  }
  return { exists: true, data };
}

function collectUserStateItems(data) {
  return stringSet(data?.userScope?.items);
}

function collectProjectStateItems(data, candidates) {
  const set = new Set();
  const projects = data?.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return set;
  for (const [key, entry] of Object.entries(projects)) {
    if (!projectKeyMatches(key, candidates)) continue;
    for (const item of stringSet(entry?.items)) set.add(item);
  }
  return set;
}

function isAlreadyMigrated(scope, identity) {
  if (!identity || STATE_CTX.force) return false;
  if (scope === "user") {
    if (STATE_CTX.forceUser) return false;
    return STATE_CTX.userItems.has(identity);
  }
  return STATE_CTX.projectItems.has(identity);
}

function mcpIdentity(targetPath, serverName) {
  return `${targetPath}#mcpServers.${serverName}`;
}

function summarizeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `数组(${value.length})`;
  if (typeof value === "object") return `对象(${Object.keys(value).length})`;
  return (
    {
      string: "字符串",
      number: "数字",
      boolean: "布尔值",
      bigint: "bigint",
      undefined: "undefined",
      symbol: "symbol",
      function: "function",
    }[typeof value] || typeof value
  );
}

function emptyValue(value) {
  if (value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/** 从 Claude MCP server 配置推导 sid-code 的 transport 值 */
function inferTransport(cfg) {
  const t = typeof cfg.type === "string" ? cfg.type.toLowerCase() : "";
  if (t === "stdio" || t === "http" || t === "sse" || t === "ws") return t;
  if (cfg.command) return "stdio";
  if (cfg.url) return "http";
  return null;
}

function analyzeMcpServers(plan, sourcePath, sourceScope, target, servers, options = {}) {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    add(plan, "unsupported", {
      source: sourcePath,
      path: "mcpServers",
      reason: "mcpServers 不是对象",
    });
    return;
  }
  const names = Object.keys(servers);
  if (names.length === 0) {
    add(plan, "emptySkipped", { source: sourcePath, path: "mcpServers" });
    return;
  }

  for (const name of names) {
    const cfg = servers[name];
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      add(plan, "unsupported", {
        source: sourcePath,
        path: `mcpServers.${name}`,
        reason: "server 配置不是对象",
      });
      continue;
    }
    // Claude 字段里 type 要转成 transport；其余不在 sid-code 支持列表的算 unsupported
    // （disabled 可映射为 enabled:false，单列 transform 提示）
    const transport = inferTransport(cfg);
    const unsupported = Object.keys(cfg).filter(
      (key) => key !== "type" && key !== "disabled" && !MCP_FIELDS.has(key),
    );
    const hasDisabled = cfg.disabled !== undefined;
    const sensitive = ["env", "headers"].filter((key) => cfg[key] !== undefined);
    const identity = mcpIdentity(target, name);
    const transforms = [];
    if (transport) transforms.push(`type -> transport: "${transport}"`);
    else transforms.push("无法推导 transport（缺 type/command/url），需人工指定");
    if (hasDisabled)
      transforms.push(
        `disabled: ${cfg.disabled} -> enabled: ${cfg.disabled === true ? "false" : "true"}`,
      );
    const item = {
      source: sourcePath,
      sourceScope,
      target,
      server: name,
      identity,
      sensitive,
      transport,
      transforms,
      unsupportedFields: unsupported,
    };
    const existingTargets = existingMcpTargets(options.targetMcpIndex, target, name);
    const migrated =
      !options.compatibleInPlace &&
      existingTargets.length &&
      isAlreadyMigrated(sourceScope, identity);
    if (options.compatibleInPlace) add(plan, "compatibleInPlace", item);
    else if (migrated) {
      add(plan, "alreadyMigrated", {
        source: sourcePath,
        sourceScope,
        target,
        identity,
        label: `MCP server ${name}`,
        existingTargets,
      });
    } else if (existingTargets.length) {
      add(plan, "needsDecision", {
        ...item,
        existingTargets,
        reason: "目标中已存在同名 MCP server",
      });
      add(plan, "conflicts", {
        source: sourcePath,
        target,
        label: `MCP server ${name}`,
        server: name,
        existingTargets,
        choices: ["保留目标", "替换目标", "重命名源 server", "跳过"],
      });
    } else add(plan, "needsDecision", item); // MCP 一律需确认（含 transport 转换与潜在 secret）
    for (const field of unsupported) {
      add(plan, "unsupported", {
        source: sourcePath,
        path: `mcpServers.${name}.${field}`,
        reason: "sid-code 不支持的 MCP server 字段",
      });
    }
  }
}

/** 展开 Claude 两层 hooks 结构，统计内层 hook 条数与不支持字段 */
function analyzeHooksShape(value) {
  const SID_HOOK_FIELDS = new Set([
    "type",
    "event",
    "command",
    "url",
    "method",
    "headers",
    "timeout",
    "blocking",
    "matcher",
  ]);
  let events = 0;
  let flatEntries = 0;
  const unsupportedFields = new Set();
  let claudeTokenHits = 0;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const groups of Object.values(value)) {
      events++;
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        const inner = Array.isArray(group?.hooks) ? group.hooks : [group];
        for (const h of inner) {
          if (!h || typeof h !== "object") continue;
          flatEntries++;
          for (const k of Object.keys(h)) {
            if (k === "hooks") continue;
            if (!SID_HOOK_FIELDS.has(k)) unsupportedFields.add(k);
          }
          const cmd = typeof h.command === "string" ? h.command : "";
          if (/\bCLAUDE_[A-Z_]+/.test(cmd) || /\bclaude\b/.test(cmd) || cmd.includes("/.claude/")) {
            claudeTokenHits++;
          }
        }
      }
    }
  }
  return { events, flatEntries, unsupportedFields: [...unsupportedFields], claudeTokenHits };
}

function analyzeSettings(
  plan,
  sourcePath,
  sourceScope,
  targetScope,
  settings,
  targetMcpIndex,
  targetSettingsIndex,
) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    add(plan, "unsupported", {
      source: sourcePath,
      path: "",
      reason: "settings 文件不是 JSON 对象",
    });
    return;
  }
  const addSettingsField = (field, target, extra) => {
    const identity = `${target}#${field}`;
    if (
      targetSettingsFieldExists(targetSettingsIndex, target, field) &&
      isAlreadyMigrated(sourceScope, identity)
    ) {
      add(plan, "alreadyMigrated", {
        source: sourcePath,
        sourceScope,
        target,
        identity,
        label: field,
      });
      return;
    }
    add(plan, "needsDecision", {
      source: sourcePath,
      sourceScope,
      target,
      identity,
      path: field,
      ...extra,
    });
  };
  const settingsTarget =
    targetScope === "user"
      ? "~/.sid-code/settings.json"
      : targetScope === "local"
        ? "<project>/.sid-code/settings.local.json"
        : "<project>/.sid-code/settings.json";

  for (const [key, value] of Object.entries(settings)) {
    if (emptyValue(value)) {
      add(plan, "emptySkipped", { source: sourcePath, path: key });
      continue;
    }
    if (key === "$schema") continue;
    if (key === "mcpServers") {
      const target =
        targetScope === "project"
          ? "<project>/.mcp.json"
          : targetScope === "local"
            ? "<project>/.sid-code/settings.local.json"
            : "~/.sid-code/settings.json";
      analyzeMcpServers(plan, sourcePath, sourceScope, target, value, { targetMcpIndex });
      continue;
    }
    if (key === "permissions") {
      addSettingsField("permissions", settingsTarget, {
        reason: "会改变工具访问或信任边界；结构与 sid-code 同名兼容",
      });
      continue;
    }
    if (key === "hooks") {
      const shape = analyzeHooksShape(value);
      addSettingsField("hooks", settingsTarget, {
        reason: "hooks 会执行命令；需要用户确认执行风险",
        transform:
          `必做结构转换：Claude 两层(matcher 分组+内层 hooks) -> sid-code 扁平 HookEntry。` +
          `本源共 ${shape.events} 个事件、展开后约 ${shape.flatEntries} 条 HookEntry。` +
          `token 替换：$CLAUDE_PROJECT_DIR -> $SID_CODE_PROJECT_DIR（其余原样）。`,
        hookShape: shape,
        ...(shape.unsupportedFields.length
          ? { unsupportedHookFields: shape.unsupportedFields }
          : {}),
        ...(shape.claudeTokenHits
          ? {
              warning: `检测到 ${shape.claudeTokenHits} 条 hook 命令含 CLAUDE_*/claude/.claude 引用，转换后仍需人工核对`,
            }
          : {}),
      });
      continue;
    }
    if (key === "outputStyle") {
      addSettingsField("outputStyle", settingsTarget, {
        reason: "仅在对应 style 文件已存在于 sid-code 目标位置后才设置 active style",
      });
      continue;
    }
    if (key === "env") {
      // sid-code 有顶层 env，但值多为 secret 且 Claude 专属 env 语义不同 -> 敏感项需确认
      const envKeys = value && typeof value === "object" ? Object.keys(value) : [];
      add(plan, "needsDecision", {
        source: sourcePath,
        sourceScope,
        target: settingsTarget,
        identity: `${settingsTarget}#env`,
        path: "env",
        sensitive: ["env"],
        reason:
          "env 多含 secret；Claude 专属 env（ANTHROPIC_*/CLAUDE_CODE_*/API_TIMEOUT_MS）语义与 sid-code provider 配置不同",
        envKeys,
        note: "只展示 key 名不打印值；Claude 专属 env 建议改写为 sid-code 原生字段（baseURL/anthropicKey/maxTokens）而非原样搬运",
      });
      continue;
    }
    if (key === "model" || key === "fallbackModel") {
      add(plan, "reportOnly", {
        source: sourcePath,
        path: key,
        reason: "模型、provider 或 auth 语义不同；sid-code 有独立的 provider/availableModels 体系",
      });
      continue;
    }
    if (key === "enabledPlugins" || key === "extraKnownMarketplaces") {
      add(plan, "reportOnly", {
        source: sourcePath,
        path: key,
        reason:
          "sid-code 无插件 marketplace 机制，无对应迁移目标；需用户改用 sid-code 的 skill/MCP/agent 重建等价能力",
        detail: summarizeValue(value),
      });
      continue;
    }
    if (!SETTINGS_HANDLED.has(key)) {
      add(plan, "unknown", {
        source: sourcePath,
        path: key,
        summary: summarizeValue(value),
      });
    }
  }
}

function compareDir(plan, source, target, label, scope, options = {}) {
  const requiresDecision = !!options.requiresDecision;
  const items = options.items || listTopLevelItems(source);
  if (items.length === 0) return;
  for (const item of items) {
    const targetPath = path.join(target, item.name);
    const conflictedFiles = [];
    if (exists(targetPath)) {
      conflictedFiles.push(targetPath);
    } else {
      for (const file of item.files) {
        const rel = path.relative(source, file);
        const candidate = path.join(target, rel);
        if (exists(candidate)) conflictedFiles.push(candidate);
      }
    }
    const identity = targetPath;
    if (conflictedFiles.length && isAlreadyMigrated(scope, identity)) {
      add(plan, "alreadyMigrated", {
        source: item.path,
        sourceScope: scope,
        target: targetPath,
        identity,
        label: `${label}: ${item.name}`,
      });
      continue;
    }
    const planItem = {
      source: item.path,
      sourceScope: scope,
      target: targetPath,
      identity,
      label: `${label}: ${item.name}`,
      item: item.name,
      itemKind: item.kind,
      files: item.files.length,
      conflicts: conflictedFiles.length,
      conflictedFiles,
      reason: conflictedFiles.length ? "目标已存在或存在同路径文件冲突" : undefined,
      rule: "只复制；保留相对路径；绝不覆盖",
    };
    if (requiresDecision) planItem.sensitive = true;
    const section = conflictedFiles.length || requiresDecision ? "needsDecision" : "migratable";
    add(plan, section, planItem);
    if (conflictedFiles.length) {
      add(plan, "conflicts", {
        source: item.path,
        target: targetPath,
        label: `${label}: ${item.name}`,
        item: item.name,
        count: conflictedFiles.length,
        conflictedFiles,
        choices: ["跳过", "重命名源副本", "手动合并"],
      });
    }
  }
}

function analyzeClaudeState(plan, statePath, candidates, targetMcpIndex) {
  const result = readJson(statePath);
  if (!result.exists) return;
  add(plan, "sourcesFound", { path: statePath, kind: "Claude 状态文件" });
  if (result.error) {
    add(plan, "unsupported", { source: statePath, path: "", reason: result.error });
    return;
  }
  const state = result.parsed;
  if (state?.mcpServers) {
    analyzeMcpServers(plan, statePath, "user", "~/.sid-code/settings.json", state.mcpServers, {
      targetMcpIndex,
    });
  }
  const projects = state?.projects;
  if (projects && typeof projects === "object" && !Array.isArray(projects)) {
    const matching = Object.keys(projects).filter((p) => projectKeyMatches(p, candidates));
    if (matching.length === 0) {
      const projectCount = Object.keys(projects).length;
      if (projectCount > 0) {
        add(plan, "reportOnly", {
          source: statePath,
          path: "projects",
          reason: `发现 ${projectCount} 个项目条目，但没有匹配当前项目`,
        });
      }
    } else if (matching.length > 1) {
      add(plan, "needsDecision", {
        source: statePath,
        path: "projects",
        reason: "多个项目条目匹配当前项目；需要用户选择一个",
        choices: matching,
      });
    }
    for (const key of matching) {
      const entry = projects[key];
      if (entry?.mcpServers) {
        analyzeMcpServers(
          plan,
          `${statePath}#projects[${key}]`,
          "local",
          "<project>/.sid-code/settings.local.json",
          entry.mcpServers,
          { targetMcpIndex },
        );
      }
    }
  }
}

function inspect(opts) {
  const home = opts.home;
  const project = opts.project;
  const cHome = claudeSettingsHome(home);
  const sHome = sidHome(home);
  const cProject = path.join(project, ".claude");
  const sProject = path.join(project, ".sid-code");
  const plan = {
    tool: "claude-code-to-sid-code-migration",
    project,
    home,
    sidHome: sHome,
    claudeHome: cHome,
    generatedAt: new Date().toISOString(),
    sourcesFound: [],
    compatibleInPlace: [],
    migratable: [],
    needsDecision: [],
    conflicts: [],
    reportOnly: [],
    unsupported: [],
    unknown: [],
    emptySkipped: [],
    alreadyMigrated: [],
    stateFile: null,
  };

  const candidates = projectEntryCandidates(project);

  const statePath = opts.state || path.join(sHome, "state", "cc-migration-state.json");
  const stateResult = readMigrationState(statePath);
  STATE_CTX = {
    force: !!opts.force,
    forceUser: !!opts.forceUser,
    userItems: collectUserStateItems(stateResult.data),
    projectItems: collectProjectStateItems(stateResult.data, candidates),
  };
  plan.stateFile = {
    path: statePath,
    exists: stateResult.exists,
    error: stateResult.error || null,
    force: !!opts.force,
    forceUser: !!opts.forceUser,
    userItemCount: STATE_CTX.userItems.size,
    projectItemCount: STATE_CTX.projectItems.size,
  };
  if (stateResult.error) {
    add(plan, "reportOnly", {
      source: statePath,
      path: "",
      reason: `迁移状态文件无法解析，已按无状态处理: ${stateResult.error}`,
    });
  }

  const targetMcpIndex = buildTargetMcpIndex(plan, sHome, sProject, project);
  const targetSettingsIndex = buildTargetSettingsIndex(sHome, sProject);

  const settingSources = [
    { path: path.join(cHome, "settings.json"), sourceScope: "user", targetScope: "user" },
    { path: path.join(cProject, "settings.json"), sourceScope: "project", targetScope: "project" },
    {
      path: path.join(cProject, "settings.local.json"),
      sourceScope: "local",
      targetScope: "local",
    },
  ];
  for (const source of settingSources) {
    const result = readJson(source.path);
    if (!result.exists) continue;
    add(plan, "sourcesFound", {
      path: source.path,
      kind: `${scopeLabel(source.sourceScope)} settings`,
    });
    if (result.error) {
      add(plan, "unsupported", { source: source.path, path: "", reason: result.error });
    } else {
      analyzeSettings(
        plan,
        source.path,
        source.sourceScope,
        source.targetScope,
        result.parsed,
        targetMcpIndex,
        targetSettingsIndex,
      );
    }
  }

  analyzeClaudeState(plan, claudeStatePath(home), candidates, targetMcpIndex);

  const rootMcp = path.join(project, ".mcp.json");
  const rootMcpResult = readJson(rootMcp);
  if (rootMcpResult.exists) {
    add(plan, "sourcesFound", { path: rootMcp, kind: "项目 MCP" });
    if (rootMcpResult.error) {
      add(plan, "unsupported", { source: rootMcp, path: "", reason: rootMcpResult.error });
    } else if (rootMcpResult.parsed?.mcpServers || rootMcpResult.parsed?.mcp_servers) {
      analyzeMcpServers(
        plan,
        rootMcp,
        "project",
        rootMcp,
        rootMcpResult.parsed.mcpServers ?? rootMcpResult.parsed.mcp_servers,
        { compatibleInPlace: true },
      );
    } else {
      add(plan, "unsupported", {
        source: rootMcp,
        path: "mcpServers",
        reason: "缺少顶层 mcpServers 对象",
      });
    }
  }

  // ─── 记忆与规则：sid-code 原生读取 .claude 位置 -> compatibleInPlace（只报告） ───
  const compatMemoryChecks = [
    {
      p: path.join(cHome, "CLAUDE.md"),
      label: "用户级全局记忆 ~/.claude/CLAUDE.md",
      note: "sid-code 优先读取此文件（回退 ~/.sid-code/CLAUDE.md）",
    },
    {
      p: path.join(project, "CLAUDE.md"),
      label: "项目根记忆 CLAUDE.md",
      note: "sid-code 规则引擎原生加载",
    },
    {
      p: path.join(project, "CLAUDE.local.md"),
      label: "项目本地记忆 CLAUDE.local.md",
      note: "sid-code 规则引擎原生加载",
    },
    {
      p: path.join(cProject, "CLAUDE.md"),
      label: "项目 .claude/CLAUDE.md",
      note: "sid-code 规则引擎原生加载",
    },
    {
      p: path.join(cProject, "CLAUDE.local.md"),
      label: "项目 .claude/CLAUDE.local.md",
      note: "sid-code 规则引擎原生加载",
    },
  ];
  for (const c of compatMemoryChecks) {
    if (exists(c.p)) {
      add(plan, "compatibleInPlace", { source: c.p, label: c.label, note: c.note });
    }
  }
  if (isDir(path.join(cProject, "rules"))) {
    add(plan, "compatibleInPlace", {
      source: path.join(cProject, "rules"),
      label: "项目规则目录 .claude/rules/",
      note: "sid-code 规则引擎原生加载 .claude/rules/**/*.md",
    });
  }

  // ─── copy-only 资源目录：commands / skills / agents / output-styles ───
  for (const name of ["commands", "skills", "agents", "output-styles"]) {
    compareDir(plan, path.join(cHome, name), path.join(sHome, name), `用户级 ${name}`, "user", {
      items: listTopLevelItems(path.join(cHome, name), { skipDotPrefix: true }),
    });
    compareDir(
      plan,
      path.join(cProject, name),
      path.join(sProject, name),
      `项目级 ${name}`,
      "project",
      {
        items: listTopLevelItems(path.join(cProject, name), { skipDotPrefix: true }),
      },
    );
  }

  // ─── 项目 auto-memory：源/目标两套 sanitize 规则 ───
  const claudeMemDir = path.join(cHome, "projects", sanitizeClaudeProjectId(project), "memory");
  const sidMemDir = path.join(sHome, "projects", sanitizeSidProjectKey(project), "memory");
  const memItems = listTopLevelItems(claudeMemDir);
  if (memItems.length > 0) {
    add(plan, "sourcesFound", { path: claudeMemDir, kind: "项目 memory" });
    compareDir(plan, claudeMemDir, sidMemDir, "项目 memory", "local", {
      requiresDecision: true,
      items: memItems,
    });
  } else {
    add(plan, "reportOnly", {
      source: claudeMemDir,
      path: "",
      reason: `未发现当前项目的 Claude memory（该路径不存在或为空）。目标目录名将是 ${path.basename(path.dirname(sidMemDir))}（sid-code sanitize 规则）；如预期存在，请确认项目目录名是否匹配`,
    });
  }

  const keybindings = path.join(cHome, "keybindings.json");
  if (exists(keybindings)) {
    add(plan, "reportOnly", {
      source: keybindings,
      path: "",
      reason: "keybindings schema 不兼容，需要手动重映射",
    });
  }

  return plan;
}

function renderList(items, renderItem) {
  if (!items.length) return "- 无\n";
  return items.map((item) => `- ${renderItem(item)}`).join("\n") + "\n";
}

function renderMarkdown(plan) {
  const lines = [];
  lines.push("# Claude Code 到 sid-code 迁移检查");
  lines.push("");
  lines.push(`项目: \`${plan.project}\``);
  lines.push(`sid-code 配置目录: \`${plan.sidHome}\``);
  lines.push(`Claude Code 配置目录: \`${plan.claudeHome}\``);
  lines.push(`生成时间: \`${plan.generatedAt}\``);
  if (plan.stateFile) {
    const sf = plan.stateFile;
    const flags = sf.force
      ? "（--force：忽略全部状态）"
      : sf.forceUser
        ? "（--force-user：忽略用户级状态）"
        : "";
    const status = sf.error ? "解析失败，已按无状态处理" : sf.exists ? "已存在" : "尚未创建";
    lines.push(
      `迁移状态文件: \`${sf.path}\` (${status}；用户级已记录 ${sf.userItemCount} 项，项目级 ${sf.projectItemCount} 项)${flags}`,
    );
  }
  lines.push("");
  lines.push("## 发现的源文件");
  lines.push(renderList(plan.sourcesFound, (x) => `\`${x.path}\` (${x.kind})`));
  lines.push("## 已在兼容位置（sid-code 可直接读取，无需迁移）");
  lines.push(
    renderList(plan.compatibleInPlace, (x) =>
      x.server
        ? `MCP server \`${x.server}\` 已位于 sid-code 可读取的项目 MCP 位置: \`${x.source}\``
        : `${x.label || "条目"}: \`${x.source}\`${x.note ? `（${x.note}）` : ""}`,
    ),
  );
  lines.push("## 可迁移（copy-only，低风险）");
  lines.push(
    renderList(plan.migratable, (x) =>
      x.server
        ? `MCP server \`${x.server}\`: \`${x.source}\` -> \`${x.target}\``
        : `${x.label || x.path || "条目"}: \`${x.source}\` -> \`${x.target}\`${x.files ? ` (${x.files} 个文件)` : ""}`,
    ),
  );
  lines.push("## 需要确认");
  lines.push(
    renderList(plan.needsDecision, (x) => {
      let text = `${x.sensitive && x.sensitive.length ? "【敏感·需显式确认】" : ""}${x.label || x.path || x.server || "条目"} 来自 \`${x.source}\``;
      if (x.target) text += ` -> \`${x.target}\``;
      if (x.transport !== undefined) text += `；transport=${x.transport ?? "未知(需人工指定)"}`;
      if (x.transforms && x.transforms.length) text += `\n  转换: ${x.transforms.join("；")}`;
      if (x.reason) text += `\n  原因: ${x.reason}`;
      if (x.transform) text += `\n  ${x.transform}`;
      if (x.envKeys) text += `\n  env keys: ${x.envKeys.join(", ")}`;
      if (x.unsupportedHookFields)
        text += `\n  不支持的 hook 字段: ${x.unsupportedHookFields.join(", ")}`;
      if (x.warning) text += `\n  ⚠️ ${x.warning}`;
      if (x.note) text += `\n  说明: ${x.note}`;
      if (x.existingTargets)
        text += `\n  已存在: ${x.existingTargets.map((p) => `\`${p}\``).join(", ")}`;
      if (x.choices) text += `\n  可选: ${x.choices.join(" / ")}`;
      return text;
    }),
  );
  lines.push("## 冲突");
  lines.push(
    renderList(
      plan.conflicts,
      (x) =>
        `${x.label || "条目"}: \`${x.source}\` -> \`${x.target}\`${x.count ? ` (${x.count} 个冲突)` : ""}${x.existingTargets ? `；已存在: ${x.existingTargets.map((p) => `\`${p}\``).join(", ")}` : ""}${x.choices ? `；可选: ${x.choices.join(" / ")}` : ""}`,
    ),
  );
  lines.push("## 已迁移（本次跳过）");
  lines.push(
    renderList(
      plan.alreadyMigrated,
      (x) =>
        `[${scopeLabel(x.sourceScope)}] ${x.label || "条目"}: \`${x.source}\` -> \`${x.target}\``,
    ),
  );
  if (plan.alreadyMigrated.length) {
    lines.push(
      "> 以上项已在迁移状态文件中记录且目标仍存在，本次自动跳过。如需重新迁移，用 `--force-user`（仅用户级）或 `--force`（全部）。",
    );
    lines.push("");
  }
  lines.push("## 只报告");
  lines.push(
    renderList(
      plan.reportOnly,
      (x) =>
        `\`${x.source}\`${x.path ? ` ${x.path}` : ""}: ${x.reason}${x.detail ? `（${x.detail}）` : ""}`,
    ),
  );
  lines.push("## 不支持");
  lines.push(
    renderList(
      plan.unsupported,
      (x) => `\`${x.source}\`${x.path ? ` ${x.path}` : ""}: ${x.reason}`,
    ),
  );
  lines.push("## 未知");
  lines.push(renderList(plan.unknown, (x) => `\`${x.source}\` ${x.path}: ${x.summary}`));
  lines.push("## 空值已跳过");
  lines.push(renderList(plan.emptySkipped, (x) => `\`${x.source}\` ${x.path}`));
  lines.push("## 确认要求");
  lines.push(
    "- 按用户级、项目共享级、项目本地级分别列出要迁移和不迁移的内容，并让用户确认对应源路径、目标路径和资源类型。",
  );
  lines.push("- permissions、hooks、MCP secrets/env/headers、env 字段以及所有冲突必须单独确认。");
  lines.push(
    "- MCP 迁移必须展示每个 server 推导出的 transport 值；hooks 迁移必须展示结构转换后的 sid-code 形态。",
  );
  lines.push("");
  lines.push("## 模型配置提醒");
  lines.push(
    "- 如果 skills、agents、hooks、commands 或 output styles 中有 Claude 模型名、provider、auth 或模型相关环境变量，需要转换成 sid-code 支持的模型配置（provider/availableModels/subAgentModels），不能假定两边相同。",
  );
  lines.push("");
  lines.push("## 下一步");
  lines.push("把这个计划展示给用户。用户确认相关资源组之前，不要写文件。");
  lines.push("");
  return lines.join("\n");
}

try {
  const opts = parseArgs(process.argv.slice(2));
  const plan = inspect(opts);
  if (opts.format === "json") console.log(JSON.stringify(plan, null, 2));
  else process.stdout.write(renderMarkdown(plan));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
