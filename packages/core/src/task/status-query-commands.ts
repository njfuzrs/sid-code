/**
 * 外部状态查询命令表（P1）：哪些前台 bash 命令算「在查外部状态」，以及怎么判「结果没变」。
 *
 * ## 要解决的事故（20261108-112039-9e3a681d / 20261108-112620-7dd98bf5）
 *
 * 模型排了唤醒 / 挂了 monitor 之后，仍在等待期前台反复查同一个 PR 的 CI：
 * 两会话分别 97 / 86 次 `gh pr view|checks`，20 分钟窗口内约 100 次请求全额计费。
 * 每次查询拿到的状态绝大多数**和上一次一模一样**——真正的新信息只出现在个别时刻。
 *
 * ## 这个模块只回答两个问题
 *
 * 1. **这条命令是不是外部状态查询**（`matchStatusQuery`）：命中命令表 + 整条命令不含写操作。
 *    表外一律返回 null（宁可漏，不可误伤）。表是唯一事实源，新增条目要带一条真实轨迹证据
 *    （防止按想象扩表）。
 * 2. **两次输出是不是「同一个状态」**（`normalizeStatusOutput`）：把每次都变、但不携带语义的
 *    字段抹掉——耗时列（`pass 4m42s`）、`*At` 时间戳、`duration*` / `elapsed*`、`url`。
 *
 * ## 为什么归一化是这套判据的地基
 *
 * 「状态变化一定让签名不同」靠的正是它：`gh pr checks` 的耗时列每几秒就变一次，
 * 不抹掉的话签名永远不相等，「结果相同」永远不成立，拦截形同虚设；抹得太多
 * （比如把 `status` 也抹掉）则会把真实的变化吞掉，模型永远看不到「某个分片 pass 了」。
 * 所以归一化按命令种类分别实现，宁可保守（少抹）也不要多抹。
 *
 * 这与 `bg_task_list` 的 `taskListSignature`（background-poll-guard.ts「刻意不含耗时」那段注释）
 * 是同一把尺子：**签名只留语义字段，去掉一切随时间自然变化的噪声**。
 */

import {
  parseBashCommand,
  extractSimpleCommands,
  extractRedirectTargets,
} from "../tool/bash/parser.ts";
import { extractHeredocBlocks } from "../tool/bash/heredoc.ts";
import { GH_CHECKS_PENDING_HEADER } from "../tool/bash/command-semantics.ts";

/** 命中命令表时告诉调用方「这是哪一类查询」，归一化与状态摘要按它分派 */
export type StatusQueryKind = "gh_pr" | "gh_run" | "glab_mr" | "glab_ci" | "k8s" | "http";

/**
 * 命令**族**：比 `kind` 细一级，同族才意味着输出覆盖同一批字段（D13）。
 *
 * 为什么不能只到 `kind`：`gh pr checks 662` 与 `gh pr view 662 --json reviewDecision`
 * 都是 `gh_pr`，但前者只报告检查项，后者报告 reviewDecision / mergeable ——
 * 拿 `kind` 判「monitor 覆盖了这条查询」会让模型在 monitor 期间看不到它不报告的字段
 * （D13 的事故形态：review 通过了、冲突出现了，模型一直看不到）。
 *
 * 新增规则时**必须**同时给 family：漏给会让 `covered` 判不出覆盖（保守方向，只会多放行）。
 */
export type StatusQueryFamily =
  | "gh_pr_checks"
  | "gh_pr_view"
  | "gh_pr_status"
  | "gh_run_view"
  | "gh_run_watch"
  | "gh_run_list"
  | "gh_api_checks"
  | "gh_api_runs"
  | "gh_api_pulls"
  | "glab_mr_view"
  | "glab_ci_status"
  | "k8s_rollout_status"
  | "k8s_get"
  | "http_status";

export interface StatusQueryMatch {
  kind: StatusQueryKind;
  /** 命令族（D13 的覆盖判定用）：同族才认为 monitor 的报告覆盖了这条查询 */
  family: StatusQueryFamily;
  /**
   * 被查询对象的签名，如 `gh:pr:662`。
   *
   * 与 `wait-registry` 的 `subjects`（monitor / 唤醒登记的）**同一套命名**，
   * 于是回执能直接说「这条查询等价于 monitor m7k2 正在盯的东西」——
   * 两边各起一套名字的话，S2 撤销与回执引用都会悄悄失配。
   */
  subject: string;
  /**
   * memo 的键：subject + 决定输出形态的那一段命令（含参数）。
   *
   * 为什么不能只用 subject：`gh pr view 662 --json state` 与
   * `gh pr view 662 --json state,statusCheckRollup` 的输出结构完全不同，
   * 拿它们互相比较会把「查询字段变了」误判成「状态变了」。同一个 subject 下的不同查法
   * 各自独立计数，是刻意的。
   */
  signature: string;
}

/** 一条规则的匹配结果；命中时给出 subject 的尾部 */
interface RuleMatch {
  /** subject 的尾部（PR 号 / run id / 资源名 / host+path） */
  tail: string;
  /** 命令族（D13）：同一 subject 下不同族的查询输出覆盖不同字段 */
  family: StatusQueryFamily;
  /**
   * subject 前缀的覆盖值（默认由 `kind` 决定）。
   *
   * 只有 `gh api` 需要它：同一条 `gh` 命令按路径分成 `gh:commit:<ref>` 与 `gh:run:<id>`
   * 两种 subject，一个 `kind` 给不出两个前缀。命名与 `wait-registry` 的 subjects 保持同一套，
   * 否则回执里说的对象与 monitor 盯的对象对不上（S2 撤销会失配）。
   */
  prefix?: string;
}

type Rule = {
  /** 命令名（`gh` / `glab` / `kubectl` / `curl`），与 `extractSimpleCommands` 的 command 逐字相等才算命中 */
  command: string;
  kind: StatusQueryKind;
  /** 参数（不含命令名）→ 命中则返回 subject 尾部 */
  match: (args: string[]) => RuleMatch | null;
};

/** 取第一个非 flag 的位置参数（`gh pr checks 662` 的 `662`，跳过 `--json x` 这类） */
function firstPositional(args: string[], from: number): string | null {
  for (let i = from; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      // 带值 flag 的值不是位置参数。这里不做穷举（各命令不同），
      // 跳到 `--flag=value` 形态已经天然被 startsWith("-") 吃掉；
      // 分开写的值（`--json state`）会被当成位置参数，因此下面从**第一个**位置参数取值，
      // 且各规则的子命令位置是固定的，不会被 flag 值顶掉。
      continue;
    }
    return a;
  }
  return null;
}

