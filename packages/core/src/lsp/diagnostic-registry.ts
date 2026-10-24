/**
 * 诊断注册表：被动推（publishDiagnostics）与主动拉（codeAction）两条链路的唯一交汇点
 *
 * 三份互相独立的状态：
 * - pending：待投递给模型的诊断，**按 uri 存最新全量快照**（publishDiagnostics 语义即
 *   「该文档的全量诊断」，后到覆盖先到）。每个文件归属于最近编辑它的消费者；
 *   没被编辑过的文件（只被 lsp 工具打开）归主循环，且首次推送只记基线不投递。
 * - delivered：已投递过的诊断 key（跨轮次去重，LRU）。
 * - latest：每个文件最新全量快照，只读镜像，供 codeAction 填 `context.diagnostics`，
 *   从不被 collect 消费。
 *
 * 体积限制（对标 Claude Code）：每文件最多 10 条、单次总计最多 30 条。
 * 只有 Error / Warning 参与限流；Hint / Info 不注入，只计数告知。
 */

import type { Diagnostic, DiagnosticFile, DiagnosticSeverity } from "./types.ts";

/** 限流常量（对标 Claude Code） */
const MAX_DIAGNOSTICS_PER_FILE = 10;
const MAX_TOTAL_DIAGNOSTICS = 30;
const MAX_DELIVERED_FILES = 500; // LRU 缓存上限

/** 严重程度排序权重（数字越小越靠前） */
const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  Error: 0,
  Warning: 1,
  Info: 2,
  Hint: 3,
};

/** 主循环的诊断归属者 id。子代理用自己的 agentId。 */
export const MAIN_DIAGNOSTIC_OWNER = "main";

/** 可注入（可操作）的严重度。Hint / Info 只计数不注入。 */
function isActionable(d: Diagnostic): boolean {
  return d.severity === "Error" || d.severity === "Warning";
}

/** publishDiagnostics 带来的单个文件：比 DiagnosticFile 多一个可选的文档版本号 */
export type PublishedDiagnosticFile = DiagnosticFile & { version?: number | null };

/** 每个被编辑过的文件的同步状态 */
interface DocState {
  /** 最近一次编辑该文件的消费者（主循环 / 某个子代理）。诊断只投递给它。 */
  owner: string;
  /** beginEdit 之后、didChange 发出之前为 true：这段时间到达的诊断必然基于旧内容 */
  syncing: boolean;
  /** 同一文件可能被并发编辑，只有最后一次 beginEdit 对应的 endEdit 才能结束 syncing */
  syncSeq: number;
  /** 最近一次发给服务器的文档版本（didOpen=1，didChange 递增） */
  sentVersion?: number;
}

interface PendingEntry {
  /** 该 uri 的最新全量快照 */
  diagnostics: Diagnostic[];
  /** 本快照里的 Hint/Info 是否已计入过「已省略」——快照因补发留在 pending 时不重复计数 */
  infoCounted: boolean;
}

/** 两次 collect 之间的推送计数（按归属者记，未归属的文件记到主循环名下） */
interface PublishCounters {
  publishes: number;
  publishesWithVersion: number;
  /** 编辑同步窗口内到达、被丢弃的推送 */
  staleSyncing: number;
  /** 版本号落后于已发出版本、被丢弃的推送 */
  staleVersion: number;
}

function emptyCounters(): PublishCounters {
  return { publishes: 0, publishesWithVersion: 0, staleSyncing: 0, staleVersion: 0 };
}

/** 一次 collect 的结果分类（进轨迹，用来区分「没注入」的成因） */
export type CollectOutcome =
  /** 有诊断注入 */
  | "injected"
  /** 作用域内没有任何 pending */
  | "empty"
  /** 作用域内文件全部零诊断（服务器说错误已清空——修复生效的信号） */
  | "clean"
  /** 只有 Hint/Info，被严重度过滤后为空 */
  | "info_only"
  /** 可操作诊断全部投递过（跨轮次去重后为空） */
  | "all_delivered";

export interface CollectStats extends PublishCounters {
  outcome: CollectOutcome;
  /** 作用域内有 pending 的文件数 */
  files: number;
  /** 作用域内 Error/Warning 条数（去重后，含已投递） */
  actionable: number;
  /** 其中已投递过而被跨轮次去重的条数 */
  alreadyDelivered: number;
  /** 本次注入条数 */
  injected: number;
  /** 超出单次上限、留在 pending 待后续轮次补发的条数 */
  carried: number;
  /** 本次新计入的 Hint/Info 条数（不注入，只告知） */
  omittedInfo: number;
}

