/**
 * 编译产物自检（方向 0：二进制编译自检护栏）
 *
 * 背景（根因分析-commit任务git状态快照冻结死循环.md 第 2 环）：
 * `bun build --compile` 在**编译时**把源码内联进二进制。git pull / commit 更新了源码后，
 * 磁盘上的二进制不会跟着变——若忘了 `make build`，跑的还是旧逻辑。那次 git-status
 * 快照冻结死循环的**直接触发因素**，正是"源码已含方向 1 修复（3a63743），但运行的二进制
 * 编译自更早提交"，导致 system prompt 里注入的还是无锚点的旧格式快照。
 *
 * 本模块让**二进制自己**跑一遍关键代码路径并断言修复已内联。`make build` / `build-bump`
 * 末尾调用 `<binary> --self-check`：编译出的产物一旦缺失关键修复就当场以非零码失败，
 * 把"源码有修复但二进制没重编"这个隐形发布陷阱变成显式的、构建期就暴露的硬错误。
 *
 * 设计原则：只校验**高价值、易因漏重编而回归**的不变量，逐条独立报告，避免变成
 * 什么都塞的"全量健康检查"。当前覆盖：
 *   1. git-status 仲裁锚点（方向 1）：generateGitStatusAttachment 输出必须含"启动快照"锚点句。
 *   2. 无进展止损阀（方向 2/4/6）：repeated-readonly-guard 的探查命令识别与卡住判定生效。
 */

import { chmodSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 单条自检结果。 */
interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * git-status 快照必须包含的启动锚点文案（与 attachments.ts / 哨兵单测同源）。
 *
 * ★根治「git 快照冻结死循环」后(2026-07-23)第三条锚点已从"以实时为准"措辞升级为
 * "移除 volatile Status 块 + 引导实时获取"。锚点不再是"叫模型别信快照里的净/脏状态"
 * (那是治标),而是"快照里根本没有净/脏状态,唯一来源是实时 git status"(治本)。
 */
const GIT_STATUS_ANCHOR_MARKERS = [
  "snapshot in time",
  "will not update during the conversation",
  "未包含在此快照中",
];

/**
 * 校验 1：git-status 快照锚点已内联，且 volatile Status 块已被移除（防死锁根治）。
 *
 * 直接调用编译进二进制的 generateGitStatusAttachment，检查输出：
 *   - 含启动锚点句(声明这是快照、不会更新、文件状态需实时获取);
 *   - **不含** `Status:` 文件状态列表(唯一会过期、唯一制造净/脏矛盾的 volatile 块)。
 * 非 git 仓库时返回 null——此时跳过（视为通过），因为无法构造输出，且构建机通常在 git 仓库内。
 */
async function checkGitStatusAnchor(): Promise<CheckResult> {
  const name = "git-status 快照锚点";
  try {
    const { generateGitStatusAttachment } = await import("@sid-code/core/config/attachments.ts");
    const att = generateGitStatusAttachment(process.cwd());
    if (!att) {
      return { name, ok: true, detail: "跳过（当前目录非 git 仓库，无法构造输出）" };
    }
    const missing = GIT_STATUS_ANCHOR_MARKERS.filter((m) => !att.content.includes(m));
    if (missing.length > 0) {
      return {
        name,
        ok: false,
        detail:
          `git-status 块缺少锚点文案：${missing.map((m) => `"${m}"`).join("、")}。` +
          `这几乎可以断定二进制编译自修复之前——请重新 make build。`,
      };
    }
    // ★关键回归护栏：volatile `Status:` 块必须已被物理移除。
    if (att.content.includes("Status:")) {
      return {
        name,
        ok: false,
        detail:
          `git-status 块仍含会过期的 "Status:" 文件状态列表——这是死循环矛盾源，` +
          `必须移除(只留 branch/commits)。若二进制含此块，说明编译自修复之前，请重新 make build。`,
      };
    }
    return { name, ok: true, detail: "锚点齐全且 volatile Status 块已移除" };
  } catch (e: any) {
    return { name, ok: false, detail: `执行异常：${e?.message ?? String(e)}` };
  }
}

/**
 * 校验 2：无进展只读命令止损阀已内联且逻辑生效。
 *
 * 用一组确定性输入驱动 repeated-readonly-guard 的纯函数，断言：
 *   - git status 被识别为只读探查命令；
 *   - 连续相同 (命令,输出) 达阈值后判定 stuck 并给出 remind 动作。
 */
async function checkStuckGuard(): Promise<CheckResult> {
  const name = "无进展止损阀";
  try {
    const {
      isReadonlyProbeCommand,
      processObservation,
      createRepeatedReadonlyState,
      STUCK_REPEAT_THRESHOLD,
    } = await import("@sid-code/core/query/repeated-readonly-guard.ts");

    if (!isReadonlyProbeCommand("git status --short")) {
      return { name, ok: false, detail: "git status 未被识别为只读探查命令" };
    }

    const state = createRepeatedReadonlyState();
    let lastAction = "none";
    // 连续投喂 STUCK_REPEAT_THRESHOLD 次完全相同的空返回 git status。
    for (let i = 0; i < STUCK_REPEAT_THRESHOLD; i++) {
      const d = processObservation(state, [{ command: "git status --short", output: "" }], false);
      lastAction = d.action;
    }
    if (lastAction !== "remind") {
      return {
        name,
        ok: false,
        detail: `连续 ${STUCK_REPEAT_THRESHOLD} 次相同空跑后未触发 remind（实际 action=${lastAction}）`,
      };
    }
    return { name, ok: true, detail: "探查命令识别 + 卡住判定生效" };
  } catch (e: any) {
    return { name, ok: false, detail: `执行异常：${e?.message ?? String(e)}` };
  }
}

/**
 * 校验 3：内置 skill 已嵌入二进制。
 *
 * 背景：`embed-builtin-skills.ts` 把 src/skill/builtin/ 下的文件生成成
 * builtin-embedded.generated.ts 再随 --compile 打进产物。这个生成物是入库文件，
 * 于是有一类静默失败：skill 源文件改了/新增了，但忘了跑生成脚本（或生成脚本
 * 产出了空清单），二进制里就是旧快照甚至空清单——运行时表现为「内置 skill 消失」，
 * 而在此之前的自检一路绿灯。
 *
 * 这里刻意**不写死 skill 数量**（写死的话每加一个 skill 都要改断言，改的手会顺手
 * 把数字改对，断言退化成摆设）。只断言三件与数量无关的不变量：
 *   - 清单非空（挡住"生成了个空数组"）；
 *   - 哈希非空（ensure-builtin.ts 靠它判断是否需要重新释放，空哈希会让释放逻辑失准）；
 *   - 每个条目都有 name 且至少含一个文件（挡住"结构在但内容空"）。
 */
async function checkEmbeddedSkills(): Promise<CheckResult> {
  const name = "内置 skill 已嵌入";
  try {
    const { EMBEDDED_BUILTIN_SKILLS, EMBEDDED_BUILTIN_SKILLS_HASH } = await import(
      "@sid-code/core/skill/builtin-embedded.generated.ts"
    );

    if (!Array.isArray(EMBEDDED_BUILTIN_SKILLS) || EMBEDDED_BUILTIN_SKILLS.length === 0) {
      return {
        name,
        ok: false,
        detail: "嵌入的内置 skill 清单为空——几乎可以断定漏跑 embed-builtin-skills.ts，请重新 make build。",
      };
    }
    if (!EMBEDDED_BUILTIN_SKILLS_HASH) {
      return {
        name,
        ok: false,
        detail: "EMBEDDED_BUILTIN_SKILLS_HASH 为空，运行时释放判断会失准（见 ensure-builtin.ts）。",
      };
    }
    const broken = EMBEDDED_BUILTIN_SKILLS.filter(
      (s: any) => !s?.name || !Array.isArray(s?.files) || s.files.length === 0,
    );
    if (broken.length > 0) {
      const names = broken.map((s: any) => s?.name ?? "(无名)").join("、");
      return { name, ok: false, detail: `以下 skill 结构异常（无名或无文件）：${names}` };
    }
    return {
      name,
      ok: true,
      detail: `${EMBEDDED_BUILTIN_SKILLS.length} 个 skill 已内联（hash=${String(EMBEDDED_BUILTIN_SKILLS_HASH).slice(0, 8)}）`,
    };
  } catch (e: any) {
    return { name, ok: false, detail: `执行异常：${e?.message ?? String(e)}` };
  }
}

/**
 * 校验 4：内嵌 ripgrep 是**当前平台可执行**的二进制。
 *
 * 背景：`vendor/rg-embed` 是 bun --compile 的固定嵌入路径，属于跨命令共享的可变状态。
 * release.sh 的 4 平台循环会把它依次覆盖成各平台二进制，跑完残留最后一个 target
 * （linux-arm64）；此后若 `make build` 里的 `fetch-ripgrep.ts --as-embed` 失败
 * （Makefile 那行有前导 `-`，失败被忽略），0 字节兜底又只在文件**不存在**时触发，
 * 于是会把一个 Linux rg 嵌进 mac 产物。运行时不报错，只是静默降级回系统 rg
 * （见 ripgrep.ts 的 probeRg），因此非常难发现——正好是自检该管的事。
 *
 * 判定分三态而非二态：
 *   - 0 字节 = 设计内的「本次不含内嵌 rg」降级，**视为通过**并说明清楚（best-effort 语义）；
 *   - 非空且能跑通 `--version` = 通过；
 *   - 非空但跑不通 = 失败（这就是错平台/损坏的特征）。
 *
 * dev 模式（bun run src）下 ensure-ripgrep 的守卫根本不会加载嵌入模块，
 * 此时跳过（视为通过），避免 dev 环境误报。
 */
async function checkEmbeddedRipgrep(): Promise<CheckResult> {
  const name = "内嵌 ripgrep 平台匹配";
  try {
    const { IS_DEV_MODE } = await import("@sid-code/core/bootstrap/resolve-executable.ts");
    if (IS_DEV_MODE) {
      return { name, ok: true, detail: "dev 模式跳过（不加载嵌入 rg，运行时用系统 rg）" };
    }

    const { rgEmbeddedPath } = await import("@sid-code/core/tool/rg-embedded.ts");
    const bytes = await Bun.file(rgEmbeddedPath).arrayBuffer();
    if (bytes.byteLength === 0) {
      return {
        name,
        ok: true,
        detail: "0 字节占位（本次产物不含内嵌 rg，运行时回退系统 rg——设计内降级）",
      };
    }

    // 释放到临时文件再探测：嵌入路径是 /$bunfs/ 虚拟路径，不能直接 spawn。
    const tmp = join(
      tmpdir(),
      `sid-code-selfcheck-rg-${process.pid}-${bytes.byteLength.toString(36)}`,
    );
    try {
      await Bun.write(tmp, bytes);
      chmodSync(tmp, 0o755);

      // 错平台二进制在 macOS 上是 spawn **抛异常**（ENOEXEC），不是返回 success:false，
      // 所以这里必须 try 包住——否则会被外层 catch 兜成"执行异常：ENOEXEC ... /tmp/xxx"，
      // 泄漏一个无意义的临时路径而不是说出真正的病因。
      let spawned: { success: boolean; stdout: Uint8Array } | null = null;
      let spawnErr = "";
      try {
        const proc = Bun.spawnSync([tmp, "--version"], { stdout: "pipe", stderr: "pipe" });
        spawned = { success: proc.success, stdout: proc.stdout };
      } catch (e: any) {
        spawnErr = e?.code ?? e?.message ?? String(e);
      }

      if (!spawned?.success) {
        return {
          name,
          ok: false,
          detail:
            `内嵌 rg 有 ${bytes.byteLength} 字节但无法在本机（${process.platform}/${process.arch}）执行` +
            `${spawnErr ? `（${spawnErr}）` : ""} —— 几乎可以断定嵌入了**错误平台**的二进制：` +
            `release.sh 的 4 平台循环会把 vendor/rg-embed 覆盖成最后一个 target（linux-arm64）。` +
            `请重新 make build，让 fetch-ripgrep.ts --as-embed 落成本机平台。`,
        };
      }
      const ver = new TextDecoder().decode(spawned.stdout).split("\n")[0]?.trim() ?? "";
      return { name, ok: true, detail: `本机可执行（${ver || "版本未知"}）` };
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // 清理失败无所谓（临时目录），不能因此让自检失败
      }
    }
  } catch (e: any) {
    return { name, ok: false, detail: `执行异常：${e?.message ?? String(e)}` };
  }
}