/**
 * `gh api` 的**只读 GET** 路径；带写标志时返回 null。
 *
 * 判据按「写标标志存在即拒绝」的**白名单方向**：`-f` / `-F` / `--field` / `--raw-field` /
 * `--input` 会让 gh 把请求变成 POST/PATCH/PUT（GH CLI 的隐式方法推导），所以一律不算状态查询。
 * `-X POST` / `--method=DELETE` 同理。`-q` / `--jq` / `-H` 只影响输出与请求头，放行。
 *
 * 路径取**第一个非 flag 位置参数**。`gh api repos/… -q '.x'` 这种「路径在前、查询串在后」
 * 的真实写法能正确取到；反过来把 `-q` 写在路径前会取到查询串 → 路径匹配不上 → 放行（宁漏不误）。
 */
function ghApiGetPath(args: string[]): string | null {
  if (args[0] !== "api") return null;

  const WRITE_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input", "--method", "-X"]);
  /**
   * 带**取值**的只读 flag：它们的值不是位置参数。
   *
   * 刻意不用 `firstPositional`：那个函数对「分开写的 flag 值」是跳过不了的
   * （`-X GET repos/…` 会把 `GET` 当位置参数），对 gh pr/run 那些子命令无妨——它们的
   * 子命令位置固定；但 `gh api` 的路径就是第一个位置参数，必须精确。
   */
  const VALUE_FLAGS = new Set(["-q", "--jq", "-H", "--header", "-t", "--template", "--cache"]);

  let path: string | null = null;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-X" || a === "--method") {
      const v = args[i + 1];
      if (v === undefined || v.toUpperCase() !== "GET") return null;
      i++;
      continue;
    }
    if (a.startsWith("--method=")) {
      if (a.slice("--method=".length).toUpperCase() !== "GET") return null;
      continue;
    }
    if (a.startsWith("-X") && a.length > 2) {
      if (a.slice(2).toUpperCase() !== "GET") return null;
      continue;
    }
    if (a.startsWith("--field=") || a.startsWith("--raw-field=") || a.startsWith("--input=")) {
      return null;
    }
    if (WRITE_FLAGS.has(a)) return null;
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) i++; // 跳过它的值
      continue;
    }
    if (path === null) path = a;
  }

  if (!path) return null;
  // `?per_page=100` 这类查询串不影响端点语义，但会让路径正则失配
  const stripped = path.split("?")[0] ?? "";
  return stripped === "" ? null : stripped;
}

/**
 * 命令表（§5.5.2）。判据是「只读 + 查外部状态」。
 *
 * ⚠️ 表外一律不拦。这条方向性要求来自 2026-07-14 的否决记录：全局打开重复观测拦截
 * 在 42 个真实会话上误判率 ≈100%。这里之所以能开，唯一的区别是**模型自己声明了在等**
 * （`hasPromisedWait()` 为真），不是靠猜。
 */
