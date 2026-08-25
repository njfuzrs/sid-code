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

import { appendFileSync, readFileSync, existsSync } from "node:fs";
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

const record: RunRecord = {
  instance_id: instanceId,
  patch_bytes: patchBytes,
  patch_touches_tests: testFiles.length > 0,
  test_files_touched: testFiles,
  wall_ms: wallMs,
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

appendFileSync(join(runDir, "records.jsonl"), JSON.stringify(record) + "\n");
appendFileSync(join(runDir, "predictions.jsonl"), JSON.stringify(prediction) + "\n");

const flag = record.patch_touches_tests ? " ⚠️ 触及测试文件" : "";
console.log(
  `  ${instanceId}: ${outcome}  patch=${patchBytes}B  wall=${wallMs}ms${flag}` +
    (record.unaccounted ? `\n    unaccounted: ${record.unaccounted}` : ""),
);
