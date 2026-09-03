/**
 * 产物身份读取 + 三道门禁的判定逻辑（G1 评测前置 / G2 发布通道）
 *
 * PR-A 已经把身份编进了字节（`packages/shared/src/build-info.ts` 是格式的事实源）。
 * 本模块是**消费侧**：把那一行读出来，再据它判「这个产物能不能用在这个场景」。
 *
 * ## 为什么判定逻辑要抽成纯函数而不是写在 bash 里
 *
 * 三个消费方各自需要它的一部分：
 *   · `exec-swebench.sh` 的 G1（bash）
 *   · `evals/.../preflight.ts` 的第 ⑥ 项检查（TS）
 *   · `scripts/release.sh` 的 G2 上传/promote 检查（bash）
 *
 * 写三份 bash 的后果不是"重复"这么轻 —— 而是**三份会各自漂移，且漂移不报错**：
 * 一个判据写错的形态是"门禁看起来在跑、实际全在放行"。所以判定全部落在这里，
 * bash 侧只负责取数与展示，由 `scripts/artifact-identity.ts` 那个 CLI 桥接。
 *
 * ## 三条实测约束（改回去都不会报错，只会静默失去价值）
 *
 * 1. **`git cat-file -e <oid>` 必须带 `^{commit}`**。实测 `git cat-file -e $(git rev-parse HEAD^{tree})`
 *    返回 **0** —— tree / blob / tag 都算"对象存在"。不带它时，一个被截断的身份字段
 *    （恰好撞上某个 tree 的 oid）会通过存在性检查，然后在 `merge-base` 处以一个
 *    **语义不明的错误**失败：排查的人会去查"为什么这个 commit 不在历史里"，
 *    而真相是它根本不是 commit。
 *
 * 2. **拿 commit 拼命令之前必须先过 {@link isUsableCommit}**。它来自产物字节，
 *    可能被截断、可能是任意内容。消费方是 bash，一个含 `;` 或 `$(...)` 的值
 *    注入面是真实的。所以本模块在形态校验失败时**一条 git 命令都不发**
 *    （反漂移断言：测试会数 probe 的调用次数）。
 *
 * 3. **stale 判据必须限定在编译输入路径上**（{@link BUILD_INPUT_PATHS}）。
 *    退化成全仓 `git log C..HEAD` 会让 docs-only 提交也拦 —— 而
 *    **误报会训练人绕过门禁**（先加 `SWE_ALLOW_STALE_ARTIFACT=1` 再说），
 *    于是它真正该拦的那次也被放过去了。T8/T9 两条测试成对锁这个精度：
 *    只有 T8 时"判据写成全仓"也能过（更严嘛），只有 T9 时"永远放行"也能过。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  BUILD_INFO_GREP_PATTERN,
  isUsableCommit,
  parseBuildInfoLine,
  type BuildInfo,
} from "@sid-code/shared/build-info.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 编译输入清单 —— 这是 stale 判据的全部精度来源
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 「改了它就会改变产物字节」的路径清单。stale 判据是
 * `git log <产物commit>..HEAD -- <这些路径>` 非空。
 *
 * ⚠️ **这份清单会漂移，且漂移不会报错** —— 漏一条 = 该条改动之后产物不算 stale
 * = 静默放行。所以配了一条门禁测试（`tests/eval/artifact-identity.test.ts` 的 T3）：
 * 扫 Makefile 的 `build` 目标，它引用的每个脚本 / 输入都必须被本清单覆盖。
 * 这是本仓已有的模式（`tests/build/node-env-define.test.ts` 就是扫构建命令的哨兵）。
 *
 * ⚠️ **已知盲区**：`packages/core/vendor/model-catalog-snapshot.json` 与
 * `packages/core/vendor/rg-embed` **未入库**（实测 `git ls-files --error-unmatch` 均失败），
 * 所以它们的内容变化 git 看不见 —— 换了 rg 版本但没改 `fetch-ripgrep.ts` 时判不出来。
 * 不修：改成入库会让每次构建都脏工作区。靠 `origin` 与 `built_at` 辅助判断。
 */
