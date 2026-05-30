/**
 * eval:dashboard-html — 生成 evals/eval-dashboard.html + evals/eval-data.json
 *
 * 设计参考:docs/eval/演进路线/评测系统html.md
 *
 * 用法:
 *   bun run eval:dashboard-html
 *   bun run eval:dashboard-html -- --project-root /path/to
 *   bun run eval:dashboard-html -- --output-html /custom/eval-dashboard.html --output-data /custom/eval-data.json
 *
 * 设计要点:
 *   - 复用 buildProjectSnapshot()(scripts/eval/lib/yaml-loader.ts),不重写 yaml 解析
 *   - eval-data.json 为外部 JSON 文件,HTML 用 fetch() 加载,不内嵌(规避 5-15MB 单文件 git diff 崩溃)
 *   - HTML vanilla JS + 原生 Web,不依赖 React/Vue;Pico.css CDN 兜底排版
 *   - 不做"自动写回磁盘"按钮(撞 §0.3 core_code L3 红线)
 *   - 6 维 anchor_hit / rubric_score / tool_compliance / negative_anchor / efficiency / cost
 *     绝对权重(总和 10.0,非归一)
 *   - case 按 grader_type 分组(rubric_5d / binary_redline / structured_arch / execution_test)
 *     不能跨组聚合
 *   - holdout 按目录前缀 evals/holdout/** 判定,不 hardcode case ID
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { buildProjectSnapshot, type CaseDoc, type ProjectSnapshot } from "./lib/yaml-loader";

// 与 evals/eval-judge.ts:246 保持一致(绝对权重,总和 10.0,非归一)。
// 升级 grader 时同步刷新本常量(同 yaml-loader.LATEST_GRADER_VERSION)。
const DEFAULT_WEIGHTS_5D_V3: Record<string, number> = {
  anchor_hit: 1.5,
  rubric_score: 4.0,
  tool_compliance: 1.5,
  negative_anchor: 2.0,
  efficiency: 0,
  cost: 0,
};

const GRADER_VERSION = "5d-v3";

// 设计文档 §2.5:fix_type 是 6 类
const FIX_TYPES = [
  "case_design",
  "skill_prompt",
  "infra_bug",
  "entry_code",
  "core_code",
  "new_module",
];

interface CaseExportRow {
  id: string;
  bucket: string;
  category: string | null;
  priority: string | null;
  graderType: string;
  isHoldout: boolean;
  graduatedAt: string | null;
  targetScore: number | null;
  filePath: string;
  userQuery: string;
  // baseline_scores per provider(已扁平),只展示当前 grader 版本数据 + legacy 标记
  baseline: Record<string, BaselineCell>;
}

interface BaselineCell {
  provider: string;
  score: number | null;
  status: "tested" | "pending" | "error" | "timeout" | "legacy";
  testedAt: string | null;
  graderVersion: string | null;
  costVersion: string | null;
  // dimensions 来自 baseline_scores,只是快照,模拟器不读这里
  dimensions?: Record<string, number | null>;
  notes?: string;
}

interface RunExportRow {
  runId: string;
  testedAt: string;
  week: number;
  caseId: string;
  provider: string;
  score: number | null;
  namedScores: Record<string, number | null>;
  latencyMs: number;
  runStatus: string;
}

interface DashboardData {
  meta: {
    projectName: string;
    generatedAt: string;
    graderVersion: string;
    defaultWeights: Record<string, number>;
    fixTypes: string[];
    // 当前已知的 holdout 总数(目录扫描)
    holdoutCount: number;
    casesTotal: number;
    providers: string[];
  };
  cases: CaseExportRow[];
  runs: RunExportRow[];
  // grader_type 桶 → case ID 列表(快速分组)
  graderBuckets: Record<string, string[]>;
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "project-root": { type: "string" },
      "project-name": { type: "string" },
      "output-html": { type: "string" },
      "output-data": { type: "string" },
      // --serve(可选 --port=4174 / --no-browser):跑完直接起 Bun server + 自动打开浏览器
      serve: { type: "boolean", default: false },
      port: { type: "string" },
      "no-browser": { type: "boolean", default: false },
    },
  });

  const projectRoot = resolvePath(values["project-root"] as string | undefined, process.cwd());
  const evalsDir = join(projectRoot, "evals");
  if (!existsSync(evalsDir)) {
    console.error(`[eval:dashboard-html] 未找到 evals/ 目录: ${evalsDir}`);
    process.exit(1);
  }

  const projectName =
    (values["project-name"] as string | undefined) ?? basename(projectRoot);
  const htmlOut = resolvePath(
    values["output-html"] as string | undefined,
    process.cwd(),
    join(evalsDir, "eval-dashboard.html"),
  );
  const dataOut = resolvePath(
    values["output-data"] as string | undefined,
    process.cwd(),
    join(evalsDir, "eval-data.json"),
  );

  const t0 = Date.now();
  const snapshot = buildProjectSnapshot(evalsDir, projectName);
  const data = buildDashboardData(snapshot);
  const html = renderHtmlShell(projectName);

  ensureDir(htmlOut);
  ensureDir(dataOut);
  writeFileSync(dataOut, JSON.stringify(data, null, 2), "utf-8");
  writeFileSync(htmlOut, html, "utf-8");

  const dt = Date.now() - t0;
  const dataKb = (Buffer.byteLength(JSON.stringify(data)) / 1024).toFixed(1);
  console.log(`[eval:dashboard-html] 写入 ${htmlOut}`);
  console.log(`[eval:dashboard-html] 写入 ${dataOut} (${dataKb} KB)`);
  console.log(
    `  cases=${data.cases.length}  runs=${data.runs.length}  providers=${data.meta.providers.length}  耗时=${dt}ms`,
  );
  console.log(
    `  graderBuckets: ${Object.entries(data.graderBuckets)
      .map(([k, v]) => `${k}=${v.length}`)
      .join("  ")}`,
  );

  if (values.serve) {
    const port = values.port ? parseInt(values.port as string, 10) : 4174;
    const shouldOpen = !values["no-browser"];
    startServer(dirname(htmlOut), basename(htmlOut), port, shouldOpen);
  }
}

/**
 * 起一个简单的 Bun 静态文件 server,服务 evals/ 目录,并可选自动打开浏览器。
 *
 * 端口被占用时自动 +1 重试(最多 10 次),避免 EADDRINUSE 直接退出。
 */
