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
  /**
   * 同步窗口：`beginEdit` 起到「服务器确认处理完本次变更」为止。
   *
   * 语义在 2026-11-05 被**延长**过：此前到 `endEdit`（didChange 发出）为止，
   * 但 `sendNotification` 返回只代表字节写进了 stdin，不代表服务器算完；实测
   * tsls 在这之后仍会推旧内容的诊断。现在由屏障回调 `passBarrier` 收尾。
   */
  syncing: boolean;
  /**
   * 编辑代际：每次 beginEdit +1，同时充当「同一文件并发编辑」的配对序号。
   * 屏障回调带着它回来，代际不匹配说明是旧代际的屏障到得晚，不能结束新代际的窗口。
   */
  syncSeq: number;
  /** 最近一次发给服务器的文档版本（didOpen=1，didChange 递增） */
  sentVersion?: number;
  /** 屏障已通过的代际（= 通过时的 syncSeq）。与 syncSeq 相等才说明**当前代际**已越过屏障 */
  barrierEpoch: number;
  /**
   * 本次代际的变更**根本没发出去**（读盘失败 / 服务器启动失败 / 无对应服务器）。
   *
   * 与「屏障失败」是两件事：屏障失败时 didChange 已发出，只是无法确认服务器处理完；
   * 而同步失败时服务器侧内容仍是旧的，它推来的 version 也可能停在上一代际——
   * 所以此时连 version 判据也不可信，只能判 unverified（否则会把旧内容诊断标成「新鲜」）。
   */
  syncFailed: boolean;
  /** 当前代际是否已收到过推送（用于区分 `fresh_first` 与后续推送） */
  freshPublishSeen: boolean;
  /**
   * 本代际是否有推送被同步窗口丢弃过。
   *
   * 用于 `fresh_after_stale` 口径：丢弃之后如果补到了新鲜推送，说明只是「晚一轮」；
   * 如果始终没有补到，该文件可能**直到下次编辑都没有诊断**（flush 窗口误伤首推，而多数
   * 服务器只在内容变化时重推）。没有这个字段，这两种情况在轨迹上不可区分。
   */
  staleDropped: boolean;
}

/** 一条推送的新鲜度判定（进轨迹；决定注入文本是否带「基于最近一次编辑」标注） */
export type FreshnessVerdict =
  /** 带 version，且不落后于已发出版本 */
  | "fresh_by_version"
  /** 无 version，但已越过屏障（+flush 窗口） */
  | "fresh_by_barrier"
  /** 编辑同步窗口内到达，被丢弃 */
  | "stale_syncing"
  /** 版本号落后，被丢弃 */
  | "stale_version"
  /** 无 version，且屏障失败/已关闭 —— 判断不了，照常注入（退化为修复前行为） */
  | "unverified"
  /** 从未被 edit/write 同步过的文件：没有编辑代际可言 */
  | "baseline";

interface PendingEntry {
  /** 该 uri 的最新全量快照 */
  diagnostics: Diagnostic[];
  /** 本快照里的 Hint/Info 是否已计入过「已省略」——快照因补发留在 pending 时不重复计数 */
  infoCounted: boolean;
  /** 本快照的新鲜度判定 */
  freshness: FreshnessVerdict;
  /** 本快照是否为新代际的第一次推送（用于 collect 侧的 `injected_first_publish`） */
  firstOfEpoch: boolean;
}

/** 两次 collect 之间的推送计数（按归属者记，未归属的文件记到主循环名下） */
interface PublishCounters {
  publishes: number;
  publishesWithVersion: number;
  /** 编辑同步窗口内到达、被丢弃的推送 */
  staleSyncing: number;
  /** 版本号落后于已发出版本、被丢弃的推送 */
  staleVersion: number;
  /** 带 version 且新鲜 */
  freshByVersion: number;
  /** 无 version、越过屏障后到达 */
  freshByBarrier: number;
  /** 无 version 且屏障失败/关闭（判断不了，照常注入） */
  unverified: number;
  /** 从未被 edit/write 同步过的文件的推送 */
  baseline: number;
  /**
   * 「本代际曾有推送被同步窗口丢弃、之后补到了新鲜推送」的代际数（按代际计，不是推送数）。
   * 与 `staleSyncing` 对照：差得越大，说明越多的丢弃没有被补上——那批文件可能直到
   * 下次编辑都没有诊断。这是 flush 窗口的代价从「晚一轮」变成「丢诊断」的唯一观测口。
   */
  freshAfterStale: number;
}

function emptyCounters(): PublishCounters {
  return {
    publishes: 0,
    publishesWithVersion: 0,
    staleSyncing: 0,
    staleVersion: 0,
    freshByVersion: 0,
    freshByBarrier: 0,
    unverified: 0,
    baseline: 0,
    freshAfterStale: 0,
  };
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
  /**
   * 判为「带外漂移」、本轮未注入并已触发重同步的文件数。
   * 由 manager 在 collect 前填——registry 保持纯内存、不读盘。
   */
  driftedFiles: number;
  /** 注入的文件里，拿的是新代际第一次推送的文件数（fresh_first 的度量，见设计方案 §3.2） */
  injectedFirstPublish: number;
}

