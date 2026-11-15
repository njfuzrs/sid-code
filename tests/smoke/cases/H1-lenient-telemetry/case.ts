/**
 * H1 工具宽进可观测：edit 归一化命中 + 参数归一两层的端到端落盘。
 *
 * 为什么要这个用例（2026-11-15 实测）：这两条事件在真实使用中一个 4 天窗口内
 * `EditLenientMatch{strategy=normalized}` 与 `ToolInputCoerced` 都是 0 条 ——
 * 「等真实样本」可能永远等不到（模型早就不这么传了），所以用回放**造**出来。
 * 由此把两件事分开：**管道端到端能落盘**由本用例守，**真实触发率**继续看轨迹。
 *
 * 场景一（edit）：`doc.md` 里是弯引号，模型用直引号 old_string → 归一化命中。
 * 事件必须报 `strategy=normalized`（不能伪装成 exact，否则统计不出这条路），
 * 且 `file_ext` 标明是哪类文件。第 1 步的精确读不产生该事件（count 恰为 1）。
 *
 * 场景二（read）：`offset` 传字符串 `"1"`（numeric 层转数字）、`limit` 传 `null`
 * （nullish 层摘掉）→ 同一次调用发两条 `ToolInputCoerced`，layer 与 field 各自可辨。
 * 值不进事件：只断言 layer/field/tool，不碰参数值。
 *
 * 不锁文件内容：T2（保留原引号风格）未开工，现在写回的是模型给的直引号；
 * 等 T2 落地后这里应改成断言弯引号，不要反过来用它限制实现。
 */
import { EDIT_LENIENT_MATCH_EVENT_NAME } from "@sid-code/core/tool/edit.ts";
import type { SmokeCase } from "../../lib/types.ts";

/** 事件名在实现侧是字面量（与 ToolInputAliasApplied 同批），这里按契约写死并由此用例守。 */
const TOOL_INPUT_COERCED_EVENT_NAME = "ToolInputCoerced";

const def: SmokeCase = {
  id: "H1-lenient-telemetry",
  ledger: "H1",
  feature: "工具宽进可观测（edit 归一化命中 / 参数归一两层）",
  kind: "guard",
  repo: {
    // 弯引号 U+201C/U+201D：模型复述时写直引号是常态，这正是 normalized 策略要接住的情况
    "doc.md": "配置说明：\u201cinherit\u201d 默认 true\n",
  },
  argv: ["-p", "读取 doc.md，把 inherit 的默认值改为 false"],
  expect: {
    events: [
      // 归一化命中单独成策略，且只此一条（精确命中不发事件）
      {
        event: EDIT_LENIENT_MATCH_EVENT_NAME,
        where: { strategy: "normalized", file_ext: "md", occurrences: 1 },
        count: 1,
      },
      // 参数归一两层：nullish 摘掉 limit、numeric 转 offset，各一条
      {
        event: TOOL_INPUT_COERCED_EVENT_NAME,
        where: { tool: "read", layer: "nullish", field: "limit" },
        count: 1,
      },
      {
        event: TOOL_INPUT_COERCED_EVENT_NAME,
        where: { tool: "read", layer: "numeric", field: "offset" },
        count: 1,
      },
      // edit 真的执行成功（事件是成功路径才发的，这条是它的前置）
      { event: "PostToolUse", where: { tool_name: "edit", is_error: false }, count: 1 },
    ],
  },
  mutations: [
    {
      file: "packages/core/src/tool/edit.ts",
      find: 'if (result.strategy !== "exact") {',
      replace: "if (false) {",
      why: "宽进命中不再发事件：归一化/模糊/正则命中在轨迹里重新变成不可见",
    },
    {
      file: "packages/core/src/tool/input-validator.ts",
      find: 'emitToolInputCoerced({ tool: tool.name(), layer: "numeric", ...hit });',
      replace: "void hit;",
      why: "numeric 层照常归一但不再留痕：答不了「哪个字段最常被归一」",
    },
  ],
};

export default def;