const RULES: Rule[] = [
  // gh pr checks/view/status：CI 状态的主战场（两条事故会话共 183 次调用）
  {
    command: "gh",
    kind: "gh_pr",
    match: (args) => {
      if (args[0] !== "pr") return null;
      const sub = args[1];
      if (!sub || !["checks", "view", "status"].includes(sub)) return null;
      // 命令族按子命令区分（D13）：`gh pr checks` 只报告检查项，`gh pr view --json X`
      // 报告的是 X —— 拿「都是 gh_pr」判覆盖会让模型看不到 monitor 不报告的字段。
      const family: StatusQueryFamily =
        sub === "checks" ? "gh_pr_checks" : sub === "view" ? "gh_pr_view" : "gh_pr_status";
      // `gh pr status` 没有编号，按「当前分支的 PR」计一个固定签名
      const n = firstPositional(args, 2);
      return { tail: n && /^\d+$/.test(n) ? n : "current", family };
    },
  },
  {
    command: "gh",
    kind: "gh_run",
    match: (args) => {
      if (args[0] !== "run") return null;
      const sub = args[1];
      if (sub === "view" || sub === "watch") {
        const n = firstPositional(args, 2);
        return {
          tail: n && /^\d+$/.test(n) ? n : "current",
          family: sub === "view" ? "gh_run_view" : "gh_run_watch",
        };
      }
      if (sub === "list") {
        const n = firstPositional(args, 2);
        return { tail: n ? `list:${n}` : "list", family: "gh_run_list" };
      }
      return null;
    },
  },
  {
    command: "gh",
    kind: "gh_pr",
    // `gh api …/commits/<ref>/check-runs`：CI 状态的另一条主路径。
    //
    // 为什么必须单开一条规则：962011a6 一个会话里 32 次 `gh api …/check-runs`，
    // 全量 954 会话 175 次 / 29 会话，**一次都识别不了**（原命令表只有 `gh pr|run` 子命令）。
    // 模型从 `gh pr checks` 切到 `gh api` 的动机很直接：后者能拿到逐 job 的 status/conclusion。
    match: (args) => {
      const path = ghApiGetPath(args);
      if (!path) return null;
      const m =
        /^repos\/[^/]+\/[^/]+\/commits\/(.+)\/(check-runs|check-suites|status|statuses)$/.exec(
          path,
        );
      if (!m) return null;
      return { tail: m[1]!, family: "gh_api_checks", prefix: "gh:commit:" };
    },
  },
  {
    command: "gh",
    kind: "gh_pr",
    // `gh api …/pulls/<n>`（可带 `/reviews` `/commits` `/files` 子端点）：PR 状态的 REST 写法。
    //
    // 为什么要补：R4 的两次会话把 `gh pr view` 换成了 `gh api repos/…/pulls/780 -q .state`
    // （§1.3 的 F3 形态）——同一个 PR、同一批字段，只因为换了取数入口就整条识别不了。
    // 这不是「按想象扩表」：`gh api` 分支本身就存在（checks / runs 两条），此处只是把
    // 同样只读的 pulls 端点补齐。写标志仍由 `ghApiGetPath` 统一拒绝。
    match: (args) => {
      const path = ghApiGetPath(args);
      if (!path) return null;
      const m = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)(?:\/(?:reviews|commits|files))?$/.exec(path);
      if (!m) return null;
      return { tail: m[1]!, family: "gh_api_pulls", prefix: "gh:pr:" };
    },
  },
  {
    command: "gh",
    kind: "gh_run",
    // `gh api …/actions/runs[/<id>][/jobs]`：与 `gh run view` 同一批对象，但输出是 REST JSON。
    match: (args) => {
      const path = ghApiGetPath(args);
      if (!path) return null;
      const m = /^repos\/[^/]+\/[^/]+\/actions\/runs(?:\/(\d+))?(?:\/jobs)?$/.exec(path);
      if (!m) return null;
      return { tail: m[1] ?? "list", family: "gh_api_runs", prefix: "gh:run:" };
    },
  },
  {
    command: "glab",
    kind: "glab_mr",
    match: (args) => {
      if (args[0] !== "mr" || args[1] !== "view") return null;
      const n = firstPositional(args, 2);
      return { tail: n && /^\d+$/.test(n) ? n : "current", family: "glab_mr_view" };
    },
  },
  {
    command: "glab",
    kind: "glab_ci",
    match: (args) =>
      args[0] === "ci" && args[1] === "status"
        ? { tail: "status", family: "glab_ci_status" }
        : null,
  },
  {
    command: "kubectl",
    kind: "k8s",
    match: (args) => {
      // `-o yaml|json|jsonpath` 是**取配置全文**，不是看状态。
      // `kubectl get pods -o yaml` 的输出里每个 pod 的 creationTimestamp、
      // resourceVersion 都在变，把它当状态查询拦下会挡住模型拿真实清单的正当需求；
      // 反过来归一化也抹不干净（resourceVersion 是裸串），签名永远不相等、拦了也没用。
      // 方向仍是「表外不拦」：判不出来就当它不是状态查询。
      const hasOutputFlag = args.some(
        (a) => a === "-o" || a === "--output" || a.startsWith("-o=") || a.startsWith("--output="),
      );
      if (hasOutputFlag) return null;

      // kubectl rollout status <resource> / kubectl get pods [name]
      if (args[0] === "rollout" && args[1] === "status") {
        const r = firstPositional(args, 2);
        return { tail: `rollout:${r ?? "all"}`, family: "k8s_rollout_status" };
      }
      if (args[0] === "get") {
        const r = firstPositional(args, 1);
        if (!r) return null;
        // 只认 pods 一类状态查询；`kubectl get svc` 这类拿配置的不算
        if (!/^(pods?|po|deploy|deployment|deployments|sts|statefulset|statefulsets)$/.test(r))
          return null;
        return { tail: `get:${r}`, family: "k8s_get" };
      }
      return null;
    },
  },
  {
    command: "curl",
    kind: "http",
    // `curl -s http://host/health` / `curl -sS .../status`：只认明确的状态端点
    match: (args) => {
      for (const a of args) {
        if (a.startsWith("-")) continue;
        const m = /^(https?:\/\/[^\s'"]+?)(?:\/(health|healthz|readyz|livez|status))\/?$/.exec(a);
        if (m) return { tail: `${m[1]}/${m[2]}`, family: "http_status" };
      }
      return null;
    },
  },
];

/**
 * 归一化命令行：折叠**引号外**的连续空白，引号内的正文原样保留。
 *
 * 为什么不再「见到换行就放弃」（R4）：两条真实会话的主力写法是
 * ``gh pr view 780 --json … | python3 -c "``⏎``import json,sys``⏎``…"`` —— 换行在双引号内、
 * 是脚本正文的一部分，不是命令分隔符。原实现一律返回 null，把 44 次查询全部放行。
 *
 * 引号**外**的换行照旧保留：`parseBashCommand` 用 `splitOutsideQuotes` 按 `;` / 换行切段，
 * 于是 `for …⏎do …⏎done` 这类多行循环也能被正确切开（比原实现多认一类，是改进）。
 * 不能把换行压成空格 —— 那会让 `a⏎rm -rf x` 变成一条命令的两个参数，丢掉分隔语义。
 */
function flattenCommand(command: string): string | null {
  let out = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let pendingSpace = false;
  for (const ch of command) {
    if (quote) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\" && quote === '"') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (pendingSpace) {
        out += " ";
        pendingSpace = false;
      }
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "\n") {
      pendingSpace = false;
      out += ch;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += ch;
  }
  const trimmed = out.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 无害命令：不改变外部世界，也不会产出需要拦截的输出。
 *
 * 判据是**白名单式**的——一条命令里除了「命中查询表的」和「这里的」之外还出现别的，
 * 就整体判为「可能含写操作」而放行。方向是宁可漏、不可误伤。
 *
 * `sleep` 在列：真实轨迹里有 `sleep 30; gh pr view 662 ...` 这种写法，它没有副作用。
 * `echo` / `printf` 在列：两条会话里高频出现 `echo "=== checks ==="` 这类分隔符。
 * `date` 在列：轮询时给结果打时间戳（`sleep 30; date '+%H:%M:%S'; gh pr view …`），
 * 只读且无副作用；不在表里会让整条命令因为「有一段不认识」而被放行。
 * ⚠️ `date` 带 `-s` / `--set` 时**会改系统时钟**，由 `isHarmlessSegment` 单独排除（R4）。
 */
const HARMLESS_COMMANDS = new Set([
  "cd",
  "pushd",
  "popd",
  "echo",
  "printf",
  "true",
  "false",
  ":",
  "sleep",
  "date",
  "set",
  "export",
  "wait",
]);

/**
 * 一段命令是否无害（不改变外部世界、也不产出需要拦的输出）。
 *
 * 为什么 `date` 要单独判：它从 `HARMLESS_COMMANDS` 里拿不出来（高频、必须放行），
 * 但 `date -s 2020-01-01` / `date --set=…` 是**改系统时钟**的写操作。
 * R4 要求「末尾是无害段时跳过」之后，`gh pr view 1; date -s …` 这种组合会走进
 * 「前一段是查询、后一段无害」的路径 —— 若不排除 `-s`，一条改时钟的命令会被拦下来。
 */
function isHarmlessSegment(seg: SimpleSegment): boolean {
  if (!seg.command) return false;
  if (seg.command === "date") {
    // `-s` / `-s2020-01-01` / `--set` / `--set=…` 都是写
    return !seg.args.some((a) => a === "-s" || a.startsWith("--set") || /^-s./.test(a));
  }
  return HARMLESS_COMMANDS.has(seg.command);
}

/** fd 复制记号（`2>&1`、`>&2`）：parser 把它留在 args 里，不是位置参数 */
const FD_DUPLICATION = /^\d*>&\d+$/;

/** 这类 flag 说明用户在问「这个命令怎么用」，不是在查状态 */
function hasHelpOrVersionFlag(args: string[]): boolean {
  return args.some((a) => a === "--help" || a === "-h" || a === "--version" || a === "--");
}

/** `extractSimpleCommands` 的元素（一段简单命令） */
type SimpleSegment = { command: string; args: string[] };

/**
 * 脚本解释器 → 取「脚本正文」的 flag（`python3 -c "…"` / `node -e "…"` / `ruby -e "…"`）。
 *
 * 为什么要把它们算进纯过滤器（R4）：两条事故会话的主力写法是
 * `gh pr view 780 --json … | python3 -c "…"` —— 44 次查询里有 44 次带它。
 * 不认这一段，整条命令就会因为「末尾有一段不认识」而被判成非查询，P1 一次都不触发。
 */
const SCRIPT_INTERPRETERS: Record<string, string[]> = {
  python: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  ruby: ["-e"],
};

/**
 * 脚本正文里出现这些信号，就判「不是纯过滤」——它可能写文件 / 起子进程 / 访问网络。
 *
 * 方向仍然是 `isReadonlyFilter` 的「宁可漏，不可误伤」：命中就返回 false（放行整条命令），
 * 不猜它是只读的。反过来也成立 —— 这里**只**做关键词级筛查，不做语义分析：
 * 一段把 `open('f','w')` 拼出来的脚本能绕过，而绕过的后果只是「少拦一次」，可接受。
 */
const SCRIPT_WRITE_SIGNALS: RegExp[] = [
  /** `open('f','w')` / `open(f, "a")` / `open(p, 'r+')`：带写模式的文件打开 */
  /\bopen\s*\([^)]*['"][wax]/,
  /\bsubprocess\b/,
  /\bos\.(?:system|popen|remove|unlink|rename|rmdir|mkdir|makedirs|chmod|chown|symlink|exec[lv])/,
  /\bshutil\b/,
  /\brequests\b/,
  /\burllib\b/,
  /\bsocket\b/,
  /\bhttp\.client\b/,
  /\bfs\.(?:write|append|unlink|rename|mkdir|rm|rmdir|createWriteStream|openSync)/,
  /**
   * node 的 `fs` 裸函数名：`require('fs').writeFileSync(…)` 被 parser 剥掉引号后是
   * `require(fs).writeFileSync(…)` —— `fs` 后面跟着 `)`，上面那条 `fs\.` 匹配不到。
   * 只列**写**语义的名字：`readFileSync` 这类读操作不在其中。
   */
  /\b(?:writeFile|appendFile|createWriteStream|rmdir|mkdir|unlink)(?:Sync)?\s*\(/,
  /** ruby 的 `File.write` / `File.delete` / `File.open(f, 'w')` */
  /\bFile\.(?:write|delete|rename|truncate)\b/,
  /\bchild_process\b/,
  /\bexec(?:Sync|File|Command)?\s*\(/,
  /\beval\s*\(/,
];

/**
 * 脚本解释器的正文。取不到时返回 null —— 意味着脚本来自 stdin / 文件
 * （`python3 script.py` / `python3 <<'EOF'`），那种形态在这里判不出会不会写。
 */
function scriptInterpreterBody(seg: SimpleSegment): string | null {
  const flags = SCRIPT_INTERPRETERS[seg.command];
  if (!flags) return null;
  const { args } = seg;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (flags.includes(a)) {
      const rest = args.slice(i + 1).join(" ");
      return rest === "" ? null : rest;
    }
    // `-c"…"` 连写形态（parser 把它留成一个 token）
    for (const f of flags) {
      if (a.startsWith(f) && a.length > f.length) return a.slice(f.length);
    }
  }
  return null;
}

/**
 * 纯过滤命令：只对 stdin 做**一次性**过滤/格式化，不读文件树、不写文件。
 *
 * 为什么允许它们出现在查询之后：`gh pr checks 701 2>&1 | head -20` 是模型最常用的写法
 * （全量 954 会话里这类管道 530 次），原实现只看最后一段，把整条命令判成 `head` 而放行。
 *
 * 判据仍是「宁可漏，不可误伤」，所以每一项都排掉了自己会写/会持续等的形态：
 * - `tail -f` / `-F` / `--follow`：持续跟随，不是「查一次」，拦它没有意义；
 * - `sort -o <file>`：会写文件；
 * - `awk` 的程序体可以 `print > "f"`，参数里出现 `>` 或 gawk 的 `-i`（include）一律不算纯过滤。
 *   这会误伤 `awk '$1>2'`（比较运算符）—— 少拦一次，安全方向。
 * - 脚本解释器（`python3 -c` / `node -e` / `ruby -e`）：**按正文语义判**（R4）。
 *   正文里出现写文件 / 起子进程 / 访问网络的信号就不算纯过滤；正文取不到（从 stdin 或
 *   文件读脚本）也不算。`heredocBody` 是命令里唯一的 heredoc 正文（`python3 <<'EOF' … EOF`
 *   被 parser 剥离后 args 里只剩 `<`，正文只能从外面传进来）。
 */
function isReadonlyFilter(seg: SimpleSegment, heredocBody?: string): boolean {
  if (!seg.command) return false;
  const { command, args } = seg;
  if (SCRIPT_INTERPRETERS[command]) {
    const body = scriptInterpreterBody(seg) ?? heredocBody;
    if (body === undefined || body === null) return false;
    return !SCRIPT_WRITE_SIGNALS.some((re) => re.test(body));
  }
  switch (command) {
    case "head":
      return true;
    case "tail":
      return !args.some((a) => a === "-f" || a === "-F" || a === "--follow" || a === "--retry");
    case "jq":
    case "grep":
    case "wc":
    case "cut":
      return true;
    case "sort":
      return !args.some(
        (a) => a === "-o" || a === "--output" || a.startsWith("-o=") || a.startsWith("--output="),
      );
    case "awk":
      return !args.some((a) => a === "-i" || a.startsWith("--include") || a.includes(">"));
    default:
      return false;
  }
}

/**
 * 一段命令是否是状态查询。
 *
 * 剥 fd 复制记号：触发会话里 44 条退出码 8 的命令**全部**带 `2>&1`。parser 把记号原样留在
 * args 里，不剥掉的话 `gh pr checks 2>&1`（无 PR 号形态）会把 "2>&1" 当位置参数。
 */
function hitSegment(seg: SimpleSegment): QueryHit | null {
  if (!seg.command) return null;
  const args = seg.args.filter((a) => !FD_DUPLICATION.test(a));
  if (hasHelpOrVersionFlag(args)) return null;
  return matchQuery(seg.command, args);
}

/**
 * `x=$(<命令>)` 的展开：把赋值段还原成它内部的命令，并记下「变量 → 内部命令」。
 *
 * 为什么要展开（R4 §1.3 的 F4 形态）：
 * `head=$(gh api …/pulls/779 -q '.head.sha'); gh api …/commits/$head/check-runs`
 * 在 parser 里被解析成两段，第一段的 command 是 `api`（`head=$(gh` 被当成 env 前缀吃掉），
 * 于是「其余每段都必须无害 / 是查询」这条判据立刻失败，整条命令放行。
 * 展开成 `gh api …/pulls/779 -q '.head.sha'` 之后两段都是合法查询，判据自然通过。
 *
 * 只认**段首**的 `NAME=$(…)`：`echo $(gh pr view 1)` 这类把替换嵌在参数里的形态，
 * 展开会打乱 token 边界，宁可不认（表外不拦）。
 */
function expandAssignments(flat: string): { text: string; assigned: Map<string, string> } {
  const assigned = new Map<string, string>();
  const text = flat.replace(
    /(^|[;&|])\s*([A-Za-z_][A-Za-z0-9_]*)=\$\(([^()]*)\)/g,
    (_m, lead: string, name: string, inner: string) => {
      assigned.set(name, inner.trim());
      return `${lead} ${inner.trim()}`;
    },
  );
  return { text, assigned };
}

/**
 * 派生对象归并：`gh:commit:<变量>` 且变量来自 `gh api …/pulls/<n> … '.head.sha'` → `gh:pr:<n>`。
 *
 * 为什么（R4 §1.3 的 F4 形态）：同一条命令先取 PR 的 head sha、再查这个 commit 的 check-runs，
 * 问的其实是「那个 PR 的 CI」。归并成 `gh:pr:779` 才能与 `gh pr view 779` / `gh pr checks 779`
 * 共用同一个 subject —— 否则回执里说的对象和 monitor 盯的对象对不上（S2 撤销会失配）。
 *
 * 刻意收得窄：来源必须**正好是 PR 路径 + `.head.` 字段**。`x=$(gh api …/pulls/779/reviews)`
 * 出来的是评审列表，拿它当 sha 归并会把两个不同对象混成一个 subject（误拦方向）。
 */
function mergeDerivedSubject(hit: QueryHit, assigned: Map<string, string>): string {
  const prefix = hit.prefix ?? subjectPrefix(hit.kind);
  if (prefix !== "gh:commit:") return `${prefix}${hit.tail}`;
  const varName = /^\$(?:\{)?([A-Za-z_][A-Za-z0-9_]*)(?:\})?$/.exec(hit.tail)?.[1];
  const origin = varName ? assigned.get(varName) : undefined;
  if (!origin || !/\.head\.(?:sha|ref)\b/.test(origin)) return `${prefix}${hit.tail}`;
  const pr = /repos\/[^/\s]+\/[^/\s]+\/pulls\/(\d+)(?=\s|$)/.exec(origin);
  return pr ? `gh:pr:${pr[1]!}` : `${prefix}${hit.tail}`;
}

/** 循环头命令（shell 的三种循环） */
const LOOP_HEADS = new Set(["for", "while", "until"]);

/** 从一段简单命令列表里识别出的循环结构 */
interface LoopStructure {
  /** 循环头（`for pr in …` / `while …` / `until …`） */
  head: SimpleSegment;
  /** 循环体（已剥离 `do` 前缀）；一条循环体段都没有时为 null */
  body: SimpleSegment[] | null;
  /** 循环外其余段（`cd …` / `sleep …`） */
  outside: SimpleSegment[];
}

/**
 * 识别「单条、非嵌套」的循环，并把它从段列表里拆出来。
 *
 * 为什么在这里拆、而不去改 `parser.ts` 加 `for_statement` 节点：parser 是权限判定的上游
 * （`isReadOnlyCommand` / `extractPathsFromCommand` / checkpoint 共用），新增节点类型要同步
 * 每一处 switch，风险与收益不成比例；而这里只回答「是不是状态查询」，扁平段列表已经够用
 * （实测 parser 把 `for pr in 694 696 697; do gh …; done` 拆成
 * `for …` / `do gh …` / `done` 三段，`do` 粘在循环体首段前面）。
 *
 * 返回 null 的情形都走「宁漏不误」：没有循环头、循环不完整、多个/嵌套循环。
 */
function findLoop(simple: SimpleSegment[]): LoopStructure | null {
  const heads: number[] = [];
  for (let i = 0; i < simple.length; i++) {
    if (LOOP_HEADS.has(simple[i]!.command)) heads.push(i);
  }
  if (heads.length === 0) return null;
  // 多条或嵌套循环：段列表看不出层级，判不出循环体的边界 → 放弃
  if (heads.length > 1) return null;

  const start = heads[0]!;
  let end = -1;
  for (let i = start + 1; i < simple.length; i++) {
    if (simple[i]!.command === "done") {
      end = i;
      break;
    }
  }
  if (end < 0) return null;

  const body: SimpleSegment[] = [];
  for (let i = start + 1; i < end; i++) {
    const seg = simple[i]!;
    if (seg.command === "do") {
      // `do` 只允许出现在循环体开头；出现在中间说明结构不是我们理解的那样
      if (i !== start + 1) return { head: simple[start]!, body: null, outside: [] };
      if (seg.args.length === 0) continue;
      body.push({ command: seg.args[0]!, args: seg.args.slice(1) });
      continue;
    }
    if (!seg.command) continue;
    body.push(seg);
  }

  const outside = [...simple.slice(0, start), ...simple.slice(end + 1)];
  return { head: simple[start]!, body, outside };
}

/** `for <var> in <values…>` 的变量名与列表；不是这个形态（含非字面量列表）时返回 null */
function forLiteralValues(head: SimpleSegment): { name: string; values: string[] } | null {
  if (head.command !== "for") return null;
  const [name, keyword, ...values] = head.args;
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  if (keyword !== "in" || values.length === 0) return null;
  if (!values.every((v) => /^\d+$/.test(v))) return null; // 非全数字 → 交回调用方退化
  return { name, values };
}

/** 把 `$var` / `${var}` 替换成具体值（`$prx` 不能被 `$pr` 命中） */
function substituteLoopVariable(args: string[], name: string, value: string): string[] {
  const re = new RegExp(`\\$(?:${name}\\b|\\{${name}\\})`, "g");
  return args.map((a) => a.replace(re, value));
}

/** 循环命中的查询：subject 尾部与签名主体 */
interface LoopSubject {
  tail: string;
  /** 签名里的命令部分（同一查询的稳定形态，与列表顺序无关） */
  bodies: string[];
}

/**
 * 循环的 subject 尾部与签名主体。
 *
 * - `for pr in 694 696 697` 这类**全数字字面量**列表：把循环变量替换成每个值分别匹配，
 *   subject 用排序去重后的 `694,696,697`；列表顺序不同 → 同一 subject、同一签名。
 * - 其余（`for pr in $(gh pr list …)`、while/until）：尾部落成 `multi`。
 *   **刻意不是 `current`**：`gh pr view $pr` 在列表未知时的 `tail` 会是 "current"，
 *   那会和「查当前分支的 PR」撞同一个 subject，回执就会说错对象。
 */
function loopSubject(
  loop: LoopStructure,
  hits: Array<{ seg: SimpleSegment; hit: QueryHit }>,
): LoopSubject {
  const literal = forLiteralValues(loop.head);
  if (literal && loop.body) {
    const values = [...new Set(literal.values)].sort();
    let ok = true;
    const tails: string[] = [];
    const bodies: string[] = [];
    for (const value of values) {
      for (const { seg } of hits) {
        const substituted = substituteLoopVariable(seg.args, literal.name, value);
        const hit = matchQuery(seg.command, substituted);
        if (!hit || !/^\d+$/.test(hit.tail)) {
          ok = false;
          break;
        }
        tails.push(hit.tail);
        bodies.push(`${seg.command} ${substituted.join(" ")}`.trim());
      }
      if (!ok) break;
    }
    if (ok) {
      const unique = [...new Set(tails)].sort();
      return { tail: unique.join(","), bodies };
    }
  }

  // 非字面量列表 / while / until：保留循环体原文做签名（变量名不变才同签名）
  const tails = hits.map((h) => h.hit.tail);
  const allNumeric = tails.length > 0 && tails.every((t) => /^\d+$/.test(t));
  const tail = allNumeric ? [...new Set(tails)].sort().join(",") : "multi";
  const bodies = hits.map(({ seg }) => `${seg.command} ${seg.args.join(" ")}`.trim());
  return { tail, bodies };
}

/**
 * 循环体展开后的匹配。
 *
 * 安全边界与单条命令完全一致：循环体里出现**任何**不认识/可能写操作的段 → null。
 * 循环头与 `done` 视为无害 —— `until gh pr checks 1; do sleep 30; done` 的循环头是一条
 * 查询，但它表达的是「等这条命令成功」而不是轮询，拦它没有意义（也不该拦）。
 */
function matchLoopQuery(loop: LoopStructure, heredocBody?: string): StatusQueryMatch | null {
  // 循环外：`cd …` / `sleep …` 这类，必须无害
  for (const seg of loop.outside) {
    if (!seg.command) return null;
    if (isHarmlessSegment(seg)) continue;
    return null;
  }
  if (!loop.body || loop.body.length === 0) return null;

  const hits: Array<{ seg: SimpleSegment; hit: QueryHit }> = [];
  for (const seg of loop.body) {
    if (!seg.command) return null;
    const hit = hitSegment(seg);
    if (hit) {
      hits.push({ seg, hit });
      continue;
    }
    if (isHarmlessSegment(seg)) continue;
    // 循环体里的只读过滤管道：`for n in 579 578 577; do … gh pr checks $n | head -40; … done`
    // 是真实轨迹里的形态（7dd98bf5 系会话）。过滤段刻意**不进签名**：它只截断输出，
    // 不改变「查的是哪个对象」；同一循环的两种 head 行数会共享 memo，最坏是少拦一次。
    if (isReadonlyFilter(seg, heredocBody)) continue;
    return null; // 循环体里有不认识/写操作的命令（`gh pr merge $pr`、`bun test`）→ 放行
  }
  if (hits.length === 0) return null;

  // 循环体里多条查询必须在同一 kind + family：不同族的输出形态不同，合并成一个签名会互相污染
  const first = hits[0]!.hit;
  for (const { hit } of hits) {
    if (hit.kind !== first.kind || hit.family !== first.family) return null;
  }

  const { tail, bodies } = loopSubject(loop, hits);
  const subject = `${first.prefix ?? subjectPrefix(first.kind)}${tail}`;
  return {
    kind: first.kind,
    family: first.family,
    subject,
    signature: `${subject}\x1f${bodies.join("; ")}`.trim(),
  };
}

/**
 * 这条 bash 命令是不是「查外部状态」。
 *
 * 三条同时成立才命中：
 * 1. **查询段**命中命令表。查询段默认是最后一段（`a && gh pr checks 1`）；
 *    最后一段是纯过滤命令（`head` / `jq` / `grep` …）时向前找最后一个命中的段
 *    （`gh pr checks 1 | head` 的查询段是 `gh pr checks 1`）。
 * 2. **整条命令不含写操作**：其余每段都必须是「命中查询表」、纯过滤命令（只允许在查询段之后）
 *    或 `HARMLESS_COMMANDS`；有任何一个不认识的就放行（`gh pr checks 1 && gh pr merge 1`、
 *    `git push` 这类都会被这一条挡掉）。
 * 3. 没有写重定向（`> file`）、命令是单行；复合命令里的循环按循环体展开（见 `findLoop`）。
 *
 * ⚠️ **为什么不直接复用 `isReadOnlyCommand`**：那个函数是给**权限放行**用的，白名单刻意窄
 * （`gh` 只认 `issue`/`pr`/`repo` 三组，`curl` 恒判非只读）。拿它做本判据会把
 * `gh run list`、`curl .../health` 这些**本来想拦**的查询全部排除在外。
 * 两处目的不同：那边问「能不能不问用户直接执行」，这边问「这条命令会不会改变外部世界」。
 * 后者用白名单 + 「其余一律放行」，安全边界反而更清楚。
 */
export function matchStatusQuery(command: string): StatusQueryMatch | null {
  const flattened = flattenCommand(command);
  if (!flattened) return null;
  // `x=$(<命令>)` 先展开成内部命令：parser 会把 `x=$(gh` 当成 env 前缀，段里只剩 `api`
  const { text: flat, assigned } = expandAssignments(flattened);

  // `python3 <<'EOF' … EOF` 的正文被 `parseBashCommand` 剥掉了（args 里只剩 `<`），
  // 只读判定需要它。多个 heredoc 时无法确定哪个喂给了解释器 → 不提供（宁漏不误）。
  const heredocBody =
    extractHeredocBlocks(command).blocks.length === 1
      ? extractHeredocBlocks(command).blocks[0]!.body
      : undefined;

  let ast;
  let simple;
  try {
    ast = parseBashCommand(flat);
    simple = extractSimpleCommands(ast);
  } catch {
    return null; // 解析失败 → 不匹配（宁漏不误）
  }
  if (simple.length === 0) return null;

  // 写重定向（`gh pr checks 1 > out.txt`）→ 有副作用，放行
  const redirects = extractRedirectTargets(ast).filter((t) => t !== "/dev/null");
  if (redirects.length > 0) return null;

  // 循环（`for … do gh … done`）：整条交给循环展开，不再走「最后一段」判据
  const loop = findLoop(simple);
  if (loop) return matchLoopQuery(loop, heredocBody);

  // 选查询段：默认最后一段。末尾是「纯过滤命令」或「无害命令」时向前跳（R4）——
  // `gh pr view 780 --json state; date -u +%H:%M:%S` 这类给结果打时间戳的写法，
  // 原实现要求最后一段必须是过滤器，`date` 不是过滤器 → 整条判成非查询。
  // 只跳过「本身就无害 / 只读过滤」的段：`gh pr view 1; gh pr merge 1` 的末段是查询，
  // 不会走进这条；`gh pr view 1; rm x` 的末段两者都不是 → 仍然放行。
  const lastIdx = simple.length - 1;
  let queryIdx = lastIdx;
  let hit = hitSegment(simple[lastIdx]!);
  if (!hit) {
    let j = lastIdx;
    while (j >= 0 && (isReadonlyFilter(simple[j]!, heredocBody) || isHarmlessSegment(simple[j]!))) {
      j--;
    }
    if (j < 0) return null;
    hit = hitSegment(simple[j]!);
    if (!hit) return null;
    queryIdx = j;
  }

  // 判据 2：其余每一段都必须无害 / 本身也是查询 / 纯过滤
  //
  // 纯过滤命令**不限定位置**：962011a6 的主流写法是
  // `gh api …/check-runs | head -10; echo '=== PR ==='; gh pr view 701 …` ——
  // 第一个 `head` 属于前一个子命令的管道末端，位置在查询段之前。
  // 只允许「查询段之后」会把这类最常见写法全部漏掉（实测该会话 27/34 条）。
  // 安全性不变：`isReadonlyFilter` 只认不写文件、不持续跟随的一次性过滤命令。
  for (let i = 0; i < simple.length; i++) {
    if (i === queryIdx) continue;
    const seg = simple[i]!;
    if (!seg.command) return null;
    if (isHarmlessSegment(seg)) continue;
    if (isReadonlyFilter(seg, heredocBody)) continue;
    if (i < queryIdx && hitSegment(seg)) continue; // 之前也可以是查询（`gh pr status && gh pr checks 1`）
    return null; // 有不认识的一段 → 可能有写操作，放行
  }

  const subject = mergeDerivedSubject(hit, assigned);
  // 签名里带上整条复合命令（除无害段）：过滤段与前置查询都会改变输出形态，
  // 混用同一个 memo 会互相污染（`| head -10` 的输出与 `| jq …` 的不是一回事）。
  // 无害段（`cd` / `echo` / `sleep`）刻意不计入 —— 轮询时它们常变，查询语义没变。
  const sigParts: string[] = [];
  for (const seg of simple) {
    if (!seg.command || isHarmlessSegment(seg)) continue;
    sigParts.push(`${seg.command} ${seg.args.join(" ")}`.trim());
  }
  return {
    kind: hit.kind,
    family: hit.family,
    subject,
    signature: `${subject}\x1f${sigParts.join("; ")}`.trim(),
  };
}

/**
 * 从 monitor 脚本里扫出它覆盖的命令族（D13）。
 *
 * 为什么需要单独一个函数：`matchStatusQuery` 只认**单行、单条**状态查询
 * （`flattenCommand` 见到换行直接放弃），而 monitor 的 command 是一个 shell 脚本，
 * 查询通常裹在 `s=$(gh pr checks "$pr" --json ...)` 或 `do ... done` 循环里。
 *
 * 扫描口径刻意**保守**（扫不出 = 视为不覆盖 = 回到 120s 探测窗口）：
 * 宁可多放行几次（多花几次工具调用），也不要把没覆盖的查询当成覆盖了而拦到底。
 * 候选片段按「整行 → 命令替换内部 → shell 分隔符切开」三层生成；
 * 引号内的 `|` 会被误切，但那只多出候选片段、不会造出假命中。
 */
export function extractStatusQueryFamilies(script: string): StatusQueryFamily[] {
  const families = new Set<StatusQueryFamily>();
  for (const line of script.split("\n")) {
    for (const candidate of statusQueryCandidates(line)) {
      const m = matchStatusQuery(candidate);
      if (m) families.add(m.family);
    }
  }
  return [...families];
}

/**
 * 一行脚本里可能藏状态查询的片段（见 `extractStatusQueryFamilies` 的注释）。
 *
 * 导出给 `wait-subjects.ts`：等待表抽 subject 与 P1 抽命令族必须用**同一个切法**，
 * 否则同一行脚本会出现「P1 认得、等待表认不出」的两套尺子（R1 的根因 2 就是这个形态）。
 */
export function statusQueryCandidates(line: string): string[] {
  const out = new Set<string>();
  const push = (s: string): void => {
    const t = s.trim();
    if (t) out.add(t);
  };
  push(line);
  // 命令替换：真实 monitor 脚本几乎都写成 `s=$(gh pr checks ...)` / 反引号形态
  for (const m of line.matchAll(/\$\(([^()]*)\)/g)) push(m[1] ?? "");
  for (const m of line.matchAll(/`([^`]*)`/g)) push(m[1] ?? "");
  // shell 分隔符：`;` / `&` / `|`（含 `&&` / `||`）
  for (const seg of line.split(/[;&|]+/)) push(seg);
  return [...out];
}

/** 命令表命中结果：kind 决定归一化策略，tail 拼成 subject */
interface QueryHit extends RuleMatch {
  kind: StatusQueryKind;
}

/** 在一段简单命令上跑命令表 */
function matchQuery(command: string, args: string[]): QueryHit | null {
  for (const rule of RULES) {
    if (rule.command !== command) continue;
    const hit = rule.match(args);
    if (hit) return { ...hit, kind: rule.kind };
  }
  return null;
}

function subjectPrefix(kind: StatusQueryKind): string {
  switch (kind) {
    case "gh_pr":
      return "gh:pr:";
    case "gh_run":
      return "gh:run:";
    case "glab_mr":
      return "glab:mr:";
    case "glab_ci":
      return "glab:ci:";
    case "k8s":
      return "k8s:";
    case "http":
      return "http:";
  }
}

/** JSON 归一化时丢弃的键：都随外部世界自然变化，不携带「状态变没变」的信息 */
function isVolatileKey(k: string): boolean {
  return (
    k === "url" ||
    k === "link" ||
    // camelCase（`gh pr view --json`）与 GitHub REST 的 snake_case（`gh api`）两种形态都要盖住。
    // `_at` / `_url` 这两条是 N3 扩到 `gh api` 之后补的：`check_runs[]` 里
    // `started_at` / `completed_at` / `details_url` 每次都在变，不剥掉的话
    // gh api 查询的签名永远不相等，拦截形同虚设（拦不到，也不会误拦）。
    k.endsWith("At") || // startedAt / completedAt / createdAt / mergedAt / updatedAt
    k.endsWith("_at") || // started_at / completed_at / created_at / updated_at
    k.endsWith("Url") || // htmlUrl / detailsUrl
    k.endsWith("_url") || // html_url / details_url / target_url
    k.startsWith("duration") ||
    k.startsWith("elapsed")
  );
}

/** 递归剥掉易变键后稳定序列化；不是 JSON 时返回 null */
function stableJson(text: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const strip = (o: unknown): unknown => {
    if (Array.isArray(o)) return o.map(strip);
    if (o && typeof o === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o as Record<string, unknown>)) {
        if (isVolatileKey(k)) continue;
        out[k] = strip(x);
      }
      return out;
    }
    return o;
  };
  return JSON.stringify(strip(v));
}

/**
 * `gh pr checks` 的 TSV：`<name>\t<bucket|state>\t<elapsed>\t<url>`。
 *
 * 只保留 name 与 bucket 两列——耗时与 URL 每行都在变，而它们不携带状态信息。
 * 不是 TSV 形态时返回 null（交给通用路径）。
 *
 * D14 的第二道防线：E1 会把「检查未全部完成（gh 退出码 8 …）」拼在**首行**，
 * 首行只有一列 → 旧实现整段判为「不是 TSV」退回通用归一化，状态摘要随之退化成首行截断。
 * 这里先剥掉与 `GH_CHECKS_PENDING_HEADER` 完全相等的首行。
 * 与 tool-executor 读 `meta.rawOutput` 是「两道都留」：任一道失效，另一道仍能兜住。
 */
function normalizeChecksTsv(text: string): string | null {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  if (lines[0]?.trim() === GH_CHECKS_PENDING_HEADER) lines.shift();
  if (lines.length === 0) return null;
  const rows: string[] = [];
  for (const line of lines) {
    const cols = line.split("\t");
    // 至少要有 name + bucket 两列；单列文本（"no checks reported"）走通用路径
    if (cols.length < 2) return null;
    rows.push(`${cols[0]}\t${cols[1]}`);
  }
  return rows.join("\n");
}

/** ANSI 转义（有些 CLI 在非 tty 下也吐颜色） */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * 通用归一化：去 ANSI、抹耗时 token、折叠空白。T-P1-9 的「只差耗时列」靠这一条。
 *
 * 耗时 token 的正则是 `\d+(\.\d+)?(ms|s|m)\b`——刻意**不**匹配裸数字（`6 项 pending`
 * 里的 6、PR 号、run id 都得留着），也不匹配 `2h` 这种（`h` 不在字符类里）：
 * 少抹一种形态最多是「签名偏严、少拦一次」，多抹一种则可能把 `6 pending → 5 pending`
 * 这种真实变化吞掉。
 */
function normalizeText(text: string): string {
  return (
    text
      .replace(ANSI_RE, "")
      // 组合时长（`13m43s` / `1h2m3s`）要整体抹掉：下面那条单段正则对 `13m43s` 只能抹掉
      // 后一半（`13m` 后面紧跟 `4`，`\b` 不成立），两种不同时长就会归一化成不同签名。
      // 这正是 `gh run list` 的 ELAPSED 列形态，不抹干净等于「每轮都算状态变了」。
      .replace(/\d+(?:\.\d+)?[hms](?:\d+(?:\.\d+)?[ms])+/g, "<t>")
      .replace(/\d+(\.\d+)?(ms|s|m)\b/g, "<t>")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim()
  );
}

/**
 * 把一次状态查询的输出归一化成「签名」：两次输出归一化后相同 ⇔ 状态没变。
 *
 * 分派顺序（先精细后通用）：
 * 1. `gh pr checks` 的 TSV → 只留 name + bucket；
 * 2. 纯 JSON / JSON Lines → 剥易变键后稳定序列化（`--json` 输出走这条）；
 * 3. 其余 → 去 ANSI、抹耗时 token、折叠空白。
 *
 * 状态变化的例子：某个分片 `pending → pass`。它在 1/2/3 三条路径上都必然产生不同的签名，
 * 所以「真正的新信息永远放行」——这是判据的安全底线。
 */
export function normalizeStatusOutput(kind: StatusQueryKind, output: string): string {
  const text = output.trim();
  if (text === "") return "";

  if (kind === "gh_pr") {
    const tsv = normalizeChecksTsv(text);
    if (tsv !== null) return tsv;
  }

  const json = stableJson(text);
  if (json !== null) return json;

  // JSON Lines（`gh run list -q '.[]|{...}'` 逐行输出）：逐行归一化后拼回去
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length > 1) {
    const asJsonLines = lines.map((l) => stableJson(l.trim()));
    if (asJsonLines.every((x) => x !== null)) return asJsonLines.join("\n");
  }

  return normalizeText(text);
}

/**
 * 回执里的一句话状态摘要（§5.5.4）。
 *
 * 被拦时模型拿不到新输出，**必须**给它上次的结论，否则「压缩后再问」就彻底失忆。
 * 只做轻量提取：拿不到结构化信息时退化成首行截断，绝不为了摘要去猜。
 */
export function summarizeStatusOutput(kind: StatusQueryKind, normalized: string): string {
  if (kind === "gh_pr") {
    const rows = normalized.split("\n").filter((l) => l !== "");
    const buckets = new Map<string, number>();
    let tsv = false;
    for (const row of rows) {
      const cols = row.split("\t");
      if (cols.length < 2) continue;
      tsv = true;
      const bucket = cols[1]!.trim();
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    if (tsv) {
      const parts = [...buckets.entries()].map(([b, n]) => `${n} 项 ${b}`);
      return parts.join("，");
    }
    // JSON 形态：`{"checks":[{status,conclusion}...]}`
    try {
      const v = JSON.parse(normalized) as { checks?: Array<Record<string, unknown>> };
      if (Array.isArray(v.checks)) {
        if (v.checks.length === 0) return "0 项检查";
        const counts = new Map<string, number>();
        for (const c of v.checks) {
          const label =
            typeof c.conclusion === "string" && c.conclusion !== ""
              ? c.conclusion
              : typeof c.status === "string"
                ? c.status
                : "unknown";
          counts.set(label, (counts.get(label) ?? 0) + 1);
        }
        return [...counts.entries()].map(([l, n]) => `${n} 项 ${l}`).join("，");
      }
    } catch {
      /* 落到通用截断 */
    }
  }
  const firstLine = normalized.split("\n")[0] ?? "";
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}
