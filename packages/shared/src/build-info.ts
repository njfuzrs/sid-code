/**
 * 构建身份（build provenance）—— 把「这个二进制是哪个 commit 编的」编进字节里
 *
 * ## 为什么需要它
 *
 * 实测（2026-08-26）：`package.json` 是 `0.1.601`，tag `v0.1.601` 打在 **8月21**，
 * 而 8月26 合入的两个修复都不在里面（`git merge-base --is-ancestor <fix> v0.1.601` 失败）。
 * `make build` **刻意不 bump 版本号**，所以「重新构建」不会改变评测挑产物的那个路径。
 * 于是「跑评测验证本轮修复」静默跑成了「跑 5 天前的代码」——
 * 分数正常、日志正常、`run-meta.json` 里的 `sid_code_version` 也正常，
 * **没有任何一处会报错**。`git describe` 才能看出这个缝：`v0.1.601-59-g454cf79c`
 * —— 同一个版本号后面挂着 59 个提交。
 *
 * 结论：**版本号不是身份**。身份只能是 commit，而且必须跟着字节走
 * （旁路文件会与产物分离：`docker cp` 只 cp 二进制、评测可以直接指向裸二进制）。
 *
 * ## 为什么是「单行 + 固定前缀 + `|` 分隔」而不是 JSON
 *
 * 因为最需要读身份的那个场景**执行不了产物**：宿主是 arm64 mac，评测产物是
 * `linux-x64-baseline`（给 qemu 容器用）。所以必须能**不执行、跨架构**地读出来：
 *
 *   LC_ALL=C grep -a -m1 -o 'SIDCODE_BUILD_V1|commit=[A-Za-z0-9=|:._@+/-]*' ./sid-code
 *
 * 实测 JSON 会在字节流里被字符串处理切碎，单行 `|` 分隔可以一次 `grep -o` 完整取出
 * （34MB tar.gz 流式抽取 0.108s，可以放进每轮评测的前置检查）。
 *
 * ## 三条不能改回去的约束（改回去都不会报错，只会静默失去价值）
 *
 * 1. **默认值的前缀必须与真值不同**（`SIDCODE_BUILD_V0_NONE|` vs `SIDCODE_BUILD_V1|`）。
 *    `--define` 是**编译期字面量替换**，`process.env.X ?? "默认"` 会被折叠成 `"真值"`
 *    从而把默认值 DCE 掉；但只要默认值存进另一个绑定（就像下面 `RAW_DEFAULT` 这样），
 *    它**会留在二进制里，而且排在真值前面** —— 实测 `grep -m1` 于是取到 `unknown`。
 *    靠「前缀不同」而不是靠「DCE 会帮我们删掉它」，因为 DCE 是优化行为、随 bun 版本可能变。
 *    ⚠️ 这一条最容易被「顺手统一一下前缀常量」破坏，破坏后的形态是
 *    **门禁把每个产物都读成 `commit=unknown`、一律退化到 mtime 兜底**，看起来还在跑。
 *    反漂移在 `tests/build/build-info-define.test.ts`。
 *
 * 2. **`commit` 必须是第一个字段**。值域字符类里漏一个字符（实测漏 `@` 时
 *    `builder=a@b.com` 被截成 `builder=a`，其后的 `origin` 整个丢掉）会从截断点往后丢字段。
 *    把最关键的字段放最前面，坏的方式至少是可预期的。
 *
 * 3. **不要把 commit 拼进 `getVersion()` / `getRawVersion()`**。实测 10+ 个消费点，
 *    其中 `packages/cli/src/app.ts` 用 version 做网关定价刷新的水位线
 *    （版本变了就触发全端点强制刷新），`trace/collector.ts` 用它当 `app_version`
 *    （北极星按 release 归因的键）。身份走独立的 `--build-info`，不动 `--version`。
 *
 * ## 它不能防什么
 *
 * 二进制里那一行是明文，理论上可以用十六进制编辑器改掉。**门禁防的是疏漏不是恶意**，
 * 真要防篡改需要签名，那是另一个量级的工程。
 * 另一条已知盲区：`dirty=true` 时 commit 只描述了"基线"，改动内容无记录 ——
 * 只能报警不能解决，消费方必须点破而不是假装 commit 描述了全部。
 */

/** 真值前缀。嗅探正则只认它 —— 见文件头约束 1。 */
export const BUILD_INFO_PREFIX = "SIDCODE_BUILD_V1|";

/**
 * 「没有构建身份」的前缀。**必须与 {@link BUILD_INFO_PREFIX} 不同**，
 * 否则嗅探会读到它（它在二进制里排在真值前面）。
 */
export const BUILD_INFO_NONE_PREFIX = "SIDCODE_BUILD_V0_NONE|";

/** schema 版本位：格式演进时能识别老产物。由前缀里的 `V1` 派生，不单独占一个字段。 */
export const BUILD_INFO_SCHEMA = 1;