function startServer(rootDir: string, htmlName: string, basePort: number, autoOpen: boolean): void {
  const tryPort = (port: number, attempt = 0): void => {
    try {
      const server = (Bun as typeof Bun & {
        serve: (opts: {
          port: number;
          fetch: (req: Request) => Response | Promise<Response>;
        }) => { port: number; stop: () => void };
      }).serve({
        port,
        fetch(req: Request) {
          const url = new URL(req.url);
          let path = decodeURIComponent(url.pathname);
          if (path === "/" || path === "") path = "/" + htmlName;
          const file = join(rootDir, path);
          // 防御:确保 file 仍在 rootDir 内,挡住 ../ 越界
          if (!file.startsWith(rootDir)) return new Response("forbidden", { status: 403 });
          if (!existsSync(file)) return new Response("not found", { status: 404 });
          return new Response(Bun.file(file));
        },
      });
      const url = `http://localhost:${server.port}/${htmlName}`;
      console.log(`\n[eval:dashboard-html] 🌐 server 已启动:${url}`);
      console.log(`  数据/文件根目录: ${rootDir}`);
      console.log(`  Ctrl+C 停止`);
      if (autoOpen) openInBrowser(url);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg.includes("EADDRINUSE") && attempt < 10) {
        console.log(`[eval:dashboard-html] 端口 ${port} 被占用,试 ${port + 1} ...`);
        tryPort(port + 1, attempt + 1);
        return;
      }
      console.error(`[eval:dashboard-html] server 启动失败: ${msg}`);
      process.exit(1);
    }
  };
  tryPort(basePort);
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    // 用 Bun.spawn 异步打开,不阻塞 server
    (Bun as typeof Bun & {
      spawn: (args: { cmd: string[]; stdout?: string; stderr?: string }) => unknown;
    }).spawn({
      cmd: platform === "win32" ? ["cmd", "/c", cmd, "", url] : [cmd, url],
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    console.log(`[eval:dashboard-html] 自动打开浏览器失败,请手动访问:${url}`);
  }
}

function buildDashboardData(snapshot: ProjectSnapshot): DashboardData {
  const cases: CaseExportRow[] = [];
  const graderBuckets: Record<string, string[]> = {};
  const providerSet = new Set<string>(snapshot.tools);

  for (const c of snapshot.cases) {
    const graderType = inferGraderType(c);
    const isHoldout = isHoldoutCase(c);
    const baseline = extractBaselineCells(c);
    for (const k of Object.keys(baseline)) providerSet.add(k);

    const row: CaseExportRow = {
      id: c.id,
      bucket: c.bucket,
      category: (c.category as string) ?? null,
      priority: (c.priority as string) ?? null,
      graderType,
      isHoldout,
      graduatedAt: typeof (c as any).graduated_at === "string" ? (c as any).graduated_at : null,
      targetScore: typeof c.target_score === "number" ? c.target_score : null,
      filePath: relPath(c.filePath, snapshot.evalsDir),
      userQuery: extractUserQuery(c),
      baseline,
    };
    cases.push(row);
    if (!graderBuckets[graderType]) graderBuckets[graderType] = [];
    graderBuckets[graderType].push(c.id);
  }

  const runs: RunExportRow[] = [];
  for (const [provider, records] of snapshot.runHistory.entries()) {
    providerSet.add(provider);
    for (const r of records) {
      runs.push({
        runId: r.runId,
        testedAt: r.testedAt,
        week: r.week,
        caseId: r.caseId,
        provider: r.provider || provider,
        score: r.score,
        namedScores: r.namedScores ?? {},
        latencyMs: r.latencyMs,
        runStatus: r.runStatus,
      });
    }
  }

  const providers = [...providerSet].sort();

  const holdoutCount = cases.filter((c) => c.isHoldout).length;
  return {
    meta: {
      projectName: snapshot.projectName,
      generatedAt: new Date().toISOString(),
      graderVersion: GRADER_VERSION,
      defaultWeights: DEFAULT_WEIGHTS_5D_V3,
      fixTypes: FIX_TYPES,
      holdoutCount,
      casesTotal: cases.length,
      providers,
    },
    cases,
    runs,
    graderBuckets,
  };
}