export const BUILD_INPUT_PATHS = [
  // 全部源码。四个包都在这下面，所以不逐包列（逐包列才会漏新包）。
  "packages/",
  // 编译前生成内置 skill 的内联文件
  "scripts/embed-builtin-skills.ts",
  // 编译前生成模型目录快照
  "scripts/gen-model-catalog-snapshot.ts",
  // 编译前放置内嵌 rg
  "scripts/fetch-ripgrep.ts",
  // 被 backfill-team-defaults.ts 直接 import（编进二进制）
  "scripts/team-defaults.template.json",
  // 拼身份行的脚本 —— 它的输出直接进字节
  "scripts/build-info-line.sh",
  // BUILD_DEFINES（NODE_ENV / SID_CODE_BUILD_INFO）与 build 目标本身
  "Makefile",
] as const;

/**
 * bump 提交会把哪些文件收进历史 —— G2 的 dirty 白名单**只能**是这一份清单。
 *
 * 判据的正确形态不是「脏文件只有 package.json」，而是
 * **「构建那一刻的工作区 == tag v<ver> 的 tree」**：release.sh 在构建**之前**
 * 就生成了 changelog 产物（`:718` 生成 changelog、`:723` 生成内嵌 skill），
 * 而它们在构建**之后**的第 6 步随 bump 一起 commit（`RELEASE_COMMIT_FILES`）。
 * 所以这些文件在构建时必然是脏的，却**照样有 git 引用能重建** —— 就是 v<ver> 本身。
 *
 * ⚠️ 这里曾硬编码成 `f !== "package.json"`，后果是 **G2 首次真实运行即 5/5 全拦**
 * （2026-09-03 发 v0.1.602 实测：产物记的
 * `dirty_files=CHANGELOG.md+package.json+website/.vitepress/data/changelog.json`）。
 * 讽刺的是该函数文件头已经警告过这个失败模式（「按直觉写会 100% 误拦每一次真实发版，
 * 然后被人加 flag 绕过」），而单测把假设锁成了 `dirty_files: "package.json"` 一个文件
 * —— **测试锁住的是想象中的 release.sh，不是真的那个**。它在 v0.1.601 之后才引入，
 * 所以在此之前没有任何一次真实发布能暴露它。
 *
 * ⚠️ 与 `scripts/release.sh` 的 `RELEASE_COMMIT_FILES` 必须逐条相等，漂移不会报错
 * （放宽了 = 真带着未提交代码发版也放行；收窄了 = 每次发版全拦）。
 * 漂移门禁见 `tests/eval/artifact-identity.test.ts` 的 T8。
 */
export const RELEASE_COMMIT_PATHS: readonly string[] = [
  // bump 本体
  "package.json",
  // generate-changelog.ts 的两份产物（构建前生成、构建后提交）
  "CHANGELOG.md",
  "website/.vitepress/data/changelog.json",
  // embed-builtin-skills.ts 的产物：内容变了才会脏，没变时不出现在 dirty_files 里
  "packages/core/src/skill/builtin-embedded.generated.ts",
];

// ─────────────────────────────────────────────────────────────────────────────
// 取数：字节嗅探（通道 B）
// ─────────────────────────────────────────────────────────────────────────────

/** 注入的命令执行器。与 `preflight.ts` 的 `Runner` 结构兼容，可以直接把它传进来。 */
export interface CmdRunner {
  run(cmd: string[], opts?: { timeoutMs?: number }): { code: number; out: string };
}

export function makeCmdRunner(): CmdRunner {
  return {
    run(cmd, opts) {
      try {
        const p = Bun.spawnSync({
          cmd,
          stdout: "pipe",
          stderr: "pipe",
          timeout: opts?.timeoutMs,
          env: { ...process.env, LC_ALL: "C" },
        });
        return {
          code: p.exitCode ?? 1,
          out: `${p.stdout?.toString() ?? ""}${p.stderr?.toString() ?? ""}`,
        };
      } catch (err) {
        // 命令不存在一律当非 0，绝不吞成 0 —— 吞了就是把「没跑」变成「通过」
        return { code: 127, out: String(err) };
      }
    },
  };
}

