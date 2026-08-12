/**
 * GitHub Light 主题
 *
 * 参考 gemini-cli/packages/cli/src/ui/themes/builtin/light/github-light.ts
 */

import { type ColorsTheme, Theme } from "../../theme.ts";
import { interpolateColor } from "../../color-utils.ts";
import { githubLightSemanticColors } from "../../semantic-tokens.ts";

const githubLightColors: ColorsTheme = {
  type: "light",
  Background: "#ffffff",
  Foreground: "#24292e",
  LightBlue: "#005cc5",
  AccentBlue: "#005cc5",
  AccentPurple: "#6f42c1",
  AccentCyan: "#032f62",
  AccentGreen: "#22863a",
  AccentYellow: "#e36209",
  AccentRed: "#d73a49",
  DiffAdded: "#e6ffed",
  DiffRemoved: "#ffeef0",
  Comment: "#6a737d",
  Gray: "#6a737d",
  DarkGray: interpolateColor("#6a737d", "#ffffff", 0.5),
  GradientColors: ["#005cc5", "#22863a"],
};

export const GitHubLight: Theme = new Theme(
  "GitHub Light",
  "light",
  {
    hljs: {
      display: "block",
      overflowX: "auto",
      padding: "0.5em",
      color: githubLightColors.Foreground,
      background: githubLightColors.Background,
    },
    "hljs-comment": {
      color: githubLightColors.Comment,
      fontStyle: "italic",
    },
    "hljs-quote": {
      color: githubLightColors.Comment,
      fontStyle: "italic",
    },
    "hljs-keyword": {
      color: githubLightColors.AccentRed,
      fontWeight: "bold",
    },
    "hljs-selector-tag": {
      color: githubLightColors.AccentRed,
      fontWeight: "bold",
    },
    "hljs-subst": {
      color: githubLightColors.Foreground,
    },
    "hljs-number": {
      color: githubLightColors.LightBlue,
    },
    "hljs-literal": {
      color: githubLightColors.LightBlue,
    },
    "hljs-variable": {
      color: githubLightColors.AccentYellow,
    },
    "hljs-template-variable": {
      color: githubLightColors.AccentYellow,
    },
    "hljs-string": {
      color: githubLightColors.AccentCyan,
    },
    "hljs-doctag": {
      color: githubLightColors.AccentCyan,
    },
    "hljs-title": {
      color: githubLightColors.AccentPurple,
      fontWeight: "bold",
    },
    "hljs-section": {
      color: githubLightColors.AccentPurple,
      fontWeight: "bold",
    },
    "hljs-selector-id": {
      color: githubLightColors.AccentPurple,
      fontWeight: "bold",
    },
    "hljs-type": {
      color: githubLightColors.AccentGreen,
      fontWeight: "bold",
    },
    "hljs-tag": {
      color: githubLightColors.AccentGreen,
    },
    "hljs-name": {
      color: githubLightColors.AccentGreen,
    },
    "hljs-attribute": {
      color: githubLightColors.LightBlue,
    },
    "hljs-regexp": {
      color: githubLightColors.AccentCyan,
    },
    "hljs-link": {
      color: githubLightColors.AccentCyan,
    },
    "hljs-symbol": {
      color: githubLightColors.AccentPurple,
    },
    "hljs-bullet": {
      color: githubLightColors.AccentPurple,
    },
    "hljs-built_in": {
      color: githubLightColors.LightBlue,
    },
    "hljs-builtin-name": {
      color: githubLightColors.LightBlue,
    },
    "hljs-meta": {
      color: githubLightColors.LightBlue,
      fontWeight: "bold",
    },
    "hljs-deletion": {
      background: "#ffeef0",
      color: githubLightColors.AccentRed,
    },
    "hljs-addition": {
      background: "#e6ffed",
      color: githubLightColors.AccentGreen,
    },
    "hljs-emphasis": {
      fontStyle: "italic",
    },
    "hljs-strong": {
      fontWeight: "bold",
    },
  },
  githubLightColors,
  githubLightSemanticColors,
);
