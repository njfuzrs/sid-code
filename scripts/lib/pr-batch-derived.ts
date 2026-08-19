#!/usr/bin/env bun
/**
 * scripts/lib/pr-batch-derived.ts —— 派生问题（分叉）的机械核算。
 *
 * ## 治的是什么
 *
 * 交付一个 PR 的过程中会**派生新问题**（首次试跑实测：PR#63 派生了 #64 / #65）。
 * 原来的流程在这里断掉：prompt 只说「记下来告诉我」，之后没有任何下一步 ——
 * 没说开 issue、没说它进不进下一轮分层、没说方案文档要不要跟着修。
 * 于是派生问题只活在 GitHub 上，**不去翻 issue 列表就看不见**。
 *
 * 更危险的一类：派生问题会让**已经算好的分层结果失效**。实测 #64 要改
 * `gateway-pricing.ts`，而方案文档的 PR12 也要改这个文件 —— 这对冲突诞生在
 * 分层**之后**，所以判据从没算过它。
 *
 * ## 为什么是 TS 而不是继续写在 bash 里
 *
 * 这一层是**纯计算**（解析 issue 正文 + 解析方案文档 + 求交集），
 * 而 bash 那层是 I/O（gh / git）。拆开的唯一理由是**可测**：
 * 计算部分能用 fixture 离线跑单测并做变异自证，混在 bash 里就只能靠人肉看输出。
 * 本仓已有教训：门禁「绿了但没测到」是反复发作的病灶
 * （见 tests/build/ 下几个防漂移门禁的注释）。
 *
 * ## 状态派生，不维护（与 pr-batch.sh 同口径）
 *
 * 这里**一个字节都不存**。issue 清单现查 gh、PR 是否合并现查 gh、
 * 方案文档的 PR 足迹现读文档。唯一的持久状态是 GitHub 上的
 * `plan-doc-synced` 标签 —— 权威在 GitHub，不在本地文件。
 * 理由同 pr-batch.sh 顶部那段：存快照就必须回答「谁更新、何时更新、
 * 两处不一致听谁的」，而这些变化都不经过本脚本。
 */

// ─────────────────────────────────────────────────────────────
// 输入 / 输出类型
// ─────────────────────────────────────────────────────────────

export interface IssueInput {
  number: number;
  title: string;
  body: string;
  /** OPEN / CLOSED */
  state: string;
  labels: string[];
}

export interface Payload {
  /** 现查到的、正文里指回本批 PR 的 issue */
  issues: IssueInput[];
  /** 方案文档全文（读不到时省略 —— 那样就算不出冲突，必须显式警告而不是静默跳过） */
  planDoc?: string;
  planDocPath?: string;
  /** 本批已分层的 PR id（如 ["PR10","PR11"]）—— 它们不算「未做」 */
  batchPrIds: string[];
  /** 本批 PR 的当前状态，用于区分「层内还开着」与「已合入」 */
  batchPrs?: Array<{ id: string; number?: number; state?: string }>;
  /** 已合并的分支名（一次 gh pr list 拿到，避免 N 次调用） */
  mergedBranches: string[];
  /** git ls-files 的 .ts 清单，用于把裸文件名解析成真实路径并识别歧义 */
  repoFiles: string[];
}

/** issue 正文里的机械标记 —— 有它就不用猜，没有就退化成正文 grep。 */
export interface Marker {
  /** 派生自哪个 PR id（PR11） */
  from?: string;
  /** 派生自哪个 GitHub PR 号 */
  pr?: number;
  /** 这个 issue 会改哪些文件（权威，优于正文 grep） */
  files: string[];
  /** 若本 issue 推翻/修正了方案文档，写被推翻的小节号（如 §6.2） */
  planDocCorrection?: string;
}

export interface ReLayerFlag {
  /** 与哪个未做的 PR 撞上 */
  prId: string;
  file: string;
  /** 层内（本批另一路还开着）还是跨层（方案文档里还没做的 PR） */
  scope: "层内" | "未做的PR";
}

export interface IssueVerdict {
  number: number;
  title: string;
  state: string;
  files: string[];
  /** 文件清单的来源。marker = 高置信；prose = 低置信（可能含只是被引用的文件） */
  fileEvidence: "marker" | "prose" | "none";
  marker: Marker | null;
  reLayer: ReLayerFlag[];
  /** 方案文档回流：需要改哪一节、有没有回流过 */
  planDocCorrection: { section: string; synced: boolean } | null;
  /** 文件名在仓库里对应多个真实路径时登记，提醒结论是弱的 */
  ambiguous: Array<{ name: string; candidates: string[] }>;
}

