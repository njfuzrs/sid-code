/**
 * 斜杠命令系统的核心类型
 * 用户在交互式模式下输入 /xxx 即可触发对应的命令
 *
 * 命令契约（UnifiedCommand / CommandContext / LocalCommandResult 等）定义在 core 的
 * command-contract/types.ts，这里 re-export；本文件只保留执行引擎的返回类型。
 *
 * 2026-11-02 命令体系收口：旧体系 Command / CommandResult / AppContext 与 adapter.ts 已删除，
 * 全部内置命令都在 commands/ 目录。
 */

// 本文件内 CommandExecutionResult 要用 DialogType。
// re-export 语句不产生本地绑定，所以除 re-export 外还需这条 import。
import type { DialogType } from "@sid-code/core/command-contract/types.ts";

/**
 * 支持的对话框类型。
 *
 * 定义已随命令契约下移到 core（`command-contract/types.ts`）——
 * 它在 `LocalCommandResult` 的闭包里（命令可返回「打开某对话框」），必须与契约同包。
 * 此处 re-export 供 cli 侧既有导入方沿用。
 */
export type { DialogType } from "@sid-code/core/command-contract/types.ts";

// ============================================================
// 新体系：契约类型已下移到 core（P2-2 分包，修法①）
// ============================================================

/**
 * 新体系的命令契约类型定义在 `src/command-contract/types.ts`（core 包）。
 *
 * 原因：`src/skill/`（core）要「把自己注册成一条命令」，这是它对外的契约，
 * 契约本该由被依赖方定义；类型留在这里会让 core 反向依赖 cli。
 *
 * 下面 re-export 让 35 个既有导入方无需改动路径。
 */
export type {
  CommandSource,
  CommandContext,
  CommandBase,
  LocalCommand,
  LocalCommandModule,
  LocalCommandResult,
  LocalJSXCommand,
  LocalJSXCommandModule,
  LocalJSXCommandOnDone,
  LocalJSXDoneOptions,
  PromptCommand,
  UnifiedCommand,
  UnifiedCommandRegistryContract,
  CommandPanelSpec,
} from "@sid-code/core/command-contract/types.ts";

// ============================================================
// 新体系：命令执行结果（执行引擎返回给应用层）
// ============================================================

export type CommandExecutionResult =
  | {
      type: "message";
      value: string;
      shouldQuery?: boolean;
      /** 有值 = TUI 里进命令输出面板（弹窗），而不是追加进消息流。见 CommandBase.outputPanel */
      panel?: import("@sid-code/core/command-contract/types.ts").CommandPanelSpec;
      /**
       * 模型对本次命令的回答（fork 执行的 prompt 命令 / skill）：TUI 写进消息流与上下文，
       * 当一轮对话展示，**不**走面板/状态栏。优先级高于 panel。
       */
      conversational?: boolean;
    }
  | {
      type: "submit_prompt";
      value: string;
      shouldQuery: boolean;
      /** 命令 `allowed-tools`：本轮免确认 allow 规则（只作用于这一轮，app 负责清空） */
      allowedTools?: string[];
      allowedToolsTrusted?: boolean;
    }
  | { type: "dialog"; dialog: DialogType }
  | { type: "clear" }
  | { type: "quit"; message?: string }
  | { type: "compact"; summary: string }
  | { type: "confirm"; message: string; onConfirm: () => Promise<CommandExecutionResult> }
  | { type: "error"; message: string }
  | { type: "passthrough"; value: string } // 当作普通文本发给模型
  | { type: "skip" }; // 静默完成