/**
 * 从产物里嗅出身份行 —— **不执行产物**。
 *
 * ⚠️ 这条通道不是"备选"，是**必需**的：最需要门禁的那个场景恰好执行不了产物 ——
 * 宿主是 arm64 mac，评测产物是 `linux-x64-baseline`（给 qemu 容器用），
 * 在 arm64 上执行它得到 `exec format error`。
 *
 * 三个实现要点（每条都是实测出来的）：
 *   · **`grep -a` 不是可选的**。二进制里有 NUL 字节，不带 `-a` 时 grep 把它当
 *     binary file 直接不输出内容。本仓踩过同一个坑（搜 `app.ts` 漏报）。
 *   · **`LC_ALL=C`**：避免 locale 影响字符类语义（由 {@link makeCmdRunner} 统一设）。
 *   · **`-m1` 只是省开销**（不扫完 93MB），**正确性不依赖它** ——
 *     正则锚在 `commit=` 上才是正确性的来源（见 build-info.ts 里那段注释：
 *     裸前缀常量本身也在二进制里，先后顺序是运气）。
 *
 * tar.gz 走**流式**：`tar -xzOf` 到 stdout 再 grep，不落盘。实测 34MB 包 0.108s，
 * 可以放进每轮评测的前置检查。
 */
export function sniffArtifactIdentity(
  artifactPath: string,
  runner: CmdRunner,
): { line: string | null; info: BuildInfo } {
  const isTarball = /\.(tar\.gz|tgz)$/.test(artifactPath);
  let line: string | null = null;

  if (isTarball) {
    // `tar -xzOf <pkg>` 把归档里所有文件的内容拼到 stdout。不点名成员路径是刻意的：
    // 包内路径是 `sid-code/sid-code`，但 `SWE_ARTIFACT` 也可能指向别处打的包，
    // 成员名不保证。grep 只认那一行，多解出来的字节无害。
    const p = Bun.spawnSync({
      cmd: ["tar", "-xzOf", artifactPath],
      stdout: "pipe",
      stderr: "ignore",
    });
    if (p.exitCode === 0 && p.stdout) {
      const g = Bun.spawnSync({
        cmd: ["grep", "-a", "-m1", "-o", BUILD_INFO_GREP_PATTERN],
        stdin: p.stdout,
        stdout: "pipe",
        stderr: "ignore",
        env: { ...process.env, LC_ALL: "C" },
      });
      const out = (g.stdout?.toString() ?? "").trim();
      if (out) line = out.split("\n")[0];
    }
  } else {
    const r = runner.run(["grep", "-a", "-m1", "-o", BUILD_INFO_GREP_PATTERN, artifactPath]);
    if (r.code === 0) {
      const out = r.out.trim();
      if (out) line = out.split("\n")[0];
    }
  }

  // 读不到时**不编一个看起来正常的值**：parseBuildInfoLine("") 给出
  // identity_source=none + commit=unknown，消费方必须能看出「这是没量到」。
  return { line, info: parseBuildInfoLine(line ?? "") };
}

// ─────────────────────────────────────────────────────────────────────────────
// git 探针
// ─────────────────────────────────────────────────────────────────────────────

/** 判定需要的 git 事实。抽成接口是为了让测试不依赖真仓库状态（也才能数调用次数）。 */
export interface GitProbe {
  /** `git cat-file -e <oid>^{commit}` —— **`^{commit}` 不可省**，见文件头约束 1。 */
  commitExists(oid: string): boolean;
  /** `git merge-base --is-ancestor <oid> <ref>`。注意它是**自反的**（自己是自己的祖先）。 */
  isAncestor(oid: string, ref: string): boolean;
  /** `git log --oneline <oid>..HEAD -- <BUILD_INPUT_PATHS>` 的行数组。 */
  buildInputCommitsSince(oid: string): string[];
  /** `git describe --tags --always` —— 只作展示。 */
  describe(ref: string): string;
  /** `git rev-parse <ref>`，失败返 null。 */
  revParse(ref: string): string | null;
  /** `git status --porcelain` 非空。 */
  isDirty(): boolean;
  /** `git log -1 --format=%ct <ref>` 的秒级时间戳，失败返 null。仅 mtime 兜底路径用。 */
  commitTime(ref: string): number | null;
}

