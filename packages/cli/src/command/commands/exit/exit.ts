import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/** /exit 命令 */
export class ExitCommand implements LocalCommandModule {
  async call(_args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    return { type: "quit", message: "再见！" };
  }
}