/**
 * 值域字符类（grep / JS 正则通用的内容部分）。
 *
 * 每一类字符都有具体来源，删任何一个都会切坏那一行：
 *   `/`  分支名（`fix/xxx`）与 describe
 *   `.`  版本号、email 域名
 *   `-`  describe（`v0.1.601-59-g454cf79c`）、slug 后的分支名
 *   `_`  分支名 / builder
 *   `@`  builder（email 或 `user@host`）⚠️ 实测漏了它会静默截断，见文件头约束 2
 *   `:`  预留（时间戳里的 `:`，虽然 built_at 用的是 ISO8601 含 `:`）
 *   `+`  email 的 plus-addressing
 *   `=`  `k=v` 分隔
 *   `|`  字段分隔
 *
 * ⚠️ **刻意不含 `]`**（早期草稿里写成 POSIX 惯用的 `[][A-Za-z...]`，
 * 那在 grep 里表示"`]` 是字面量"，但在 **JS 正则里 `[]` 是空字符类、永不匹配** ——
 * 实测同一个字符串喂给 `new RegExp` 时整条嗅探恒返 null）。
 * 没有任何字段值会含 `]`（构建期 slug 化已把它换成 `-`），所以直接不收它 ——
 * 这样**同一个字符串在 grep 与 JS 正则里语义一致**，
 * 而两通道读同一份字节必须给出相同结果正是本设计的一条约束。
 */
export const BUILD_INFO_VALUE_CLASS = "[A-Za-z0-9=|:._@+/-]";

/**
 * 通道 B（字节嗅探）用的 grep 基本正则。`|` 在基本正则里是字面量，正是这里要的。
 *
 * ⚠️ **必须锚在 `commit=` 上，不能只锚前缀**。这是实测踩出来的：
 * `BUILD_INFO_PREFIX` 这个常量**本身**也是二进制里的一个字符串（模块把它导出了），
 * 于是产物里至少有两处命中前缀 —— 一处是真身份行，一处是那个裸常量。
 * 两者的先后顺序**是运气**：实测真产物里真值在前（偏移 62744914 < 62747618）
 * 所以 `-m1` 侥幸对了，但同一份代码编的一个小 fixture 里裸常量排在前面，
 * `-m1` 取到的就是**一个只有前缀、后面什么都没有的空壳**，
 * 解析出来 `commit=unknown` —— 门禁于是把一个身份完好的产物判成"没有身份"，
 * 然后一路退化到 mtime 兜底，而且不报错。
 *
 * 锚 `commit=` 之后就与顺序无关了：裸常量后面不跟 `commit=`，不会被匹配。
 * 这也是「commit 必须是第一个字段」那条约束的第二个用途。
 */
export const BUILD_INFO_GREP_PATTERN = `${BUILD_INFO_PREFIX}commit=${BUILD_INFO_VALUE_CLASS}*`;

/** 通道 A / 测试里用的 JS 正则，与 {@link BUILD_INFO_GREP_PATTERN} 同源同锚点。 */
export const BUILD_INFO_SNIFF_REGEX = new RegExp(
  `${BUILD_INFO_PREFIX.replace("|", "\\|")}commit=${BUILD_INFO_VALUE_CLASS}*`,
);

/** 构建来源三档。`source` 与 `local` 必须分开：源码直跑是开发常态，不该被门禁拦。 */
export type BuildOrigin = "local" | "ci" | "release" | "source" | "unknown";

/** `dirty` 是三态而非布尔：读不到时是 `unknown`，不能当成 `false`。 */
export type BuildDirty = true | false | "unknown";

export interface BuildInfo {
  /** 格式版本。真值为 {@link BUILD_INFO_SCHEMA}；无身份时为 0。 */
  schema: number;
  /** 40 位全长 commit，或 `"unknown"`。**判据的唯一输入**（不用 short：12 位有碰撞风险且拼不回全长）。 */
  commit: string;
  branch: string;
  /** `git describe --tags --always --dirty` 的结果。**只作展示，判据一律用 commit** —— 它是派生值，且 CI 的 shallow clone 会让它静默退化成裸 hash。 */
  describe: string;
  /** 构建时工作区是否脏。脏 → commit 不能完整描述产物，消费方必须点破。 */
  dirty: BuildDirty;
  /** UTC ISO8601。⚠️ 只作展示，**不作判据**（`cp` 会重置 mtime，时间戳同理不可信）。 */
  built_at: string;
  builder: string;
  origin: BuildOrigin;
  /**
   * 脏文件清单（逗号分隔，构建期截断）。只有 `origin=release` 会写。
   *
   * 存在的唯一理由：`release.sh` 的真实顺序是「洁净门禁 → bump（**工作区变脏**）→ 构建」，
   * 所以发布产物的 `dirty` **必然是 true**，脏的文件恰好只有 `package.json`。
   * 光有布尔位判不了这件事 —— 发布通道门禁要断言"脏的只有 package.json"，
   * 否则只能退化成「不检查 dirty」，那就漏掉了「真的带着未提交代码发版」这个形态。
   */
  dirty_files?: string;
  /** 身份是否真的读到了。`none` = 产物不含身份（老产物或漏带 define）。 */
  identity_source: "embedded" | "none";
}