export function makeGitProbe(repoRoot: string, runner: CmdRunner): GitProbe {
  const git = (args: string[]) => runner.run(["git", "-C", repoRoot, ...args]);
  return {
    commitExists(oid) {
      return git(["cat-file", "-e", `${oid}^{commit}`]).code === 0;
    },
    isAncestor(oid, ref) {
      return git(["merge-base", "--is-ancestor", oid, ref]).code === 0;
    },
    buildInputCommitsSince(oid) {
      const r = git(["log", "--oneline", `${oid}..HEAD`, "--", ...BUILD_INPUT_PATHS]);
      if (r.code !== 0) return [];
      return r.out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    },
    describe(ref) {
      const r = git(["describe", "--tags", "--always", ref]);
      return r.code === 0 ? r.out.trim() : "unknown";
    },
    revParse(ref) {
      const r = git(["rev-parse", ref]);
      if (r.code !== 0) return null;
      const v = r.out.trim();
      return isUsableCommit(v) ? v : null;
    },
    isDirty() {
      const r = git(["status", "--porcelain"]);
      return r.code === 0 && r.out.trim().length > 0;
    },
    commitTime(ref) {
      const r = git(["log", "-1", "--format=%ct", ref]);
      if (r.code !== 0) return null;
      const n = Number(r.out.trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// G1：评测前置判定
// ─────────────────────────────────────────────────────────────────────────────

/**
 * G1 的判定结果。
 *
 * ⚠️ `identity_source` 三档不能塌成两档，理由与 preflight 的 `skip` 一样：
 * **不让「没量到」冒充「量到了且没变」**。本仓有实测教训
 * （`metric-exists-but-value-is-junk`）：字段在、有值、看起来正常，但值是废的。
 */
export type ArtifactVerdict =
  /** 产物 commit 在当前历史里，且此后没改过编译输入 */
  | "ok"
  /** 产物编出来之后编译输入又改了 —— 这就是本方案要消灭的那个形态（F1） */
  | "stale"
  /** 产物是另一条线上编的，不在当前 HEAD 的历史里 */
  | "foreign"
  /** 产物自报的 commit 不在本地对象库（别人编的？没 fetch？） */
  | "unknown-commit"
  /** 旁路 build-info.json 与产物字节不一致 —— 一个会骗人的索引比没有索引更糟 */
  | "sidecar-mismatch"
  /** 读不到身份（老产物或漏带 define），已退化到 mtime 兜底且判定为旧 */
  | "no-identity-stale"
  /** 读不到身份，mtime 兜底判定为不旧 —— **这不是"通过"，是"没量到"** */
  | "no-identity";

export interface ArtifactAssessment {
  verdict: ArtifactVerdict;
  /** `embedded` = 真读到了；`mtime-fallback` = 老产物，退化到时间戳兜底。 */
  identitySource: "embedded" | "mtime-fallback";
  info: BuildInfo;
  /** 人读的判定理由（多行）。fail 时必须说清"什么没到位"。 */
  reasons: string[];
  /** 不拦但必须点破的事（dirty 等）。 */
  warnings: string[];
  /** stale 时：产物 commit 之后改过编译输入的那些提交（`git log --oneline` 行）。 */
  changedInputCommits: string[];
  hostHeadCommit: string | null;
  hostDirty: boolean;
  /** 产物 commit 与宿主 HEAD 是否一致。identity 读不到时为 null（**不是 false**）。 */
  commitMatchesHost: boolean | null;
  artifactDescribe: string;
}

/** 旁路 `build-info.json` 的一致性检查（T6）。返回 null = 没有旁路文件，不算问题。 */
export function verifySidecar(
  artifactPath: string,
  info: BuildInfo,
): { ok: boolean; reason?: string } | null {
  const sidecar = join(dirname(artifactPath), "build-info.json");
  if (!existsSync(sidecar)) return null;
  let parsed: { commit?: string; built_at?: string };
  try {
    parsed = JSON.parse(readFileSync(sidecar, "utf8"));
  } catch (err) {
    return { ok: false, reason: `旁路 build-info.json 解析失败：${String(err).slice(0, 120)}` };
  }
  if (!parsed.commit) {
    return { ok: false, reason: "旁路 build-info.json 里没有 commit 字段" };
  }
  if (parsed.commit !== info.commit) {
    return {
      ok: false,
      reason:
        `旁路 build-info.json 说 commit=${parsed.commit.slice(0, 12)}，` +
        `产物字节里是 ${info.commit.slice(0, 12)} —— ` +
        "**字节才是事实源**，这份 json 在骗人（重新打包或删掉它）",
    };
  }
  return { ok: true };
}

/**
 * G1 三步判据（方案 §5.1 的 ①–⑥）。
 *
 * 判据不是「产物含 main 最新」而是 **「产物的 commit ∈ 当前工作副本的历史，
 * 且此后没有改动过任何编译输入」**。这个区别是全部设计的核心：
 * 「必须含 main 最新」会拦住三种合法场景（PR 分支上验证自己的改动、
 * main 刚合了别人一个无关 PR、故意用旧产物做对照），而**误报会训练人绕过门禁**。
 *
 * @param artifactMtimeSec 产物 mtime（秒）。只在身份读不到时作为兜底判据用 ——
 *   `cp` 会把它重置成"现在"，所以它**不能**作为有身份时的判据。
 */
export function assessArtifact(input: {
  artifactPath: string;
  info: BuildInfo;
  probe: GitProbe;
  artifactMtimeSec: number | null;
  /** 注入以便测试；生产由 CLI 从 {@link verifySidecar} 取。 */
  sidecar?: { ok: boolean; reason?: string } | null;
}): ArtifactAssessment {
  const { info, probe } = input;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const hostHeadCommit = probe.revParse("HEAD");
  const hostDirty = probe.isDirty();

  const base = {
    info,
    warnings,
    changedInputCommits: [] as string[],
    hostHeadCommit,
    hostDirty,
    artifactDescribe: info.describe,
  };

  // ①② 读不到身份 / commit=unknown → 退化到 mtime 兜底，但**显式记下来**。
  //
  // ⚠️ 这里绝不能静默填一个假的 commit（比如宿主 HEAD）。那会让一份
  // 「不知道跑的是哪份代码」的报告看起来比它实际能支持的更可靠 —— 而这正是
  // 本方案起因那个事故的形态（run-meta 里每个字段都正常，结论是错的）。
  //
  // ⚠️ 形态校验（isUsableCommit）在这里，**在任何 git 命令之前**：
  // commit 来自产物字节，可能被截断、可能是任意内容，而下游消费方是 bash。
  if (info.identity_source === "none" || !isUsableCommit(info.commit)) {
    const why =
      info.identity_source === "none"
        ? "产物不含构建身份（老产物，或构建时漏带 --define process.env.SID_CODE_BUILD_INFO）"
        : `产物自报的 commit 不是可用的 40 位 hex（读到 ${JSON.stringify(info.commit.slice(0, 24))}，可能被截断）`;
    reasons.push(why);
    reasons.push(
      "→ 已退化到 mtime 兜底判据。⚠️ mtime 两个方向都会错：`cp` 会把它重置成「现在」" +
        "（内容一字未改也放行），docs-only 提交会推进 HEAD 时间（好产物被拦）。" +
        "**这一轮只可自比，不可外比。**",
    );
    const headTs = probe.commitTime("HEAD");
    const stale =
      input.artifactMtimeSec !== null && headTs !== null && input.artifactMtimeSec < headTs;
    if (stale) {
      reasons.push("mtime 兜底判定：产物比 HEAD 的提交时间还早 —— 它大概率不含最近的改动");
    }
    return {
      ...base,
      verdict: stale ? "no-identity-stale" : "no-identity",
      identitySource: "mtime-fallback",
      commitMatchesHost: null,
      reasons,
    };
  }

  const shortArt = info.commit.slice(0, 12);
  const commitMatchesHost = hostHeadCommit !== null ? info.commit === hostHeadCommit : null;
  const embedded = { ...base, identitySource: "embedded" as const, commitMatchesHost };

  // ⑥ dirty 是警告不是拦：脏工作区编的包，commit 只描述了"基线"，改动内容无记录。
  // 只能报警不能解决 —— 但**必须点破**，否则报告会让人以为 commit 描述了全部。
  if (info.dirty === true) {
    warnings.push(
      `产物编自脏工作区（dirty=true${info.dirty_files ? `, ${info.dirty_files}` : ""}）—— ` +
        "commit 只描述了基线，改动内容无记录，这一轮只可自比不可外比",
    );
  } else if (info.dirty === "unknown") {
    warnings.push("产物没记 dirty（读不到）—— 不能替它断言「构建时工作区是干净的」");
  }

  // 旁路索引在骗人 → 拦。修法很便宜（重新打包或删掉那个 json），
  // 但放过去的代价是以后所有人都不能信 `ls` 出来的东西。
  const sidecar = input.sidecar ?? null;
  if (sidecar && !sidecar.ok) {
    reasons.push(sidecar.reason ?? "旁路 build-info.json 与产物字节不一致");
    return { ...embedded, verdict: "sidecar-mismatch", reasons };
  }

  // ③ commit 在本地对象库里吗（**带 `^{commit}`**，见文件头约束 1）
  if (!probe.commitExists(info.commit)) {
    reasons.push(`产物自报 commit ${shortArt} **不在本地对象库** —— 别人编的包？还是没 fetch？`);
    reasons.push("→ 先 `git fetch --all` 再重试。取不到那个 commit 时无法判断产物新旧。");
    return { ...embedded, verdict: "unknown-commit", reasons };
  }

  // ④ 在当前 HEAD 的历史里吗（merge-base 是自反的，所以 commit == HEAD 时也通过）
  if (!probe.isAncestor(info.commit, "HEAD")) {
    reasons.push(
      `产物是**另一条线**上编的：${shortArt} 不是当前 HEAD 的祖先` +
        `（产物 ${probe.describe(info.commit)} / HEAD ${probe.describe("HEAD")}）`,
    );
    reasons.push(
      "→ 有意为之（跨分支 A/B 对比）就设 SWE_ALLOW_FOREIGN_ARTIFACT=1；" +
        "⚠️ 它与 SWE_ALLOW_STALE_ARTIFACT 语义不同，两者刻意不合成一个 —— " +
        "报告里对这两件事的解读完全不同。",
    );
    return { ...embedded, verdict: "foreign", reasons };
  }

  // ⑤ 产物编出来之后，编译输入又改了吗 —— **这就是 F1 那个形态**
  const changed = probe.buildInputCommitsSince(info.commit);
  if (changed.length > 0) {
    reasons.push(
      `产物编出来之后，编译输入又改了 ${changed.length} 次 —— ` +
        "**跑它就是在跑改动之前的代码，而分数会看起来完全正常**",
    );
    for (const c of changed.slice(0, 12)) reasons.push(`   ${c.slice(0, 100)}`);
    if (changed.length > 12) reasons.push(`   …还有 ${changed.length - 12} 个`);
    reasons.push(
      "→ 编一个当前 commit 的包：bun run scripts/build-branch-artifact.sh" +
        "（它会跑齐 3 个生成脚本 + 带 baseline target + 带两个 define）",
    );
    reasons.push(
      "→ 确认要用旧产物做对照：SWE_ALLOW_STALE_ARTIFACT=1（会记进 run-meta.gate_bypassed）",
    );
    return { ...embedded, verdict: "stale", reasons, changedInputCommits: changed };
  }

  return { ...embedded, verdict: "ok", reasons };
}

/** G1 verdict → 进程退出码。bash 侧按数字分流，所以这张表是跨语言契约，改它要同步改 exec-swebench.sh。 */
export const EXIT_CODE: Record<ArtifactVerdict, number> = {
  ok: 0,
  // 读不到身份**不拦**（老产物是既有事实，硬拦只会逼人绕过整道门禁），
  // 但退化路径必须写进 run-meta 的 identity_source，别静默。
  "no-identity": 0,
  "no-identity-stale": 0,
  stale: 2,
  foreign: 3,
  "unknown-commit": 4,
  "sidecar-mismatch": 5,
};

// ─────────────────────────────────────────────────────────────────────────────
// G2：发布通道判定
// ─────────────────────────────────────────────────────────────────────────────

export interface ReleaseGateResult {
  ok: boolean;
  reasons: string[];
}

/**
 * G2 上传前：`dist/release/<ver>/` 里的产物必须是**发布流程编的**。
 *
 * ## ⚠️ 两条判据按直觉写会 100% 误拦每一次真实发版
 *
 * 已核实 `release.sh` 的真实执行顺序（`:591` 洁净门禁 → `:610` bump → `:731` 构建
 * → `:867` commit → `:878` tag），`:589` 那行注释明写「必须放在 bump 之前：
 * bump 自己就会让工作区变脏」。于是**构建那一刻**：
 *
 *   git rev-parse HEAD      = bump 提交的**父**提交（bump 提交此刻还不存在）
 *   git status --porcelain  = **非空**（package.json 刚被 bump 改过）
 *
 * | 直觉写法（❌） | 为什么必错 | 正确写法 |
 * | --- | --- | --- |
 * | `dirty == false` | 构建发生在 bump 之后，package.json 必脏 | 脏文件都在 {@link RELEASE_COMMIT_PATHS} 里 |
 * | `commit == 本次 bump 提交` | bump 提交在构建之后才创建 | `commit == v<ver>^` |
 *
 * 照直觉写的后果不是"报个错" —— 是每次发版都被拦、然后被人加 flag 绕过，
 * 那就又变成"误报训练人绕过门禁"。
 *
 * @param expectedCommit `git rev-parse "v<ver>^"` 的结果。取不到时传 null（此时跳过 commit 判据并点破）。
 */
export function judgeReleaseUpload(input: {
  info: BuildInfo;
  expectedCommit: string | null;
  artifactName: string;
}): ReleaseGateResult {
  const { info, expectedCommit, artifactName } = input;
  const reasons: string[] = [];

  // 身份读不到 → 拦。发布路径与评测路径在这里刻意不同：评测要容忍老产物
  // （它们是既有事实），而发布产物是**这一刻刚编出来的**，没有身份只能说明
  // 构建循环漏了 define —— 那正是 T7 哨兵在防的东西，放过去等于取消 G2。
  if (info.identity_source === "none") {
    return {
      ok: false,
      reasons: [
        `${artifactName}: 不含构建身份 —— 构建循环漏带 --define process.env.SID_CODE_BUILD_INFO？`,
        "→ 没有身份的产物无法判断它是不是发布流程编的，拒绝上传。",
      ],
    };
  }

  // origin：唯一能拦住「手工编的二进制被塞进 dist/release/<ver>/ 再上传」的判据。
  // 在这之前 release.sh 只检查文件存在。
  if (info.origin !== "release") {
    reasons.push(
      `${artifactName}: origin=${info.origin}，发布产物必须是 release ——` +
        "手工编的包（local）或源码直跑（source）不许上通道",
    );
  }

  // dirty：宽松，但**要真的解析脏文件清单**，不能只看布尔位。
  // 只看布尔位的话只有两个选择：要么恒拦（误拦每次发版），
  // 要么不检查（漏掉「真的带着未提交代码发版」这个形态）。
  if (info.dirty === true) {
    const files = (info.dirty_files ?? "")
      .split("+")
      .map((s) => s.trim())
      .filter(Boolean);
    if (files.length === 0) {
      reasons.push(
        `${artifactName}: dirty=true 但没记 dirty_files —— ` +
          "无法区分「bump 造成的脏」与「带着未提交代码发版」，拒绝",
      );
    } else {
      // 白名单 = bump 提交会收进历史的那批文件（见 RELEASE_COMMIT_PATHS 的注释）。
      // 判的是「这些脏改动有没有 git 引用能重建」，不是「工作区有没有脏」。
      const unexpected = files.filter((f) => !RELEASE_COMMIT_PATHS.includes(f));
      if (unexpected.length > 0) {
        reasons.push(
          `${artifactName}: 构建时工作区有未提交改动（不在发布提交清单里的：` +
            `${unexpected.join(", ")}）—— 这些改动进了产物但没进任何 commit，` +
            "发布出去就没有任何 git 引用能重建它",
        );
      }
    }
  } else if (info.dirty === "unknown") {
    reasons.push(`${artifactName}: 没记 dirty —— 不能替它断言"构建时工作区只有 bump 那一处脏"`);
  }

  // commit：必须等于 tag 所指提交的**父**提交。
  if (expectedCommit === null) {
    reasons.push(
      `${artifactName}: 取不到 v<ver>^ —— 无法校验产物 commit（tag 还没打？--no-commit？）` +
        "。这一条降级为提示，不单独拦。",
    );
  } else if (info.commit !== expectedCommit) {
    reasons.push(
      `${artifactName}: 产物 commit=${info.commit.slice(0, 12)}，` +
        `期望 ${expectedCommit.slice(0, 12)}（= v<ver>^，构建时的 HEAD）—— ` +
        "产物与本次发布的 tag 对不上，上传出去就无法用任何 git 引用重建",
    );
  }

  // 「取不到 v<ver>^」那条是提示不是拦，所以单独滤一次。
  const blocking = reasons.filter((r) => !r.includes("这一条降级为提示"));
  return { ok: blocking.length === 0, reasons };
}

/**
 * `--promote` 前：目标版本的产物 commit 必须是 main 的祖先。
 *
 * 拦的是「把一个分支包 promote 成稳定版」。这条把 `CLAUDE.md` 里那句人工核验
 * （`git merge-base --is-ancestor v<version> main`）变成机械断言。
 *
 * ⚠️ `merge-base --is-ancestor` 是**自反的**（实测：一个提交是它自己的祖先，返回 0），
 * 这正是这里要的语义 —— tag 就在 main 上时也该通过。
 */
export function judgePromote(input: {
  info: BuildInfo;
  isAncestorOfMain: boolean | null;
  version: string;
}): ReleaseGateResult {
  const { info, isAncestorOfMain, version } = input;
  if (info.identity_source === "none") {
    return {
      ok: true,
      reasons: [
        `v${version} 的产物不含构建身份（发布于本机制上线之前）—— ` +
          "无法校验它是否在 main 上。放行，但这一条没量到。",
      ],
    };
  }
  if (isAncestorOfMain === null) {
    return {
      ok: true,
      reasons: [`取不到 main 或 ${info.commit.slice(0, 12)} 不在本地对象库 —— 祖先关系未验证。`],
    };
  }
  if (!isAncestorOfMain) {
    return {
      ok: false,
      reasons: [
        `v${version} 的产物编自 ${info.commit.slice(0, 12)}（${info.branch}），` +
          "**它不是 main 的祖先** —— 这是个分支包，不能促升成稳定版。",
        "→ 先把那条分支合进 main，再重新发一版。",
      ],
    };
  }
  return { ok: true, reasons: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

/** 产物 mtime（秒）。只用于身份读不到时的兜底判据 —— 见 assessArtifact 的说明。 */
export function artifactMtimeSec(path: string): number | null {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000);
  } catch {
    return null;
  }
}

export { basename, isUsableCommit };