export interface Report {
  verdicts: IssueVerdict[];
  warnings: string[];
  /** 未闭环项数：待重算的分层对 + 未回流的方案文档修正 */
  outstanding: number;
}

/** 标记里 `synced=yes` 之外，还接受 GitHub 标签作为「已回流」的权威来源。 */
export const SYNCED_LABEL = "plan-doc-synced";

// ─────────────────────────────────────────────────────────────
// 解析
// ─────────────────────────────────────────────────────────────

/**
 * 解析 issue 正文里的机械标记：
 *
 *   <!-- pr-batch: from=PR11 pr=63 files=packages/core/src/llm/gateway-pricing.ts plan-doc-correction=§6.2 -->
 *
 * ⚠️ 为什么要这个标记而不是一直靠正文 grep：正文里出现一个文件名，可能是
 * 「我要改它」，也可能是「我拿它当对照」。#64 正文同时出现 gateway-pricing.ts
 * （要改）和 model-capabilities.ts（对照 PR#63 已改的那半），grep 分不出来。
 * 分不出来的后果是**假阳性**：把「只是被引用」当成「会冲突」，
 * 报多了人就不看了 —— 这是本仓「防线自己成了死功能」的老路。
 */
export function parseMarker(body: string): Marker | null {
  const m = body.match(/<!--\s*pr-batch:\s*([\s\S]*?)-->/);
  if (!m) return null;

  const marker: Marker = { files: [] };
  // key=value，value 里不含空格（文件列表用逗号分隔）。
  for (const pair of m[1].trim().split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    const val = pair.slice(eq + 1);
    if (!val) continue;
    switch (key) {
      case "from":
        marker.from = val;
        break;
      case "pr":
        // 允许写 #63 或 63
        marker.pr = Number(val.replace(/^#/, "")) || undefined;
        break;
      case "files":
        marker.files = val
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "plan-doc-correction":
        marker.planDocCorrection = val;
        break;
    }
  }
  return marker;
}

/**
 * 没有标记时的退路：从正文里 grep `.ts` 路径。
 *
 * ⚠️ 这是**弱证据**，调用方必须把 fileEvidence 标成 prose 并在输出里写明，
 * 不能让它冒充标记的置信度。本仓铁律：说不出取数源的数字就是自我感觉。
 */
export function extractProseFiles(body: string): string[] {
  const hits = body.match(/[A-Za-z0-9_@./-]+\.ts\b/g) ?? [];
  const out: string[] = [];
  for (const h of hits) {
    // 去掉 markdown 反引号残留与行首标点
    const clean = h.replace(/^[`(]+/, "");
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

export interface PlanPr {
  id: string;
  branch?: string;
  /** 该 PR 小节里提到的 .ts 文件（裸名或路径） */
  files: string[];
}

/**
 * 从方案文档里提取「每个 PR 会碰哪些文件」+「PR 对应哪条分支」。
 *
 * 两个来源：
 *   ① P.3 总表的行  `| **PR1** | \`fix/catalog-vote-mode-not-min\`<br>...`  → 分支名
 *   ② `### PR1 — ...` 小节正文里出现的 .ts 文件名                          → 足迹
 *
 * ⚠️ 这只是**粗足迹**，没有行号，所以算不出 §3.3 的 C1/C2/C3 分级 ——
 * 只能判到「同文件」这一档。这是刻意的诚实降级：issue 正文里没有行号，
 * 硬编一个行号出来就是伪造判据输入。同文件即报「分层需重算」，
 * 真正的分级由下一轮 prepare 前的分层阶段（有 grep -n 足迹）来做。
 */
export function extractPlanPrs(md: string): PlanPr[] {
  const byId = new Map<string, PlanPr>();
  const get = (id: string): PlanPr => {
    let p = byId.get(id);
    if (!p) {
      p = { id, files: [] };
      byId.set(id, p);
    }
    return p;
  };

  // ① 总表：分支名
  for (const line of md.split("\n")) {
    const t = line.match(/^\|\s*\*\*(PR\d+)\*\*\s*\|\s*`([^`]+)`/);
    if (t) get(t[1]).branch = t[2];
  }

  // ② 小节足迹
  let cur = "";
  for (const line of md.split("\n")) {
    const h = line.match(/^###\s+(PR\d+)\b/);
    if (h) {
      cur = h[1];
      continue;
    }
    // 退出 PR 小节区：遇到更高层级标题就清空，避免把后面章节的文件名算进最后一个 PR
    if (/^##\s/.test(line)) {
      cur = "";
      continue;
    }
    if (!cur) continue;
    for (const f of line.match(/[A-Za-z0-9_@./-]+\.ts\b/g) ?? []) {
      const p = get(cur);
      const clean = f.replace(/^[`(]+/, "");
      if (!p.files.includes(clean)) p.files.push(clean);
    }
  }

  return [...byId.values()];
}

// ─────────────────────────────────────────────────────────────
// 核算
// ─────────────────────────────────────────────────────────────

const basename = (p: string): string => p.split("/").pop() ?? p;

/** 裸文件名 → 仓库里的真实路径。返回多条即歧义（如 config.ts 实测 5 处）。 */
export function resolveBasename(name: string, repoFiles: string[]): string[] {
  const b = basename(name);
  return repoFiles.filter((f) => basename(f) === b);
}

export function crossCheck(payload: Payload): Report {
  const warnings: string[] = [];
  const verdicts: IssueVerdict[] = [];

  const planPrs = payload.planDoc ? extractPlanPrs(payload.planDoc) : [];
  if (!payload.planDoc) {
    warnings.push(
      `读不到方案文档${payload.planDocPath ? `（${payload.planDocPath}）` : ""} → **算不出「派生问题与未做的 PR 撞不撞」**。` +
        `这不是「没有冲突」，是没算过。补上文档路径（plan.json 的 _plan）再跑。`,
    );
  } else if (planPrs.length === 0) {
    warnings.push(
      "方案文档里没解析出任何 `### PR<n>` 小节 → 足迹为空，冲突核算等于没做。" +
        "检查文档是否改了 PR 小节的标题格式。",
    );
  }

  // 未做的 PR：不在本批、且分支未合并（分支未知时按未做处理 —— 宁可多报一条）
  const merged = new Set(payload.mergedBranches);
  const pending = planPrs.filter(
    (p) => !payload.batchPrIds.includes(p.id) && !(p.branch && merged.has(p.branch)),
  );

  // 本批里还开着的路：它们构成「层内」冲突面，比跨层的更紧急
  const openInBatch = new Set(
    (payload.batchPrs ?? [])
      .filter((p) => p.state && p.state !== "MERGED" && p.state !== "CLOSED")
      .map((p) => p.id),
  );
  const batchPending = planPrs.filter((p) => openInBatch.has(p.id));

  let outstanding = 0;

  for (const issue of payload.issues) {
    const marker = parseMarker(issue.body);
    let files: string[];
    let fileEvidence: IssueVerdict["fileEvidence"];
    if (marker && marker.files.length > 0) {
      files = marker.files;
      fileEvidence = "marker";
    } else {
      files = extractProseFiles(issue.body);
      fileEvidence = files.length > 0 ? "prose" : "none";
      if (!marker) {
        warnings.push(
          `#${issue.number} 正文没有 pr-batch 标记 → 文件清单来自正文 grep（弱证据，可能含只是被引用的文件）。` +
            `新开的 issue 请按 scripts/pr-batch/fork-protocol.md 带上标记。`,
        );
      }
    }

    const ambiguous: IssueVerdict["ambiguous"] = [];
    for (const f of files) {
      if (f.includes("/")) continue; // 已是路径，不需要解析
      const cands = resolveBasename(f, payload.repoFiles);
      if (cands.length > 1) ambiguous.push({ name: f, candidates: cands });
    }

    // 求交集：按 basename 比（方案文档大量写裸名，issue 标记写全路径）
    const issueBases = new Set(files.map(basename));
    const reLayer: ReLayerFlag[] = [];
    const push = (list: PlanPr[], scope: ReLayerFlag["scope"]): void => {
      for (const p of list) {
        for (const f of p.files) {
          if (!issueBases.has(basename(f))) continue;
          if (reLayer.some((r) => r.prId === p.id && basename(r.file) === basename(f))) continue;
          reLayer.push({ prId: p.id, file: basename(f), scope });
        }
      }
    };
    push(batchPending, "层内");
    push(
      pending.filter((p) => !openInBatch.has(p.id)),
      "未做的PR",
    );

    // 方案文档回流
    let planDocCorrection: IssueVerdict["planDocCorrection"] = null;
    if (marker?.planDocCorrection) {
      planDocCorrection = {
        section: marker.planDocCorrection,
        synced: issue.labels.includes(SYNCED_LABEL),
      };
    }

    // 只有还开着的 issue 才算未闭环 —— 关掉的说明已经处置过了
    if (issue.state === "OPEN") {
      outstanding += reLayer.length;
      if (planDocCorrection && !planDocCorrection.synced) outstanding += 1;
    }

    verdicts.push({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      files,
      fileEvidence,
      marker,
      reLayer,
      planDocCorrection,
      ambiguous,
    });
  }

  return { verdicts, warnings, outstanding };
}

// ─────────────────────────────────────────────────────────────
// 渲染
// ─────────────────────────────────────────────────────────────

export function formatReport(report: Report, payload: Payload): string {
  const out: string[] = [];
  const open = report.verdicts.filter((v) => v.state === "OPEN").length;

  out.push(`派生问题（现查，共 ${report.verdicts.length} 条 / 还开着 ${open} 条）`);
  if (report.verdicts.length === 0) {
    out.push("  (无。本批 PR 的正文里没有指回来的 issue)");
  }

  for (const v of report.verdicts) {
    const ev =
      v.fileEvidence === "marker"
        ? "标记"
        : v.fileEvidence === "prose"
          ? "正文grep(弱)"
          : "无文件线索";
    out.push(`  #${v.number} [${v.state}] ${v.title.slice(0, 56)}`);
    out.push(`      文件(${ev}): ${v.files.length ? v.files.map(basename).join(", ") : "-"}`);
    if (v.marker?.from)
      out.push(`      派生自: ${v.marker.from}${v.marker.pr ? ` (PR #${v.marker.pr})` : ""}`);

    for (const r of v.reLayer) {
      out.push(`      ⚠️ 分层需重算[${r.scope}]: ${r.file} 与 ${r.prId} 同文件`);
    }
    if (v.planDocCorrection) {
      out.push(
        v.planDocCorrection.synced
          ? `      ✅ 方案文档 ${v.planDocCorrection.section} 已回流`
          : `      ⚠️ 方案文档回流未做: ${v.planDocCorrection.section}（改完跑 pr-batch reflow ${v.number} --synced）`,
      );
    }
    for (const a of v.ambiguous) {
      out.push(
        `      ⓘ ${a.name} 在仓库里有 ${a.candidates.length} 处同名，结论是弱的: ${a.candidates.slice(0, 3).join(", ")}`,
      );
    }
  }

  if (report.warnings.length) {
    out.push("");
    out.push("⚠️ 核算本身的缺口（不是结论，是「这次没算到」）:");
    for (const w of report.warnings) out.push(`  · ${w}`);
  }

  out.push("");
  if (report.outstanding === 0) {
    out.push("✅ 无未闭环项：没有需要重算的分层，也没有待回流的方案文档修正。");
  } else {
    out.push(`⛔ ${report.outstanding} 项未闭环。处置：`);
    out.push(
      "  · 「分层需重算」→ 下一轮 prepare 之前，把该 issue 与撞上的 PR 一起做一次分层（要 grep -n 行号足迹）",
    );
    out.push(
      "  · 「方案文档回流」→ pr-batch reflow <issue> 拿到可粘贴的修正块，改完再 --synced 标记",
    );
  }
  out.push("");
  out.push(
    `口径：issue 清单来自 gh 现查（正文指回本批 PR），未做的 PR 来自方案文档现读` +
      `${payload.planDocPath ? `（${payload.planDocPath}）` : ""}，合并状态来自 gh。一个字节都不缓存。`,
  );
  out.push("⚠️ 这里只判到「同文件」这一档 —— issue 正文没有行号，算不出 §3.3 的 C1/C2/C3 分级。");

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────
// CLI：stdin 收 JSON，stdout 出报告。退出码 4 = 有未闭环项（分类结果，不是失败）
// ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  const raw = await Bun.stdin.text();
  let payload: Payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    console.error(`FATAL: stdin 不是合法 JSON：${(e as Error).message}`);
    process.exit(1);
  }
  const report = crossCheck(payload);
  // --json 给 prepare 的守卫用（它要按 prId 精确匹配，不能去 grep 人类可读的报告）。
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report));
    process.exit(report.outstanding > 0 ? 4 : 0);
  }
  console.log(formatReport(report, payload));
  // ⚠️ 独立退出码 4：与 check-gen 的 3 同一套约定 —— 它是**分类结果**，
  //    不是门禁失败。混用 1 会让上层脚本把「发现未闭环项」当成「脚本炸了」。
  process.exit(report.outstanding > 0 ? 4 : 0);
}
