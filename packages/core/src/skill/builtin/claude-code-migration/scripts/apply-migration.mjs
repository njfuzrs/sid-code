#!/usr/bin/env node
/**
 * Claude Code -> sid-code 确定性写入脚本（patch 式合并，绝不整体覆盖）
 *
 * 存在意义（2026-07 迁移 skill 崩溃复盘）：此前 SKILL.md 要求"读入现有 JSON → 只加确认
 * 字段 → 写回"，但没给现成工具，逼模型即兴写 /tmp/*.mjs 做合并——于是踩了两个坑：
 *   错误 1：模型写 .mjs 却用 require（ES module 不支持）→ 崩。
 *   错误 2：模型改走 write 工具、把 JSON 配置作为字符串传入 content，被 normalize 误解析
 *           成对象 → write 的 content:string 校验报错。
 * 根治：把"确定性 JSON 变换"从模型手里收回，交给这个受测脚本。模型只负责调用 + 传参。
 *
 * 铁律（与 inspector 对齐）：
 *   - 只做 patch 式合并：读现有目标 JSON → 只新增缺失的键 → 写回。绝不整体覆盖。
 *   - 目标键已存在 = 冲突：默认跳过并在结果里报告，不覆盖（除非 --on-conflict=overwrite 显式要求）。
 *   - 不联网、不安装。只读源 + 读写指定目标文件。
 *   - MCP：写入时做 type->transport 转换、disabled->enabled、丢弃 sid-code 不支持字段。
 *   - 不写 secret 到状态文件（本脚本不碰状态文件，状态记账仍由模型按 SKILL.md 走）。
 *
 * 用法：
 *   node apply-migration.mjs --op merge-settings --target <settings.json> --patch '<json>' [--on-conflict skip|overwrite]
 *   node apply-migration.mjs --op merge-mcp --target <.mcp.json 或 settings.json> --servers '<json>' [--on-conflict skip|overwrite]
 *   参数也可用 --patch-file / --servers-file 从文件读，避免超长命令行。
 *   加 --dry-run 只输出将要写入的结果，不落盘。
 *   结果以 JSON 输出到 stdout：{ ok, op, target, written, added:[], conflicts:[], transforms:[], skipped:[] }
 */
import fs from 'node:fs';
import path from 'node:path';

/** sid-code 支持的 MCP server 字段（与 inspect-migration.mjs / src/config/settings/types.ts 对齐） */
const MCP_FIELDS = new Set([
  'transport',
  'command',
  'args',
  'env',
  'url',
  'headers',
  'enabled',
  'timeout',
  'retries',
  'includeTools',
  'excludeTools',
]);

function fail(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    op: null,
    target: null,
    patch: null,
    patchFile: null,
    servers: null,
    serversFile: null,
    onConflict: 'skip',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--op': opts.op = next(); break;
      case '--target': opts.target = next(); break;
      case '--patch': opts.patch = next(); break;
      case '--patch-file': opts.patchFile = next(); break;
      case '--servers': opts.servers = next(); break;
      case '--servers-file': opts.serversFile = next(); break;
      case '--on-conflict': opts.onConflict = next(); break;
      case '--dry-run': opts.dryRun = true; break;
      default:
        if (arg.startsWith('--')) fail(`未知参数: ${arg}`);
    }
  }
  return opts;
}