/**
 * 无身份时的字面量。
 *
 * ⚠️ 必须像这样**存进一个独立的 const**（而不是写成
 * `process.env.X ?? "字面量"`）—— 后者会被 bun 的 DCE 折叠掉，
 * 于是 `tests/build/build-info-define.test.ts` 的变异自证就测不到东西了
 * （测试本身要能自证它在测东西）。见文件头约束 1。
 */
const RAW_DEFAULT = `${BUILD_INFO_NONE_PREFIX}commit=unknown|branch=unknown|describe=unknown|dirty=unknown|built_at=unknown|builder=unknown|origin=source`;

/**
 * 取原始身份行。
 *
 * `process.env.SID_CODE_BUILD_INFO` 在编译产物里是**编译期字面量**（`bun build --define`），
 * 不是运行时读 env —— 实测 `SID_CODE_BUILD_INFO=hacked ./sid-code --build-info`
 * 仍输出编译期值。正因如此这个字段可以当身份用。
 *
 * 源码直跑（`bun run packages/cli/src/cli.ts`）时没有 define，此时**允许**从真实 env 取
 * （方便本地调试与测试注入），取不到就走 {@link RAW_DEFAULT}。
 */
export function getRawBuildInfoLine(): string {
  let raw = process.env.SID_CODE_BUILD_INFO;
  if (!raw) raw = RAW_DEFAULT;
  return raw;
}

/**
 * 解析一行身份。
 *
 * 刻意宽松：未知的 key 直接忽略（格式演进时老代码读新产物不该崩），
 * 缺失的 key 落到 `unknown`（**不是**编一个看起来正常的值 —— 那正是本方案要消灭的东西）。
 */
export function parseBuildInfoLine(line: string): BuildInfo {
  const embedded = line.startsWith(BUILD_INFO_PREFIX);
  const body = embedded
    ? line.slice(BUILD_INFO_PREFIX.length)
    : line.startsWith(BUILD_INFO_NONE_PREFIX)
      ? line.slice(BUILD_INFO_NONE_PREFIX.length)
      : "";

  const kv = new Map<string, string>();
  for (const part of body.split("|")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    kv.set(part.slice(0, eq), part.slice(eq + 1));
  }

  const get = (k: string): string => kv.get(k) || "unknown";
  const rawDirty = get("dirty");
  const dirty: BuildDirty = rawDirty === "true" ? true : rawDirty === "false" ? false : "unknown";
  const rawOrigin = get("origin");
  const origin: BuildOrigin =
    rawOrigin === "local" || rawOrigin === "ci" || rawOrigin === "release" || rawOrigin === "source"
      ? rawOrigin
      : "unknown";

  const info: BuildInfo = {
    schema: embedded ? BUILD_INFO_SCHEMA : 0,
    commit: get("commit"),
    branch: get("branch"),
    describe: get("describe"),
    dirty,
    built_at: get("built_at"),
    builder: get("builder"),
    origin,
    identity_source: embedded ? "embedded" : "none",
  };
  const dirtyFiles = kv.get("dirty_files");
  if (dirtyFiles) info.dirty_files = dirtyFiles;
  return info;
}

/** 当前二进制的构建身份。 */
export function getBuildInfo(): BuildInfo {
  return parseBuildInfoLine(getRawBuildInfoLine());
}

/** commit 是否是一个可用作判据的 40 位 hex（门禁必须先过这一关再拿它拼 git 命令）。 */
export function isUsableCommit(commit: string): boolean {
  return /^[0-9a-f]{40}$/.test(commit);
}

/**
 * 人读格式。
 *
 * ⚠️ 这里输出 `version` 而编进字节的那一行**不含** version，这不是矛盾而是两个层次：
 * 字节里不记（避免制造两个可能不一致的源），展示时把 `getRawVersion()` 拼上来方便人一次看全。
 * **门禁一律不读这个 version 字段。**
 */
export function formatBuildInfoText(info: BuildInfo, version: string): string {
  const lines = [
    `commit    ${info.commit}`,
    `branch    ${info.branch}`,
    `describe  ${info.describe}`,
    `dirty     ${info.dirty}`,
    `built_at  ${info.built_at}`,
    `builder   ${info.builder}`,
    `origin    ${info.origin}`,
  ];
  if (info.dirty_files) lines.push(`dirty_files ${info.dirty_files}`);
  lines.push(`version   ${version}`);
  if (info.identity_source === "none") {
    lines.push("");
    lines.push(
      "⚠️ 该产物不含构建身份（老产物，或构建时漏带 --define process.env.SID_CODE_BUILD_INFO）。",
    );
    lines.push("   这不是「没变化」而是「没量到」—— 任何基于它的新旧判断都不成立。");
  }
  return lines.join("\n");
}

/** 机器读格式，给门禁 / run-meta 用。`version` 同上是运行时补充字段而非身份字段。 */
export function formatBuildInfoJson(info: BuildInfo, version: string): string {
  return JSON.stringify({ ...info, version });
}
