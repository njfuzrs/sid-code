/**
 * UnifiedCommand → 补全列表轻量结构（TUIState.commands）的映射。
 *
 * 从 app.ts loadCommandList 的内联 .map() 提出来，是为了让「字段在这一跳有没有被丢」
 * 能被单测直接断言（D10）：argumentHint 曾在这一跳被丢，前半段（legacy → UnifiedCommand）
 * 的注释又写着「透出到补全」，于是整条链路看起来是通的。内联在 App 类私有方法里时，
 * 端到端断言只能起整个 App，没人会去写。
 */

import type { UnifiedCommand } from "./types.ts";

export interface CompletionCommandEntry {
  name: string;
  aliases: string[];
  description: string;
  requiresArgs?: boolean;
  argumentHint?: string;
  immediate?: boolean;
  type?: string;
}

export function toCompletionEntries(cmds: readonly UnifiedCommand[]): CompletionCommandEntry[] {
  return (
    cmds
      // 隐藏命令不进补全列表
      .filter((c) => !c.isHidden)
      // 仅用户可调用的进补全（userInvocable 默认 true）
      .filter((c) => c.userInvocable !== false)
      .map((c) => ({
        name: c.name,
        aliases: c.aliases ?? [],
        description: c.description,
        requiresArgs: c.requiresArgs,
        // D10：「回填等你输入」（requiresArgs）的另一半是「告诉你输入什么」。
        // 空串（custom 命令无 frontmatter 时 argumentHint() 返回 ""）归一为 undefined。
        argumentHint: c.argumentHint || undefined,
        // P0-1/P0-2：immediate 与 type 透传给 UI，让「流式中是否允许插队」这个
        // 判断能在提交那一刻做出来。此前 27 条命令声明 immediate、0 处读取，
        // 于是 /compact 等会改写消息历史的命令也一律直送，与流式写入构成
        // 读-改-写竞争。判据必须落在 UI 提交路径上（App.tsx handleSubmit），
        // 那里是唯一能决定「直送还是入队」的地方。
        immediate: c.immediate,
        type: c.type,
      }))
  );
}
