// 语义颜色接口定义
// 参考 gemini-cli/packages/cli/src/ui/themes/semantic-tokens.ts

export interface SemanticColors {
  text: {
    primary: string;
    secondary: string;
    link: string;
    accent: string;
    response: string;
  };
  background: {
    primary: string;
    message: string;
    input: string;
    focus: string;
    diff: {
      added: string;
      removed: string;
    };
  };
  border: {
    default: string;
  };
  ui: {
    comment: string;
    symbol: string;
    active: string;
    dark: string;
    focus: string;
    gradient: string[] | undefined;
  };
  status: {
    error: string;
    success: string;
    warning: string;
  };
}

// 深色主题语义颜色
export const darkSemanticColors: SemanticColors = {
  text: {
    primary: '#cdd6f4',
    secondary: '#6c7086',
    link: '#89b4fa',
    accent: '#cba6f7',
    response: '#cdd6f4',
  },
  background: {
    primary: '#1e1e2e',
    message: '#181825',
    input: '#313244',
    focus: '#1e3a5f',
    diff: {
      added: '#1e3a2e',
      removed: '#3a1e1e',
    },
  },
  border: {
    default: '#45475a',
  },
  ui: {
    comment: '#6c7086',
    symbol: '#6c7086',
    active: '#89b4fa',
    dark: '#45475a',
    focus: '#a6e3a1',
    gradient: ['#89b4fa', '#cba6f7'],
  },
  status: {
    error: '#f38ba8',
    success: '#a6e3a1',
    warning: '#f9e2af',
  },
};

// 浅色主题语义颜色
export const lightSemanticColors: SemanticColors = {
  text: {
    primary: '#4c4f69',
    secondary: '#9ca0b0',
    link: '#1e66f5',
    accent: '#8839ef',
    response: '#4c4f69',
  },
  background: {
    primary: '#eff1f5',
    message: '#e6e9ef',
    input: '#ccd0da',
    focus: '#dce8ff',
    diff: {
      added: '#d4edda',
      removed: '#f8d7da',
    },
  },
  border: {
    default: '#bcc0cc',
  },
  ui: {
    comment: '#9ca0b0',
    symbol: '#9ca0b0',
    active: '#1e66f5',
    dark: '#bcc0cc',
    focus: '#40a02b',
    gradient: ['#1e66f5', '#8839ef'],
  },
  status: {
    error: '#d20f39',
    success: '#40a02b',
    warning: '#df8e1d',
  },
};
