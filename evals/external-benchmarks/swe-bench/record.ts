#!/usr/bin/env bun
/**
 * SWE-bench 阶段 A —— 单实例结果落盘（§4.5 第 6 步的判定部分）
 *
 * 被 `exec-swebench.sh` 每条实例调一次。职责是把容器里那段 raw 输出
 * 变成两个产物：predictions.jsonl 的一行 + records.jsonl 的一行。
 *
 * ## 为什么判定放在 TS 而搬运放在 shell
 *
 * 「哪些路径算测试文件」「二进制文件怎么剔」「agent 失败与没有 patch 怎么区分」
 * 这三件事都是**判断**，判断要有单测（`tests/eval/swe-bench-runner.test.ts`）。
 * 而 `docker cp` / `docker exec` 是搬运，包进 TS 只会让出错时多一层壳要剥。
 *
 * ## 用法（由 exec-swebench.sh 调用，一般不手敲）
 *
 *   bun run record.ts --instance <id> --run-dir <dir> \
 *     --agent-exit N --timed-out 0|1 --wall-ms N
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  isTestPath,
  parseNumstatZ,
  splitExtractOutput,
  deriveOutcome,
  MODEL_NAME,
  type RunRecord,
  type Prediction,
  normalizePatch,
  patchOnlyAddsFiles,
  extractAgentLogSignals,
} from "./runner.ts";

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const argv = process.argv.slice(2);
const instanceId = arg("instance", argv);
const runDir = arg("run-dir", argv);
const agentExit = Number(arg("agent-exit", argv) ?? -1);
const timedOut = arg("timed-out", argv) === "1";
const wallMs = Number(arg("wall-ms", argv) ?? 0);
// ## 三段耗时：wall_ms 一个数回答不了「慢在哪」
//
// `wall_ms` 的边界是 docker run 前 → 收尾 rm 后，也就是说它把
// **起容器 + cp 40MB 产物 + 取回轨迹**全算进了「这道题花的时间」。
// smoke-8 报了 94.2 分钟，而其中多少是搬运、多少是模型在想，一个字看不出来。
//
//   setup_ms    docker run + tar 解压 + cp 产物/题面（基础设施，与模型无关）
//   agent_ms    docker exec 跑 sid-code（真正的能力 + 延迟账）
//   extract_ms  git add/diff 提取 patch + 取回轨迹与遥测（收尾搬运）
//
// ⚠️ 缺省 0 而不是 `wallMs`：旧 run 没有这三个字段，用 wallMs 顶替会
// **凭空造出一份"全是 agent 时间"的分解**，比没有分解更坏。
// 0 表示"没量"，grade.ts 侧据此跳过分解不做假汇总。
const setupMs = Number(arg("setup-ms", argv) ?? 0);
const agentMs = Number(arg("agent-ms", argv) ?? 0);
const extractMs = Number(arg("extract-ms", argv) ?? 0);
// ## host_slept_ms：`agent_ms` 里有多少是宿主在睡觉
//
// 实测踩到（2026-08-26 smoke-10）：`django-13964` 的 `agent_ms=2009007`（33.5min）
// **超过 SWE_TIMEOUT=1800 而 timed_out=false** —— 看起来像超时闸门坏了，
// 真凶是宿主中途睡了 717 秒（`pmset -g log`）。`alarm()` 按可运行时间计、
// `now_ms()` 取墙钟，于是休眠同时**污染 agent_ms** 并**静默给闸门续命**。
// 详见 exec-swebench.sh 里 awake_ms 上方那段。
//
// ⚠️ **`null` 与 `0` 语义必须分开**，这是这个字段唯一容易做错的地方：
//   null = **没量到**（旧 run、或宿主两个时钟都取不到）→ 耗时可信度未知
//   0    = **量到了、确实没睡** → 耗时干净，可以外比
// 缺省成 0 会把所有旧 run 伪装成"已验证没休眠"，正是这个缺陷第一次逃过验收的形态
// （同 setup/agent/extract 三段那条「缺省 0 而不是 wallMs」的理由，方向相反：
// 那里 0 表示"没量"，这里 0 是个**有效值**，所以"没量"只能用 null 表示）。
const hostSleptRaw = arg("host-slept-ms", argv);
const hostSleptMs = hostSleptRaw === undefined || hostSleptRaw === "" ? null : Number(hostSleptRaw);

if (!instanceId || !runDir) {
  console.error("需要 --instance 与 --run-dir");
  process.exit(2);
}

const rawPath = join(runDir, `${instanceId}.extract.raw`);
const raw = existsSync(rawPath) ? readFileSync(rawPath, "utf8") : "";
const { numstat, diff } = splitExtractOutput(raw);

const files = parseNumstatZ(numstat);
// 二进制文件不进 patch —— 官方 harness 用 `git apply` 打补丁，
// 二进制 diff 需要 `--binary`，而那种 patch 在 predictions jsonl 里
// 传输/转义都不可靠。剔掉并在 unaccounted 里记一笔，不静默丢。
const binaries = files.filter((f) => f.binary).map((f) => f.path);
const textFiles = files.filter((f) => !f.binary).map((f) => f.path);
const testFiles = textFiles.filter(isTestPath);

// patch 末尾必须恰好一个换行，否则容器里的 GNU patch 拒收整份补丁。
// 完整理由（含变异自证与「本机 BSD patch 测不出来」）见 runner.ts 的 normalizePatch。
const patch = normalizePatch(diff);
const patchBytes = patch.length;
const outcome = deriveOutcome({ agentExit, patchBytes, timedOut });

const notes: string[] = [];
if (binaries.length) notes.push(`剔除二进制文件 ${binaries.length} 个：${binaries.join(", ")}`);
if (timedOut) notes.push(`容器级超时（agent_exit=124）`);
if (agentExit !== 0 && !timedOut) notes.push(`agent 非 0 退出：${agentExit}`);
// ⚠️ numstat 说有改动但 diff 是空的 → 账没算平，必须记下来。
// 静默取信任一侧就会得到一个「看起来正常」的结果。
if (files.length > 0 && patchBytes === 0) {
  notes.push(`numstat 报 ${files.length} 个文件有改动但 diff 为空 —— 提取链路可能出了问题`);
}
// 「只新建文件、一行既有源码都没改」= agent 大概率卡在复现阶段。
// 这个形态在 patch_bytes / outcome 上完全看不出来（实测 smoke-2 两条 3412B / 967B
// 全是 agent 自建的 repro 脚本）。**只标注、不改判定、不过滤** —— 理由见
// runner.ts 的 patchOnlyAddsFiles（提取时滤掉等于替 agent 打扫，掩盖行为特征）。
const onlyAdds = patchBytes > 0 && patchOnlyAddsFiles(patch, textFiles);
if (onlyAdds) {
  notes.push(
    `patch 只新建文件、未修改任何既有源码（${textFiles.length} 个新文件：${textFiles.join(", ")}）` +
      ` —— 大概率卡在复现阶段而非做出修复。**这不影响判分**，判分仍由官方 harness 做`,
  );
}

// ── ZZZZ.11 P2：把 no_patch 桶里的「非能力原因」标出来 ──
//
// agent.log 由 exec-swebench.sh 在调本脚本**之前**落盘（同一个 run 目录），
// 所以这里读得到。读不到就当全 false —— 不猜、不报错：
// 轨迹/日志缺失本身会在下面的 unaccounted 里点破，
// 而让一条本来有效的记录因为"日志没找到"变成失败，方向是反的。
const agentLogPath = join(runDir, `${instanceId}.agent.log`);
const agentLog = existsSync(agentLogPath) ? readFileSync(agentLogPath, "utf8") : "";
const signals = extractAgentLogSignals(agentLog);
if (!agentLog) {
  notes.push(`agent.log 不存在（${agentLogPath}）—— hit_max_turns / llm_fatal 无法归因`);
}
// ⚠️ 这条必须放在 hitMaxTurns 那条**之前**：两者会同时成立
// （django-13964 就是既撞顶又只改了复现脚本），而此时"编辑全打在仓库外"
// 是更精确的归因 —— 它把人从「抬 max_turns」引向「它没留下动手的轮次」。
// 顺序决定读报告的人先看到哪一条，所以顺序本身是判据的一部分。
if (patchBytes === 0 && signals.editsOutsideRepo > 0 && signals.editsInsideRepo === 0) {
  notes.push(
    `零 patch 但**编辑了 ${signals.editsOutsideRepo} 次、全在仓库外**` +
      `（${signals.editPathsOutsideRepo.join(", ")}）—— 它在改自己的复现脚本，` +
      `一次没碰被测源码。**这不是"没动手"，也不只是预算不够**：` +
      `实测（A7.11.4）此形态下模型已完整定位到根因、连修法都写出来了，` +
      `但把预算全花在验证与探索上。⚠️ 判据提示：「edit 调用数 > 0」看不出这个，` +
      `要看 patch_bytes 或 edits_inside_repo`,
  );
}
if (patchBytes === 0 && signals.hitMaxTurns) {
  notes.push(`零 patch 且**轮次预算用尽**（达到 max-turns）—— 这不是"想不出来"，是预算不够`);
}
if (patchBytes === 0 && signals.llmFatal) {
  notes.push(
    `零 patch 且被 **LLM 致命错误**打断（限流/5xx）—— 这条题连"跑完"的机会都没拿到，` +
      `不该计入能力账`,
  );
}
// 权限拒绝：不限于零 patch —— 有 patch 的实例被拒同样意味着它是"带着镣铐做完的"。
if (signals.permissionDenials > 0) {
  notes.push(
    `被权限层拒绝 ${signals.permissionDenials} 次工具调用 —— 每次都烧掉一轮而未做成任何事。` +
      `若这个数显著大于 0，本轮分数掺了非能力因素（查 --permission-mode 配置）`,
  );
}
// 零 patch 但两个信号都没命中 → **才有可能**是能力问题。显式说出来，
// 免得"没有归因"被默读成"已确认是能力不足"。
if (patchBytes === 0 && !signals.hitMaxTurns && !signals.llmFatal && agentLog) {
  notes.push(
    `零 patch 且未命中轮次用尽/LLM 致命错误两个信号 —— 原因未归因，` +
      `需人工读 agent.log 与轨迹确认是否为能力问题`,
  );
}

const record: RunRecord = {
  instance_id: instanceId,
  patch_bytes: patchBytes,
  patch_touches_tests: testFiles.length > 0,
  test_files_touched: testFiles,
  patch_only_adds_files: onlyAdds,
  hit_max_turns: signals.hitMaxTurns,
  llm_fatal: signals.llmFatal,
  permission_denials: signals.permissionDenials,
  edits_inside_repo: signals.editsInsideRepo,
  edits_outside_repo: signals.editsOutsideRepo,
  edit_paths_outside_repo: signals.editPathsOutsideRepo,
  wall_ms: wallMs,
  setup_ms: setupMs,
  agent_ms: agentMs,
  extract_ms: extractMs,
  host_slept_ms: hostSleptMs,
  agent_exit: agentExit,
  outcome,
  meter: null,
  meter_note: "无中立计价源；成本数字为 agent 自报，未交叉校验",
  prompt_version: "prompt-v1",
  ...(notes.length ? { unaccounted: notes.join(" | ") } : {}),
};

const prediction: Prediction = {
  instance_id: instanceId,
  model_name_or_path: MODEL_NAME,
  model_patch: patch,
};

// ## 并发安全：先写**每题各自的文件**，最后由 shell 侧合并
//
// 原先两行都是 `appendFileSync` 直接追加到共享的 jsonl。串行下没问题，
// 但 `SWE_JOBS>1` 时多个 record.ts 进程同时 append —— 而 `model_patch`
// 动辄几 KB，**超过 PIPE_BUF 的写入不保证原子**，两条记录会交错成
// 一行合法 JSON 都不是的东西。
//
// 失败形态最坑的地方：`predictions.jsonl` 被官方 harness 读，
// 它对坏行的反应是**跳过或整体报错**，于是一个跑完了的实例
// 看起来像"没提交" → 被记成 no_patch。**并发把有效数据变成了能力问题。**
//
// 每题一个文件则天然无竞争（文件名互不相同），合并在 `run_one` 全部结束后
// 单线程做，顺序按 subset 顺序而不是完成顺序 —— 顺带让两次 run 的
// jsonl 可以直接 diff（并发下完成顺序是随机的，append 版本 diff 不了）。
const perInstDir = join(runDir, ".parts");
mkdirSync(perInstDir, { recursive: true });
// 文件名用 instance_id：它在一轮里唯一，且含 `__` 不含路径分隔符。
writeFileSync(join(perInstDir, `${instanceId}.record.json`), JSON.stringify(record) + "\n");
writeFileSync(join(perInstDir, `${instanceId}.prediction.json`), JSON.stringify(prediction) + "\n");

const flag = record.patch_touches_tests ? " ⚠️ 触及测试文件" : "";
// 两个机械信号进终端行：跑的时候就能看出「这条是没跑完，不是没做出来」，
// 不必等报告。permission_denials 只在 >0 时显示 —— 正常配置下它该是 0，
// 恒显示一个 0 会让它变成噪声、真出问题时反而被忽略。
const sig =
  (signals.hitMaxTurns ? " [轮次用尽]" : "") +
  (signals.llmFatal ? " [LLM致命错误]" : "") +
  (signals.permissionDenials > 0 ? ` [权限拒绝×${signals.permissionDenials}]` : "");
console.log(
  `  ${instanceId}: ${outcome}  patch=${patchBytes}B  wall=${wallMs}ms${flag}${sig}` +
    (record.unaccounted ? `\n    unaccounted: ${record.unaccounted}` : ""),
);
