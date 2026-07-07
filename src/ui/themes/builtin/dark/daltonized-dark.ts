/**
 * Daltonized Dark 主题（色盲友好 · 深色）
 *
 * 用蓝/橙对比替代红/绿，对红绿色盲（最常见）辨识度最高。
 * 配色取自 Okabe-Ito 色盲安全色板。语法高亮映射沿用 Default Dark 的结构，
 * 颜色由 daltonizedDarkTheme 注入。
 */

import { daltonizedDarkTheme, Theme } from '../../theme.ts';
import { daltonizedDarkSemanticColors } from '../../semantic-tokens.ts';

const c = daltonizedDarkTheme;

export const DaltonizedDark: Theme = new Theme(
  'Daltonized Dark',
  'dark',
  {
    hljs: {
      display: 'block',
      overflowX: 'auto',
      padding: '0.5em',
      background: c.Background,
      color: c.Foreground,
    },
    'hljs-keyword': { color: c.AccentBlue },
    'hljs-literal': { color: c.AccentBlue },
    'hljs-symbol': { color: c.AccentBlue },
    'hljs-name': { color: c.AccentBlue },
    'hljs-link': { color: c.AccentBlue, textDecoration: 'underline' },
    'hljs-built_in': { color: c.AccentCyan },
    'hljs-type': { color: c.AccentCyan },
    'hljs-number': { color: c.AccentYellow },
    'hljs-class': { color: c.AccentYellow },
    'hljs-string': { color: c.AccentYellow },
    'hljs-meta-string': { color: c.AccentYellow },
    'hljs-regexp': { color: c.AccentRed },
    'hljs-template-tag': { color: c.AccentRed },
    'hljs-subst': { color: c.Foreground },
    'hljs-function': { color: c.Foreground },
    'hljs-title': { color: c.Foreground },
    'hljs-params': { color: c.Foreground },
    'hljs-formula': { color: c.Foreground },
    'hljs-comment': { color: c.Comment, fontStyle: 'italic' },
    'hljs-quote': { color: c.Comment, fontStyle: 'italic' },
    'hljs-doctag': { color: c.Comment },
    'hljs-meta': { color: c.Gray },
    'hljs-meta-keyword': { color: c.Gray },
    'hljs-tag': { color: c.Gray },
    'hljs-variable': { color: c.AccentPurple },
    'hljs-template-variable': { color: c.AccentPurple },
    'hljs-attr': { color: c.LightBlue },
    'hljs-attribute': { color: c.LightBlue },
    'hljs-builtin-name': { color: c.LightBlue },
    'hljs-section': { color: c.AccentYellow },
    'hljs-emphasis': { fontStyle: 'italic' },
    'hljs-strong': { fontWeight: 'bold' },
    'hljs-bullet': { color: c.AccentYellow },
    'hljs-selector-tag': { color: c.AccentYellow },
    'hljs-selector-id': { color: c.AccentYellow },
    'hljs-selector-class': { color: c.AccentYellow },
    'hljs-selector-attr': { color: c.AccentYellow },
    'hljs-selector-pseudo': { color: c.AccentYellow },
    'hljs-addition': {
      backgroundColor: c.DiffAdded,
      display: 'inline-block',
      width: '100%',
    },
    'hljs-deletion': {
      backgroundColor: c.DiffRemoved,
      display: 'inline-block',
      width: '100%',
    },
  },
  c,
  daltonizedDarkSemanticColors,
);