export interface CollectResult {
  files: CollectedDiagnosticFile[];
  stats: CollectStats;
}

/** collect 输出的文件：比 DiagnosticFile 多一个新鲜度判定，供注入文本决定是否加标注 */
export interface CollectedDiagnosticFile extends DiagnosticFile {
  freshness: FreshnessVerdict;
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
   * 做三件事：登记归属者；清掉该文件的 pending / delivered / latest；开启新的编辑代际
   * （`syncing = true`）——本代际的屏障越过之前到达的推送都可能是旧内容的，一律丢弃。
   *
   * @returns 本次编辑的代际号，交给 endEdit / passBarrier 配对
   */
  beginEdit(uri: string, owner: string): number {
    const prev = this.docs.get(uri);
    const syncSeq = (prev?.syncSeq ?? 0) + 1;
    this.docs.set(uri, {
      owner,
      syncing: true,
      syncSeq,
      sentVersion: prev?.sentVersion,
      // 新代际的屏障尚未越过：barrierEpoch 停在旧值，与 syncSeq 不等即可
      barrierEpoch: prev?.barrierEpoch ?? 0,
      syncFailed: false,
      freshPublishSeen: false,
      staleDropped: false,
    });
    this.clearForFile(uri);
    return syncSeq;
  }

  /**
   * 编辑结束（didChange 已发出 / 同步失败）。必须在 finally 里调用。
   *
   * **不再结束 syncing**：`sendNotification` 返回只代表字节写进了 stdin，服务器此时可能
   * 还没算完，甚至还在推旧内容的诊断。窗口的收尾交给屏障回调 `passBarrier`。
   *
   * 唯一例外是**本次没发出去**（`sentVersion === undefined`：无对应服务器 / 发送失败）——
   * 那就不会有屏障到来，必须在此结束窗口；同时标记 `syncFailed`，因为服务器侧内容仍是
   * 旧的，它后续推来的 version 也可能停在上一代际，此时连 version 判据都不可信。
   *
   * @param sentVersion 本次发给服务器的文档版本；同步失败时不传
   */
  endEdit(uri: string, syncSeq: number, sentVersion?: number): void {
    const doc = this.docs.get(uri);
    if (!doc || doc.syncSeq !== syncSeq) return; // 已有更新的编辑在途，由它来结束
    if (sentVersion === undefined) {
      doc.syncing = false; // 没发出任何变更，等不来屏障了
      doc.syncFailed = true; // 服务器侧仍是旧内容 → 后续推送一律判 unverified
      return;
    }
    doc.sentVersion = sentVersion;
  }

