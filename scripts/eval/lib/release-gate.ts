/**
 * L2 发版闸（方案 T20）的**纯判定函数**。编排在 `scripts/eval/release-gate.ts`，
 * 入口是 `scripts/eval/release-gate.sh <version>`。
 *
 * 这里只放「给定输入 → 红项」的函数，不 spawn、不落盘，单测逐条覆盖。
 * 每一条红项最终都作为 `eval-verdict.py --block` 传进判定器，结论只能是 INVALID ——
 * **判定器是 verdict 的唯一出处**，本模块不自己写 `PASS` / `INVALID` 字符串。
 */

/** 评测容器是 linux/arm64（colima on Apple Silicon），L2 只测这一个平台。 */
export const UNDER_TEST_PLATFORM = "linux-arm64";

/** 方案 P3「做什么」1：traj-bench 全量整轮预算 $40。账本按这个上限做熔断判定。 */
export const L2_PLANNED_CAP_USD = 40;

/**
 * 开跑前 docker 可用内存下限。真实 agent 在 `-n 6` 下实测约 9GB
 * （记忆 harbor-real-agent-n6-memory-is-9gb-not-714mb）。不足就判 INVALID：
 * OOMKill 在产物里长得像「agent 没做完」，会伪装成能力失败。
 */
export const REQUIRED_DOCKER_MEM_BYTES = 9 * 1024 ** 3;

export const DEFAULT_RELEASE_BASE = "https://www.sid-code.cc/releases/sid-code";

/** 已有裁决、且结论不是 INVALID 时不重跑（T22 每天调用的幂等前提；INVALID 次日重试）。 */
export const FINAL_VERDICTS = ["PASS", "WARN", "REGRESSION"] as const;

export interface ArtifactUrls {
  tarballName: string;
  tarball: string;
  sha256: string;
  manifest: string;
}

/** 与 release.sh 的 `TARBALL_NAME="sid-code-${VERSION}-${PLATFORM}.tar.gz"` 同形。 */
export function artifactUrls(base: string, version: string): ArtifactUrls {
  const b = base.replace(/\/+$/, "");
  const tarballName = `sid-code-${version}-${UNDER_TEST_PLATFORM}.tar.gz`;
  return {
    tarballName,
    tarball: `${b}/${version}/${tarballName}`,
    sha256: `${b}/${version}/${tarballName}.sha256`,
    manifest: `${b}/versions.json`,
  };
}

/** 版本号白名单：它会被拼进 URL 和文件路径，只允许 semver 形态（含 -beta.N 之类后缀）。 */
export function isValidVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(v);
}

/**
 * `.sha256` 旁路文件：`<64 hex>  <文件名>`（release.sh 用 sha256sum 的格式写）。
 * 文件名必须是这个 tarball —— 防「拿别的包的校验和」这种形态。
 */
export function parseShaSidecar(text: string, expectedName: string): string | null {
  const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/m.exec(text.trim());
  if (!m) return null;
  return m[2] === expectedName ? m[1]! : null;
}

/** versions.json 里该版本该平台的 sha256；取不到返回 null（不编值）。 */
export function manifestSha(manifest: unknown, version: string): string | null {
  const versions = (manifest as { versions?: unknown })?.versions;
  if (!Array.isArray(versions)) return null;
  const v = versions.find((x) => (x as { version?: unknown })?.version === version) as
    | { platforms?: Record<string, { sha256?: unknown }> }
    | undefined;
  const sha = v?.platforms?.[UNDER_TEST_PLATFORM]?.sha256;
  return typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha) ? sha : null;
}

/**
 * 下载的 tarball 必须与 `--upload` 时记录的 sha256 一致。
 *
 * 两处记录：版本目录里的 `.sha256`（**必需**，promote 也认它）与 versions.json（清单是派生物，
 * `release.sh` 发清单失败只 warn 不 fail，所以新 beta 可能还没进清单 —— 缺席只记提示）。
 * 只要有一处**在场且不一致**就红。
 */
export function judgeArtifactSha(input: {
  actual: string;
  sidecar: string | null;
  manifest: string | null;
}): { red: string[]; notes: string[] } {
  const red: string[] = [];
  const notes: string[] = [];
  if (input.sidecar === null) {
    red.push("取不到（或解析不了）发布目录里的 .sha256 —— 无法证明下载的就是 upload 的那份");
  } else if (input.sidecar !== input.actual) {
    red.push(
      `下载产物 sha256=${input.actual.slice(0, 12)}，.sha256 记录 ${input.sidecar.slice(0, 12)} —— 不是 upload 的那份`,
    );
  }
  if (input.manifest === null) {
    notes.push(
      "versions.json 里没有该版本的 linux-arm64 记录（清单发布可能滞后），只按 .sha256 校验",
    );
  } else if (input.manifest !== input.actual) {
    red.push(
      `下载产物 sha256=${input.actual.slice(0, 12)}，versions.json 记录 ${input.manifest.slice(0, 12)} —— 清单与产物对不上`,
    );
  }
  return { red, notes };
}

const UNIT: Record<string, number> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
};

/** `1.234GiB` / `512MiB` / `0B` → 字节；解析不了返回 null。 */
export function parseByteSize(s: string): number | null {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?i?B)\s*$/i.exec(s);
  if (!m) return null;
  const k = UNIT[m[2]!.toUpperCase()];
  return k === undefined ? null : Number(m[1]) * k;
}

/**
 * docker 可用内存 = `docker info {{.MemTotal}}` − 正在跑的容器占用之和
 * （`docker stats --no-stream --format {{.MemUsage}}` 每行 `used / limit`）。
 *
 * 只看 MemTotal 不够：上一轮没收干净的容器会吃掉余量，正是 OOMKill 的来源。
 * 任何一行解析不了都判红 —— 读不懂 = 不知道还剩多少。
 */
