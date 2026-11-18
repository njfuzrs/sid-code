import type { UnifiedCommand } from "../../types.ts";

/**
 * /context 命令定义（轻量，启动时加载）。
 *
 * 上下文用量拆解：分类 token、常驻/会话分组、实测对账、四档压缩阈值、
 * 固定开销来源。实现在 ./context.ts，排版在 ./context-render.ts。
 *
 * 形态是命令输出面板（`outputPanel: true`），与 /cost、/perf 同款：
 * 查看类命令不写专属 Dialog（`src/ui/CLAUDE.md` L4-H），且面板自带滚动、
 * 只画上下横线（用户会复制这些数字，L2.2）。
 *
 * 与 /status 分工：/context 是「token 深度拆解 + 距压缩还有多远」，/status 是「会话概览一屏」。
 */
const context: UnifiedCommand = {
  type: "local",
  name: "context",
  aliases: [],
  description: "上下文用量拆解：分类 token、压缩档位与阈值、实测对账",
  source: "builtin",
  headless: true,
  outputPanel: true,
  userInvocable: true,
  immediate: true,
  load: () => import("./context.ts").then((m) => m.default),
};

export default context;