export interface CollectResult {
  files: DiagnosticFile[];
  stats: CollectStats;
}

export class DiagnosticRegistry {
  /** 待投递：uri → 最新全量快照 */
  private pending = new Map<string, PendingEntry>();
  /** 已投递的诊断（LRU 缓存，防止无限增长） */
  private delivered = new Map<string, Set<string>>();
  private deliveredOrder: string[] = [];
  /** 被编辑过的文件 → 归属者与同步状态 */
  private docs = new Map<string, DocState>();
  /** 归属者 → 两次 collect 之间的推送计数 */
  private counters = new Map<string, PublishCounters>();
  /**
   * 已记过基线的未编辑文件。
   *
   * 只被 lsp 工具打开、从没被编辑的文件，首次推送里的诊断是**既有问题**，不是 agent 引入的，
   * 旧实现照样以「你刚编辑文件」的名义注入（会话 20261022-003851-9f9e6c25 实测：
   * 模型只用 lsp 工具看了 docs-gen-reference.ts，下一轮就收到了它的诊断）。
   * 首次推送只把可操作诊断记为已投递（基线），之后新出现的才投递给主循环——
   * 这保留了「改 a.ts 弄坏了已打开的 b.ts」这类跨文件信号。
   * 代价：b.ts 若在 a.ts 编辑之后才首次推送，那次破坏会被当成基线吞掉。
   */
  private baselined = new Set<string>();
  /**
   * 每个文件的**最新**诊断全量快照（uri → 诊断数组）。
   *
   * 与 pending/delivered 的"消费即清空"语义**完全独立**：pending 供每轮注入消费，
   * 而 latest 是只读镜像，只被 registerPending 覆盖、被 clearForFile/clear 清除，
   * 从不被 collect 消费。存在的唯一目的是给 codeAction 这类 pull 式查询提供 `context.diagnostics`——
   * 多数语言服务器在 context 无诊断时返回空 quickfix 列表，而我们不能为此去偷 pending
   * （否则注入链断掉）。LSP publishDiagnostics 语义即"该文档的全量诊断"，故每次覆盖。
   */
  private latest = new Map<string, Diagnostic[]>();

  /**
   * 等待某个 uri 的 publishDiagnostics 到达的等待者（uri → resolve 回调集合）。
   *
   * 存在的理由见 `waitForDiagnostics`：LSP 的诊断是**服务器推**的，`didOpen` 是不等响应的
   * 通知，所以"文件刚打开就查诊断"必然拿到空。
   */
  private waiters = new Map<string, Set<() => void>>();

  private countersFor(owner: string): PublishCounters {
    let c = this.counters.get(owner);
    if (!c) {
      c = emptyCounters();
      this.counters.set(owner, c);
    }
    return c;
  }

  /**
   * 编辑开始：同步调用，必须先于任何 await（见 manager.syncFileToLSP）。
   *
   * 为什么必须同步：旧实现在 `await readFile` 之后才清该文件的旧诊断，而 edit/write 的
   * LSP 同步是 fire-and-forget 的。主循环下一轮 collect 可能跑在清理之前，于是把编辑前
   * 的诊断当成编辑后的注入给模型（会话 20261012-134748-9496c880 第 52 次请求实测：
   * 模型刚把 `React.useRef` 改成 `useRef`，注入仍报 `'useRef' is declared but never read`，
   * 模型回 "the LSP diagnostic is likely stale" 并多花一轮重读文件）。
   *
   * 做三件事：登记归属者；清掉该文件的 pending / delivered / latest；进入 syncing 态——
   * 直到 didChange 发出前到达的推送都基于旧内容，一律丢弃。
   *
   * @returns 本次编辑序号，交给 endEdit 配对
   */
  beginEdit(uri: string, owner: string): number {
    const prev = this.docs.get(uri);
    const syncSeq = (prev?.syncSeq ?? 0) + 1;
    this.docs.set(uri, { owner, syncing: true, syncSeq, sentVersion: prev?.sentVersion });
    this.clearForFile(uri);
    return syncSeq;
  }