export function judgeDockerMemory(input: {
  memTotalText: string;
  statsText: string;
  requiredBytes?: number;
}): { red: string[]; availableBytes: number | null } {
  const need = input.requiredBytes ?? REQUIRED_DOCKER_MEM_BYTES;
  const total = Number(input.memTotalText.trim());
  if (!Number.isFinite(total) || total <= 0) {
    return {
      red: [
        `读不到 docker MemTotal（得到 ${JSON.stringify(input.memTotalText.trim().slice(0, 80))}）—— docker/colima 没起？`,
      ],
      availableBytes: null,
    };
  }
  let used = 0;
  for (const line of input.statsText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    const b = parseByteSize(line.split("/")[0] ?? "");
    if (b === null) {
      return {
        red: [`读不懂 docker stats 行 ${JSON.stringify(line.slice(0, 80))} —— 不知道已占用多少`],
        availableBytes: null,
      };
    }
    used += b;
  }
  const avail = total - used;
  const gib = (n: number) => (n / 1024 ** 3).toFixed(1);
  if (avail < need) {
    return {
      red: [
        `docker 可用内存 ${gib(avail)}GiB（总 ${gib(total)} − 在跑容器 ${gib(used)}）< 需要 ${gib(need)}GiB —— 先收掉残留容器或调大 colima`,
      ],
      availableBytes: avail,
    };
  }
  return { red: [], availableBytes: avail };
}

export interface PmsetEvent {
  at: string;
  event: string;
  detail: string;
}

/** `2026-11-07 21:25:59 +0800` → epoch ms；不是这个形态返回 null。 */
export function parsePmsetTime(s: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`);
  return Number.isFinite(t) ? t : null;
}

/**
 * `pmset -g log` 里落在 [startMs, endMs] 的睡眠事件。
 *
 * 行形态（实测）：`<时间戳> <事件列，空格补齐>\t<详情>`。只看**事件列**：
 * 详情里出现 "Sleep"（如 `Delays to Sleep notifications`）不算。
 * 事件列以 `Sleep` 结尾的都算（`Sleep` / `Maintenance Sleep`）——
 * 维护睡眠同样会冻住容器里的计时，污染耗时与超时判定。
 */
export function sleepEventsInWindow(log: string, startMs: number, endMs: number): PmsetEvent[] {
  const out: PmsetEvent[] = [];
  for (const line of log.split("\n")) {
    const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}) ([^\t]+?)\s*\t(.*)$/.exec(line);
    if (!m) continue;
    const event = m[2]!.trim();
    if (!/(^|\s)Sleep$/.test(event)) continue;
    const t = parsePmsetTime(m[1]!);
    if (t === null || t < startMs || t > endMs) continue;
    out.push({ at: m[1]!, event, detail: m[3]!.trim().slice(0, 160) });
  }
  return out;
}

/**
 * 容器里实际跑的二进制（适配器从产物字节读回的 sha256）必须**恰好一个**，
 * 且等于从下载 tarball 里解出来的那份。「跑的不是你以为的那份」（evals/CLAUDE.md §3.1）。
 */
export function judgeBinaryIdentities(
  identities: ReadonlyArray<ReadonlyArray<unknown>>,
  expectedSha: string,
): string[] {
  const shas = [...new Set(identities.map((x) => x[0]))];
  if (shas.length === 0) return ["容器内二进制身份一条都没采到 —— 无法证明跑的是被测版本"];
  if (shas.length > 1)
    return [`容器内出现 ${shas.length} 个不同的二进制 sha256：${shas.map(String).join(", ")}`];
  if (shas[0] !== expectedSha) {
    return [
      `容器内二进制 sha256=${String(shas[0]).slice(0, 12)}，下载解出的是 ${expectedSha.slice(0, 12)} —— 跑错了二进制`,
    ];
  }
  return [];
}

export const BRIDGE_JSON_PREFIX = "L2RULER_JSON ";

export interface BridgeResult {
  ok: boolean;
  red: string[];
  [k: string]: unknown;
}

/** 尺子桥 stdout 最后一行结论；没有结论行 = 桥崩在半路，按红处理（不当通过）。 */
export function parseBridgeOutput(stdout: string, exitCode: number, label: string): BridgeResult {
  const lines = stdout.split("\n").filter((l) => l.startsWith(BRIDGE_JSON_PREFIX));
  const last = lines[lines.length - 1];
  if (!last) {
    return { ok: false, red: [`${label}：尺子桥没有输出结论行（退出码 ${exitCode}）`] };
  }
  let doc: BridgeResult;
  try {
    doc = JSON.parse(last.slice(BRIDGE_JSON_PREFIX.length)) as BridgeResult;
  } catch {
    return { ok: false, red: [`${label}：尺子桥结论行不是合法 JSON`] };
  }
  const red = Array.isArray(doc.red) ? doc.red.map(String) : [];
  // 退出码与 ok 必须一致：任一说不通过就不通过
  if (exitCode !== 0 || doc.ok !== true) {
    return {
      ...doc,
      ok: false,
      red: red.length ? red.map((r) => `${label}：${r}`) : [`${label}：退出码 ${exitCode}`],
    };
  }
  return { ...doc, ok: true, red: [] };
}

/** 已有裁决是否可以跳过（结论在 FINAL_VERDICTS 里，且指向同一个 tarball sha）。 */
export function shouldSkipExisting(existing: unknown): boolean {
  const v = (existing as { verdict?: unknown })?.verdict;
  return typeof v === "string" && (FINAL_VERDICTS as readonly string[]).includes(v);
}
