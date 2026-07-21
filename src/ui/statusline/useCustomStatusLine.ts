/**
 * 自定义状态栏 Hook（P1-5 渲染层桥接）
 *
 * 在 Footer 里调用：若 settings.statusLine.command 配了脚本，则组装会话数据、
 * 节流跑脚本（run-statusline.ts），返回脚本 stdout 供 Footer 渲染；未配或脚本
 * 失败/超时时返回 null，Footer 回退内置聚合状态栏。
 *
 * 触发时机：依赖会话数据变化时重跑（run-statusline 内部再按指纹 + 时间窗节流），
 * 不每帧跑（脚本是外部进程，开销大）。
 */

import { useEffect, useState } from "react";
import { runStatusLine, type StatusLineSessionData, type StatusLineConfig } from "./run-statusline.ts";

export interface UseCustomStatusLineInput {
  config: StatusLineConfig | undefined;
  data: StatusLineSessionData;
}

/**
 * 返回自定义状态栏文本（脚本 stdout），未配置/失败返回 null。
 */
export function useCustomStatusLine(input: UseCustomStatusLineInput): string | null {
  const { config, data } = input;
  const [output, setOutput] = useState<string | null>(null);

  const enabled = config?.type === "command" && !!config.command?.trim();

  // 用会话数据关键字段拼一个依赖 key，字段变了才重跑（避免每次渲染都 spawn）。
  const depKey = enabled
    ? [
        config!.command,
        data.cwd,
        data.gitBranch,
        data.worktree,
        data.permissionMode,
        data.model,
        data.inputTokens,
        data.outputTokens,
        data.contextPercent,
        data.costUSD.toFixed(4),
        data.cacheHitRate,
        data.effort,
        data.thinking ? "1" : "0",
      ].join("|")
    : "";

  useEffect(() => {
    if (!enabled) {
      setOutput(null);
      return;
    }
    let cancelled = false;
    // Date.now 在真实运行时可用（本 hook 只在浏览器/node 运行时执行，非 workflow 脚本沙箱）。
    runStatusLine(config, data, Date.now())
      .then((out) => {
        if (!cancelled) setOutput(out);
      })
      .catch(() => {
        if (!cancelled) setOutput(null);
      });
    return () => {
      cancelled = true;
    };
    // depKey 已涵盖 config/data 的关键字段变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, depKey]);

  return enabled ? output : null;
}