  /**
   * 编辑结束：didChange（或 didOpen）已发出，或同步失败。必须在 finally 里调用，
   * 否则该文件永远停在 syncing 态、诊断永远被丢弃。
   *
   * @param sentVersion 本次发给服务器的文档版本；同步失败时不传
   */
  endEdit(uri: string, syncSeq: number, sentVersion?: number): void {
    const doc = this.docs.get(uri);
    if (!doc || doc.syncSeq !== syncSeq) return; // 已有更新的编辑在途，由它来结束
    doc.syncing = false;
    if (sentVersion !== undefined) doc.sentVersion = sentVersion;
  }

  /**
   * 子代理结束时把它名下的文件转给主循环。
   *
   * 不转的话这些文件的 pending 再也没有消费者；转给主循环是因为子代理写的代码
   * 已成为主循环工作的一部分，其后续诊断该由主循环看到。已投递过的诊断不会重复投递。
   */
  releaseOwner(owner: string, to: string = MAIN_DIAGNOSTIC_OWNER): void {
    if (owner === to) return;
    for (const doc of this.docs.values()) {
      if (doc.owner === owner) doc.owner = to;
    }
    const c = this.counters.get(owner);
    if (c) {
      const target = this.countersFor(to);
      target.publishes += c.publishes;
      target.publishesWithVersion += c.publishesWithVersion;
      target.staleSyncing += c.staleSyncing;
      target.staleVersion += c.staleVersion;
      this.counters.delete(owner);
    }
  }

  /** 登记服务器推送的诊断（由 LSP 通知处理器调用） */
  registerPending(_serverName: string, files: PublishedDiagnosticFile[]): void {
    for (const file of files) {
      const doc = this.docs.get(file.uri);
      const counters = this.countersFor(doc?.owner ?? MAIN_DIAGNOSTIC_OWNER);
      counters.publishes++;
      const version = typeof file.version === "number" ? file.version : undefined;
      if (version !== undefined) counters.publishesWithVersion++;

      // 过时推送：既不进 pending，也不覆盖 latest、不唤醒等待者——等待者等的是新内容的诊断
      if (doc?.syncing) {
        counters.staleSyncing++;
        continue;
      }
      if (version !== undefined && doc?.sentVersion !== undefined && version < doc.sentVersion) {
        counters.staleVersion++;
        continue;
      }

      // 空数组也覆盖（表示"错误已清空"），这样 peek 到的永远是当前真实状态
      this.latest.set(file.uri, file.diagnostics);
      if (!doc && !this.baselined.has(file.uri)) {
        // 未编辑文件的首次推送：记基线，不投递（见 baselined 注释）
        this.baselined.add(file.uri);
        const base = file.diagnostics.filter(isActionable);
        if (base.length > 0) this.markDelivered(file.uri, base);
      } else {
        // 按 uri 覆盖：同一轮内先报错后修好，只留修好后的状态
        this.pending.set(file.uri, { diagnostics: file.diagnostics, infoCounted: false });
      }

      // 唤醒等待者（在覆盖 latest **之后**，确保被唤醒者立刻 peek 就能拿到刚到的诊断）
      const set = this.waiters.get(file.uri);
      if (!set) continue;
      this.waiters.delete(file.uri);
      for (const resolve of set) {
        try {
          resolve();
        } catch {
          /* 等待者自身异常不影响诊断注册 */
        }
      }
    }
  }

  /** 该 uri 是否**曾经**收到过 publishDiagnostics（空数组也算，表示"服务器说这文件没问题"） */
  hasPublishedFor(uri: string): boolean {
    return this.latest.has(uri);
  }

  /**
   * 等待某个 uri 的诊断首次到达（已到达则立即返回）。
   *
   * ## 为什么需要它
   *
   * `codeAction` 要把当前诊断填进 LSP `context.diagnostics`——多数语言服务器在 context
   * 为空时返回空 quickfix 列表（它不知道要修什么）。但诊断是**服务器主动推**的
   * （`textDocument/publishDiagnostics`），而 `didOpen` 是 fire-and-forget 通知
   * （server-manager.ts 用 sendNotification，不等响应）。于是"打开文件后立刻查 codeAction"
   * 必然 peek 到空数组 → context 空 → 服务器回空列表 → 用户看到
   * 「无可用的代码修复建议」，而文件里明明有错。
   *
   * ## 语义边界（重要）
   *
   * 返回 `true` 只表示"服务器**已就该文件表过态**"，**不表示有诊断**——空数组是合法且
   * 常见的表态（文件确实没错）。调用方拿到 true 后仍要 peek 才知道有没有内容。
   *
   * 超时返回 `false` 时调用方应当**照常继续**（用空 context 发请求），而不是报错：
   * 有些服务器对干净文件根本不推 publishDiagnostics，等到超时是正常路径，不是故障。
   *
   * @param uri 目标文件的 file:// URI
   * @param timeoutMs 最长等待，默认 1500ms（够本地语言服务器分析单文件，又不至于让
   *   一次 codeAction 卡住太久；调用方另有更长的请求级超时兜底）
   */
  waitForDiagnostics(uri: string, timeoutMs = 1500): Promise<boolean> {
    if (this.latest.has(uri)) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // 从等待集合里摘除自己，避免超时后仍被 registerPending 唤醒（无害但留垃圾）
        const set = this.waiters.get(uri);
        if (set) {
          set.delete(onPublish);
          if (set.size === 0) this.waiters.delete(uri);
        }
        resolve(value);
      };
      const onPublish = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      // 定时器不应把进程钉在事件循环里（CLI 退出时不因它多等）
      (timer as any).unref?.();

