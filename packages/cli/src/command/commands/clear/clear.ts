import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/** /clear 命令 */
export class ClearCommand implements LocalCommandModule {
  async call(_args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    return { type: "clear" };
  }
}