/** 去注释后 parse（兼容 Claude 侧 JSONC；sid-code 目标文件通常是纯 JSON） */
function stripJsonComments(input) {
  let out = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const nx = input[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; continue; }
    if (ch === '/' && nx === '/') { while (i < input.length && input[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && nx === '*') { i += 2; while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++; i++; continue; }
    out += ch;
  }
  return out;
}

function readJsonFile(pathname) {
  if (!fs.existsSync(pathname)) return { exists: false, value: undefined };
  const raw = fs.readFileSync(pathname, 'utf8');
  try {
    return { exists: true, value: JSON.parse(stripJsonComments(raw)) };
  } catch (e) {
    fail(`目标文件 JSON 解析失败（${pathname}）: ${e.message}`);
  }
}

function parseJsonArg(str, label) {
  try {
    return JSON.parse(str);
  } catch (e) {
    fail(`${label} 不是合法 JSON: ${e.message}`);
  }
}

/** 从 Claude MCP server 配置推导 sid-code transport（与 inspector inferTransport 完全一致） */
function inferTransport(cfg) {
  const t = typeof cfg.type === 'string' ? cfg.type.toLowerCase() : '';
  if (t === 'stdio' || t === 'http' || t === 'sse' || t === 'ws') return t;
  if (cfg.command) return 'stdio';
  if (cfg.url) return 'http';
  return null;
}

/**
 * 把一个 Claude MCP server 配置转成 sid-code 形态：
 *   - type -> transport
 *   - disabled -> enabled(取反)
 *   - 丢弃 sid-code 不支持字段（cwd/trust/oauth 等）
 * 返回 { server, transforms:[], dropped:[] }
 */
function convertMcpServer(name, cfg, transforms) {
  const out = {};
  const dropped = [];
  const transport = inferTransport(cfg);
  if (transport) {
    out.transport = transport;
    if (cfg.type) transforms.push(`${name}: type="${cfg.type}" -> transport="${transport}"`);
  } else {
    transforms.push(`${name}: 无法推导 transport（缺 type/command/url），已按原样保留待人工指定`);
  }
  for (const [key, value] of Object.entries(cfg)) {
    if (key === 'type') continue; // 已转 transport
    if (key === 'disabled') {
      out.enabled = !value;
      transforms.push(`${name}: disabled=${value} -> enabled=${!value}`);
      continue;
    }
    if (MCP_FIELDS.has(key)) {
      out[key] = value;
    } else {
      dropped.push(key);
    }
  }
  if (dropped.length) transforms.push(`${name}: 丢弃 sid-code 不支持字段 [${dropped.join(', ')}]`);
  return out;
}

/** 原子写：先写临时文件再 rename，避免半写坏文件 */
function atomicWriteJson(pathname, value) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const text = JSON.stringify(value, null, 2) + '\n';
  const tmp = `${pathname}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, pathname);
}

/**
 * merge-settings：把 patch 对象的顶层键并入目标 settings.json。
 * 只新增缺失键；已存在的键算冲突（默认跳过、报告）。嵌套对象（如 mcpServers/hooks）
 * 递归到"命名条目"一层做 key 级合并——保证不覆盖用户已有条目。
 */
function opMergeSettings(opts) {
  const patch = opts.patchFile
    ? readJsonFile(opts.patchFile).value
    : parseJsonArg(opts.patch ?? '', '--patch');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    fail('--patch 必须是 JSON 对象');
  }
  const cur = readJsonFile(opts.target);
  const base = cur.exists && cur.value && typeof cur.value === 'object' && !Array.isArray(cur.value)
    ? cur.value
    : {};

  const added = [];
  const conflicts = [];
  const result = { ...base };

  for (const [topKey, topVal] of Object.entries(patch)) {
    const isNamedMap =
      topVal && typeof topVal === 'object' && !Array.isArray(topVal) &&
      base[topKey] && typeof base[topKey] === 'object' && !Array.isArray(base[topKey]);
    if (isNamedMap) {
      // 命名条目级合并（mcpServers.<name>、env.<KEY> 等）：逐条判冲突
      const merged = { ...base[topKey] };
      for (const [name, entry] of Object.entries(topVal)) {
        if (name in merged) {
          if (opts.onConflict === 'overwrite') { merged[name] = entry; added.push(`${topKey}.${name} (覆盖)`); }
          else conflicts.push(`${topKey}.${name}`);
        } else {
          merged[name] = entry;
          added.push(`${topKey}.${name}`);
        }
      }
      result[topKey] = merged;
    } else if (topKey in base) {
      if (opts.onConflict === 'overwrite') { result[topKey] = topVal; added.push(`${topKey} (覆盖)`); }
      else conflicts.push(topKey);
    } else {
      result[topKey] = topVal;
      added.push(topKey);
    }
  }

  const written = !opts.dryRun && added.length > 0;
  if (written) atomicWriteJson(opts.target, result);
  return {
    ok: true,
    op: 'merge-settings',
    target: opts.target,
    written,
    dryRun: opts.dryRun,
    added,
    conflicts,
    result: opts.dryRun ? result : undefined,
  };
}

/**
 * merge-mcp：把 Claude 侧 mcpServers 转换（transport 等）后并入目标文件的 mcpServers。
 * 目标可为项目根 .mcp.json（顶层就是 { mcpServers: {...} }）或 settings.json。
 * 已存在的 server 名算冲突，默认跳过。
 */
function opMergeMcp(opts) {
  const rawServers = opts.serversFile
    ? readJsonFile(opts.serversFile).value
    : parseJsonArg(opts.servers ?? '', '--servers');
  // 兼容传入 { mcpServers: {...} } 或直接传 { <name>: {...} }
  const servers = rawServers?.mcpServers ?? rawServers?.mcp_servers ?? rawServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    fail('--servers 必须是 JSON 对象（mcpServers 映射，或含 mcpServers 字段的对象）');
  }

  const cur = readJsonFile(opts.target);
  const base = cur.exists && cur.value && typeof cur.value === 'object' && !Array.isArray(cur.value)
    ? cur.value
    : {};
  const existing = base.mcpServers && typeof base.mcpServers === 'object' && !Array.isArray(base.mcpServers)
    ? { ...base.mcpServers }
    : {};

  const added = [];
  const conflicts = [];
  const transforms = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      transforms.push(`${name}: 跳过（server 配置不是对象）`);
      continue;
    }
    if (name in existing) {
      if (opts.onConflict === 'overwrite') {
        existing[name] = convertMcpServer(name, cfg, transforms);
        added.push(`${name} (覆盖)`);
      } else {
        conflicts.push(name);
      }
      continue;
    }
    existing[name] = convertMcpServer(name, cfg, transforms);
    added.push(name);
  }

  const result = { ...base, mcpServers: existing };
  const written = !opts.dryRun && added.length > 0;
  if (written) atomicWriteJson(opts.target, result);
  return {
    ok: true,
    op: 'merge-mcp',
    target: opts.target,
    written,
    dryRun: opts.dryRun,
    added,
    conflicts,
    transforms,
    result: opts.dryRun ? result : undefined,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.op) fail('缺少 --op（merge-settings | merge-mcp）');
  if (!opts.target) fail('缺少 --target');
  if (opts.onConflict !== 'skip' && opts.onConflict !== 'overwrite') {
    fail('--on-conflict 只能是 skip 或 overwrite');
  }
  let out;
  if (opts.op === 'merge-settings') out = opMergeSettings(opts);
  else if (opts.op === 'merge-mcp') out = opMergeMcp(opts);
  else fail(`未知 --op: ${opts.op}`);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main();
