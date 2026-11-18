/**
 * C2（PR2）：auto 档回退人工时，确认框里那一行「为什么没放行」。
 *
 * 用户看到命令却看不到分类器的结论，就无法判断这次弹窗是「模型误判」还是
 * 「自己确实没授权」。把理由摊开，用户才能决定是直接批准、还是补一句授权说明
 * 让下一轮不再弹（PR2 的 B1 让分类器看得见用户意图，两件事配成一套才闭环）。
 *
 * 文案与 `Decision.metadata.autoClassifier` 的固定枚举一一对应：
 * - `unsafe`：分类器说了话，判不安全 → 必须把它的理由给出来；
 * - `unavailable` / `error`：分类器没给出结论（不可用 / 超时 / 异常），措辞要
 *   明确「是它坏了，不是你被拒了」，否则用户会误以为自己的操作有问题；
 * - `safety-guard`：结构检查直接禁止分类器参与（危险命令 / hook 安全确认 / MCP 破坏性），
 *   给出命中的那一项；
 * - `ask-rule`：用户自己写的 ask 规则，说明「这是你的配置生效」，不是模型判断。
 *
 * 纯展示，不参与任何判定。未命中已知枚举时返回 undefined（不显示这一行）——
 * 静默优于显示一句看不懂的话。
 */

import type { AutoFallbackNote } from "@sid-code/core/permission/types.ts";

export function describeAutoFallback(note: AutoFallbackNote | undefined): string | undefined {
  if (!note) return undefined;
  switch (note.kind) {
    case "unsafe":
      return `auto 未放行：${note.reason || "分类器判定超出用户授权"}`;
    case "unavailable":
    case "error":
      return `auto 分类器不可用（${note.reason || "未知原因"}），需要你确认`;
    case "safety-guard":
      return note.guard
        ? `auto 无权放行：命中结构检查 ${note.guard}，这类确认只能由人决定`
        : "auto 无权放行：命中结构检查，这类确认只能由人决定";
    case "ask-rule":
      return "auto 无权放行：命中你配置的 ask 规则";
    default:
      return undefined;
  }
}
