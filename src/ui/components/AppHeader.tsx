/**
 * AppHeader 组件
 *
 * 显示在消息列表顶部，随消息一起滚动。
 * 复用 EmptyLogo 的双栏布局（Logo + 信息面板），保持视觉统一。
 */

import React from "react";
import { EmptyLogo } from "./EmptyLogo.tsx";
import { useConfig } from "../contexts/ConfigContext.tsx";
import useStdout from "../../ink/_vendor/use-stdout.js";

interface AppHeaderProps {
  version: string;
}

export const AppHeader: React.FC<AppHeaderProps> = ({ version: _version }) => {
  const config = useConfig();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns || 100;

  return (
    <EmptyLogo
      termWidth={termWidth}
      cwd={config.cwd}
      gitBranch={config.gitBranch}
      model={config.model}
    />
  );
};