      const set = this.waiters.get(uri) ?? new Set<() => void>();
      set.add(onPublish);
      this.waiters.set(uri, set);
    });
  }

  /**
   * 只读快照：返回指定文件当前的全量诊断，**不消费、不清空、不影响注入链**。
   *
   * 供 codeAction 这类 pull 式查询填充 LSP `context.diagnostics`。没有对应文件的诊断时返回空数组。
   * 返回浅拷贝，防止调用方意外改动内部快照。
   */
  peekDiagnosticsForFile(uri: string): Diagnostic[] {
    const diags = this.latest.get(uri);
    return diags ? [...diags] : [];
  }

  /**
   * 收集某个归属者名下待投递的诊断，调用后标记为已投递。
   *
   * 归属取代了旧的「可选 scopeUris」：旧实现里主循环不带作用域、把**所有人**的 pending
   * 捞走清空，子代理的作用域隔离只防住了子代理之间，没防住主循环。现在每个消费者只能
   * 拿到自己编辑过的文件。
   *
   * 顺序（每一步都有踩过的坑）：
   * 1. 先按严重度过滤，再限流。旧实现先限流后过滤，Hint 照样占 30 条名额，
   *    多文件时排在前面的纯 Hint 文件能把后面文件的 Error 整个挤掉，本轮注入为空。
   * 2. 限流按严重度跨文件排序（Error 先于所有 Warning），文件内再按到达顺序。
   * 3. 超限的部分留在 pending 待后续轮次补发，并计入 `carried` 告知模型。
   *    旧实现把整批 pending 清空，被截掉的部分要等该文件再被编辑才会重新出现。
   */
  collectDiagnostics(owner: string): CollectResult {
    const counters = this.counters.get(owner) ?? emptyCounters();
    this.counters.delete(owner);

    // 1. 作用域内文件 + 严重度过滤 + 文件内去重 + 跨轮次去重
    type Candidate = { uri: string; fileIdx: number; idx: number; diag: Diagnostic };
    const scope: Array<{ uri: string; undelivered: number }> = [];
    const candidates: Candidate[] = [];
    let actionable = 0;
    let alreadyDelivered = 0;
    let omittedInfo = 0;
    let anyDiagnostics = false;
    for (const [uri, entry] of this.pending) {
      if ((this.docs.get(uri)?.owner ?? MAIN_DIAGNOSTIC_OWNER) !== owner) continue;
      if (entry.diagnostics.length > 0) anyDiagnostics = true;
      if (!entry.infoCounted) {
        omittedInfo += entry.diagnostics.filter((d) => !isActionable(d)).length;
        entry.infoCounted = true;
      }
      const deliveredKeys = this.delivered.get(uri);
      const seen = new Set<string>();
      const fileIdx = scope.length;
      let undelivered = 0;
      entry.diagnostics.forEach((diag, idx) => {
        if (!isActionable(diag)) return;
        const key = this.diagnosticKey(diag);
        if (seen.has(key)) return;
        seen.add(key);
        actionable++;
        if (deliveredKeys?.has(key)) {
          alreadyDelivered++;
          return;
        }
        undelivered++;
        candidates.push({ uri, fileIdx, idx, diag });
      });
      scope.push({ uri, undelivered });
    }

    // 2. 跨文件按严重度排序后限流
    candidates.sort(
      (a, b) =>
        SEVERITY_ORDER[a.diag.severity] - SEVERITY_ORDER[b.diag.severity] ||
        a.fileIdx - b.fileIdx ||
        a.idx - b.idx,
    );
    const perFile = new Map<string, number>();
    const picked: Candidate[] = [];
    for (const c of candidates) {
      if (picked.length >= MAX_TOTAL_DIAGNOSTICS) break;
      const n = perFile.get(c.uri) ?? 0;
      if (n >= MAX_DIAGNOSTICS_PER_FILE) continue;
      perFile.set(c.uri, n + 1);
      picked.push(c);
    }

    // 3. 按文件分组输出（文件按到达顺序，文件内按严重度）
    const byUri = new Map<string, Diagnostic[]>();
    for (const { uri } of scope) byUri.set(uri, []);
    for (const c of picked) byUri.get(c.uri)!.push(c.diag);
    const files: DiagnosticFile[] = [];
    for (const [uri, diagnostics] of byUri) {
      if (diagnostics.length === 0) continue;
      files.push({ uri, diagnostics });
      this.markDelivered(uri, diagnostics);
    }

    // 4. 清 pending：全部投递完的删掉，还有剩余的留着下一轮补发
    let carried = 0;
    for (const { uri, undelivered } of scope) {
      const remaining = undelivered - (perFile.get(uri) ?? 0);
      if (remaining > 0) carried += remaining;
      else this.pending.delete(uri);
    }

    const outcome: CollectOutcome =
      picked.length > 0
        ? "injected"
        : scope.length === 0
          ? "empty"
          : !anyDiagnostics
            ? "clean"
            : actionable === 0
              ? "info_only"
              : "all_delivered";

    return {
      files,
      stats: {
        ...counters,
        outcome,
        files: scope.length,
        actionable,
        alreadyDelivered,
        injected: picked.length,
        carried,
        omittedInfo,
      },
    };
  }

  /** 清空所有状态（LSP 重置时） */
  clear(): void {
    this.pending.clear();
    this.delivered.clear();
    this.deliveredOrder = [];
    this.latest.clear();
    this.docs.clear();
    this.counters.clear();
    this.baselined.clear();
    // 唤醒所有在等的 waitForDiagnostics，否则它们只能挂到各自超时——registry 已被重置，
    // 再等下去等不到任何东西了。唤醒后调用方 peek 到空、照常继续（语义见 waitForDiagnostics）。
    const pendingWaiters = [...this.waiters.values()];
    this.waiters.clear();
    for (const set of pendingWaiters) {
      for (const resolve of set) {
        try {
          resolve();
        } catch {
          /* 等待者自身异常不影响清理 */
        }
      }
    }
  }

  /**
   * 清除指定文件的 pending / delivered / latest（beginEdit 内部调用）。
   *
   * - delivered：对标 Claude Code 的 clearDeliveredDiagnosticsForFile。编辑后旧诊断可能已失效，
   *   不清的话服务器重推的同位置诊断会被跨轮次去重永久过滤。
   * - pending：编辑前服务器基于旧内容推的诊断已无意义。
   * - latest：否则编辑后、服务器重推之前，codeAction 的 waitForDiagnostics 会因
   *   latest.has(uri) 立即返回，再把编辑前的旧诊断塞进 context.diagnostics。
   *
   * 不唤醒该 uri 的等待者：它们等的就是编辑后的新一轮 publishDiagnostics。
   */
  clearForFile(uri: string): void {
    this.delivered.delete(uri);
    const idx = this.deliveredOrder.indexOf(uri);
    if (idx >= 0) this.deliveredOrder.splice(idx, 1);
    this.latest.delete(uri);
    this.pending.delete(uri);
  }

  // ─── 内部方法 ───

  /** 记录已投递的诊断（LRU） */
  private markDelivered(uri: string, diagnostics: Diagnostic[]): void {
    let keys = this.delivered.get(uri);
    if (!keys) {
      keys = new Set();
      this.delivered.set(uri, keys);
      this.deliveredOrder.push(uri);
    }
    for (const diag of diagnostics) {
      keys.add(this.diagnosticKey(diag));
    }
    // LRU 淘汰
    while (this.deliveredOrder.length > MAX_DELIVERED_FILES) {
      const evicted = this.deliveredOrder.shift()!;
      this.delivered.delete(evicted);
    }
  }

  private diagnosticKey(diag: Diagnostic): string {
    return JSON.stringify({
      message: diag.message,
      severity: diag.severity,
      range: diag.range,
      source: diag.source ?? null,
      code: diag.code ?? null,
    });
  }
}