  /**
   * 屏障越过（或失败）：结束本代际的编辑同步窗口。
   *
   * @param epoch 发起屏障时的代际号。与当前 `syncSeq` 不等说明这是**旧代际**的屏障
   *   到得晚（并发编辑常见），不能拿它结束新代际的窗口——否则新代际的旧内容推送会被
   *   当成新诊断收下，正是本次要修的缺陷。
   * @param ok 屏障是否成功（服务器已按序处理完本次变更且 flush 窗口已越过）。
   *   **失败时只是不设 `barrierEpoch`**：无 version 的推送自然判 unverified；带 version
   *   的推送仍可由 version 判据证明新鲜（version 是精确判据，不依赖屏障）。
   */
  passBarrier(uri: string, epoch: number, ok: boolean): void {
    const doc = this.docs.get(uri);
    if (!doc || doc.syncSeq !== epoch) return;
    doc.syncing = false;
    if (ok) doc.barrierEpoch = epoch;
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
      target.freshByVersion += c.freshByVersion;
      target.freshByBarrier += c.freshByBarrier;
      target.unverified += c.unverified;
      target.baseline += c.baseline;
      target.freshAfterStale += c.freshAfterStale;
      this.counters.delete(owner);
    }
  }

  /**
   * 判定一条推送的新鲜度。
   *
   * 顺序上 **version 优先于屏障**：带 version 的服务器（gopls / rust-analyzer / pyright）
   * 本来就有精确判据，屏障对它们只是冗余；无 version 的（tsls 5.x 等已验证服务器）
   * 才落到屏障判据。
   *
   * `syncFailed` 必须最先判：本次 didChange 没发出去时，服务器推来的 version 可能停在
   * 上一代际（看起来「不落后」），但内容其实是旧的——此时 version 判据也不可信。
   *
   * 调用前提：调用方已经过了 `syncing` 与「version 落后」两道丢弃闸门。
   */
  private classify(doc: DocState | undefined, version: number | undefined): FreshnessVerdict {
    if (!doc) return "baseline";
    if (doc.syncFailed) return "unverified";
    if (version !== undefined && doc.sentVersion !== undefined) {
      // 落后的情况已在 registerPending 里丢弃；走到这里说明版本不落后
      return "fresh_by_version";
    }
    // 无 version：屏障已越过当前代际才可证新鲜
    if (doc.barrierEpoch === doc.syncSeq) return "fresh_by_barrier";
    // 屏障失败/关闭/未启用：无从判断
    return "unverified";
  }

  /** 登记服务器推送的诊断（由 LSP 通知处理器调用） */
  registerPending(_serverName: string, files: PublishedDiagnosticFile[]): void {
    for (const file of files) {
      const doc = this.docs.get(file.uri);
      const counters = this.countersFor(doc?.owner ?? MAIN_DIAGNOSTIC_OWNER);
      counters.publishes++;
      const version = typeof file.version === "number" ? file.version : undefined;
      if (version !== undefined) counters.publishesWithVersion++;

      // version 已能证明新鲜时**不受同步窗口约束**：version 是精确判据（服务器回显我们发出的
      // 文档版本），屏障窗口只是无 version 服务器的兜底。若不放行，带 version 的服务器
      // （gopls / rust-analyzer / pyright）在 didChange 后立刻推出的新鲜诊断会被窗口整批
      // 丢掉——而它们通常不会重推，结果是该文件直到下次编辑都没有诊断。
      const versionFresh =
        version !== undefined && doc?.sentVersion !== undefined && version >= doc.sentVersion;

      // 过时推送：既不进 pending，也不覆盖 latest、不唤醒等待者——等待者等的是新内容的诊断
      if (doc?.syncing && !versionFresh) {
        counters.staleSyncing++;
        doc.staleDropped = true;
        continue;
      }
      if (version !== undefined && doc?.sentVersion !== undefined && version < doc.sentVersion) {
        counters.staleVersion++;
        continue;
      }

      // 被同步窗口丢过、现在补到了有效推送：说明这次丢弃只是「晚一轮」，不是丢诊断
      if (doc?.staleDropped) {
        counters.freshAfterStale++;
        doc.staleDropped = false;
      }

      const freshness = this.classify(doc, version);
      if (freshness === "fresh_by_version") counters.freshByVersion++;
      else if (freshness === "fresh_by_barrier") counters.freshByBarrier++;
      else if (freshness === "baseline") counters.baseline++;
      else counters.unverified++;

      // 本代际第一次有效推送？——用来区分「收集到的是不是新内容的第一次（可能不完整的）快照」
      const firstOfEpoch = doc !== undefined && !doc.freshPublishSeen;
      if (doc) doc.freshPublishSeen = true;

      // 空数组也覆盖（表示"错误已清空"），这样 peek 到的永远是当前真实状态
      this.latest.set(file.uri, file.diagnostics);
      if (!doc && !this.baselined.has(file.uri)) {
        // 未编辑文件的首次推送：记基线，不投递（见 baselined 注释）
        this.baselined.add(file.uri);
        const base = file.diagnostics.filter(isActionable);
        if (base.length > 0) this.markDelivered(file.uri, base);
      } else {
        // 按 uri 覆盖：同一轮内先报错后修好，只留修好后的状态
        this.pending.set(file.uri, {
          diagnostics: file.diagnostics,
          infoCounted: false,
          freshness,
          firstOfEpoch,
        });
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
   * 某归属者名下**待投递**的文件 uri 列表（只读快照，不消费）。
   *
   * 供 manager 在 collect 之前做带外修改漂移校验：只有可能被注入的文件才值得花
   * stat/读盘去校验（见 manager.findDriftedFiles 的注释）。
   */
  pendingUrisFor(owner: string): string[] {
    const uris: string[] = [];
    for (const uri of this.pending.keys()) {
      if ((this.docs.get(uri)?.owner ?? MAIN_DIAGNOSTIC_OWNER) === owner) uris.push(uri);
    }
    return uris;
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
   * 编辑后的同步窗口内也会走超时路径：窗口内的推送被判 stale 丢弃、不写 `latest`，
   * 所以「edit 之后立刻 codeAction」可能等满超时。这是有意取舍（窗口内无法证明诊断新鲜），
   * 不是故障；窗口结束后的重推会正常唤醒等待者。
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
  collectDiagnostics(owner: string, driftedFiles = 0): CollectResult {
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
    const files: CollectedDiagnosticFile[] = [];
    let injectedFirstPublish = 0;
    for (const [uri, diagnostics] of byUri) {
      if (diagnostics.length === 0) continue;
      const entry = this.pending.get(uri);
      files.push({ uri, diagnostics, freshness: entry?.freshness ?? "unverified" });
      if (entry?.firstOfEpoch) {
        injectedFirstPublish++;
        // 消费即清除：carried 的条目会在后续轮次再次进这里，同一个「第一次推送」不能被
        // 重复计入，否则指标随补发轮次虚高（分母口径问题，比数字不准更难发现）。
        entry.firstOfEpoch = false;
      }
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
        // 漂移校验在 manager 里做（registry 保持纯内存、不读盘），结果由调用方传入
        driftedFiles,
        injectedFirstPublish,
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