/**
 * 运行全部自检。返回 true=全部通过，false=至少一条失败。
 *
 * 输出渠道与配色：
 *   - 全部通过 → stdout + 绿色 ✓。成功就是成功，不能伪装成错误。
 *   - 有失败   → stderr + 红色 ✗。失败才该红，CI 日志也走 stderr 抓取。
 *   - 非 TTY（管道/重定向/部分 CI）→ 不输出 ANSI 转义码，避免日志里 `[0m[31m` 乱码。
 */
export async function runSelfCheck(): Promise<boolean> {
  const results = await Promise.all([
    checkGitStatusAnchor(),
    checkStuckGuard(),
    checkEmbeddedSkills(),
    checkEmbeddedRipgrep(),
  ]);
  const allOk = results.every((r) => r.ok);

  // TTY 检测：成功走 stdout、失败走 stderr，各自看对应流是否 TTY。
  // 非 TTY（管道/重定向/部分 CI）→ 颜色与 reset 都置空，避免日志里残留 `[0m` 乱码。
  const useColorOk = process.stdout.isTTY === true;
  const useColorFail = process.stderr.isTTY === true;
  const green = useColorOk ? "\x1b[32m" : "";
  const greenReset = useColorOk ? "\x1b[0m" : "";
  const red = useColorFail ? "\x1b[31m" : "";
  const redReset = useColorFail ? "\x1b[0m" : "";

  if (allOk) {
    console.log(`${green}── sid-code 编译产物自检 ──${greenReset}`);
    for (const r of results) {
      console.log(`${green}  ✓${greenReset} ${r.name}：${r.detail}`);
    }
    console.log(`${green}自检通过：关键修复已内联进二进制。${greenReset}`);
  } else {
    console.error(`${red}── sid-code 编译产物自检 ──${redReset}`);
    for (const r of results) {
      const mark = r.ok ? "✓" : "✗";
      const color = r.ok ? "" : red;
      const colorReset = r.ok ? "" : redReset;
      console.error(`  ${color}${mark}${colorReset} ${r.name}：${r.detail}`);
    }
    console.error(`${red}自检失败：二进制缺失关键修复。若刚改过相关源码，请重新 \`make build\`。${redReset}`);
  }
  return allOk;
}
