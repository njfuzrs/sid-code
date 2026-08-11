import type { LocalCommandModule } from "../../types.ts";

/**
 * /context 命令实现（按需加载）
 *
 * 只负责打开 context 对话框；真正的分类 token 数据由 UI 层通过
 * TUICallbacks.getContextBreakdown 实时读取（ctxMgr.getTokenBreakdown），
 * 保证打开时数字是最新的。
 */
const mod: LocalCommandModule = {
  async call() {
    return { type: "dialog", dialog: "context" };
  },
};

export default mod;