export function inferGraderType(c: CaseDoc): string {
  // 1. 显式声明优先
  const declared = (c as any).grader_type;
  if (typeof declared === "string" && declared.length > 0) return declared;

  // 2. 路径推断:architecture/redline → binary_redline,architecture/* → structured_arch
  if (c.bucket.startsWith("architecture/redline") || c.bucket.startsWith("holdout/architecture/redline")) {
    return "binary_redline";
  }
  if (c.bucket.startsWith("architecture/") || c.bucket.startsWith("holdout/architecture/")) {
    return "structured_arch";
  }

  // 3. execution / trajectory 轴（与 yaml-loader.isExecutionBucket / isTrajectoryBucket 同口径）
  if (c.bucket === "general/execution" || c.bucket.startsWith("general/execution/")) {
    return "execution_test";
  }
  if (
    c.bucket === "real-tasks" ||
    c.bucket.startsWith("real-tasks/") ||
    c.bucket === "holdout/real-tasks" ||
    c.bucket.startsWith("holdout/real-tasks/")
  ) {
    return "trajectory_match";
  }

  // 4. 默认 general 类走 5d-v3
  return "rubric_5d";
}

function isHoldoutCase(c: CaseDoc): boolean {
  if (c.holdout === true) return true;
  // 路径前缀 evals/holdout/** 判定(设计文档 §2.3)
  if (c.bucket === "holdout") return true;
  if (c.bucket.startsWith("holdout/")) return true;
  return false;
}

function extractUserQuery(c: CaseDoc): string {
  const q = c.input?.user_query;
  if (typeof q !== "string") return "";
  return q.length > 400 ? q.slice(0, 400) + "…" : q;
}

function extractBaselineCells(c: CaseDoc): Record<string, BaselineCell> {
  const out: Record<string, BaselineCell> = {};
  if (!c.baseline_scores) return out;
  for (const [provider, raw] of Object.entries(c.baseline_scores)) {
    if (!raw || typeof raw !== "object") continue;
    const score = typeof raw.score === "number" ? raw.score : null;
    const grader = raw._formula_version?.grader ?? null;
    const cost = raw._formula_version?.cost ?? null;
    let status: BaselineCell["status"] = "pending";
    if (raw.run_status === "success") {
      // legacy 标记:grader 字段缺失或非当前版本
      status = grader && grader === GRADER_VERSION ? "tested" : "legacy";
    } else if (raw.run_status === "error") status = "error";
    else if (raw.run_status === "timeout") status = "timeout";
    else if (score == null) status = "pending";
    else status = grader && grader === GRADER_VERSION ? "tested" : "legacy";

    const dims = (raw as any).dimensions as Record<string, number | null> | undefined;
    out[provider] = {
      provider,
      score,
      status,
      testedAt: typeof raw.tested_at === "string" ? raw.tested_at : null,
      graderVersion: grader,
      costVersion: cost,
      dimensions: dims,
      notes: raw.notes,
    };
  }
  return out;
}

function relPath(abs: string, evalsDir: string): string {
  if (abs.startsWith(evalsDir)) {
    return "evals" + abs.slice(evalsDir.length);
  }
  return abs;
}

function ensureDir(filePath: string): void {
  const d = dirname(filePath);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function resolvePath(arg: string | undefined, base: string, fallback?: string): string {
  if (!arg) return fallback ?? base;
  return isAbsolute(arg) ? arg : join(base, arg);
}

function renderHtmlShell(projectName: string): string {
  const tpl = readFileSync(
    join(import.meta.dir, "lib", "dashboard-html-template.html"),
    "utf-8",
  );
  return tpl.replace(/\{\{PROJECT_NAME\}\}/g, escapeHtml(projectName));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

if (import.meta.main) {
  main();
}
