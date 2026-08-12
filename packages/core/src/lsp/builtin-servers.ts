/**
 * 内置常见语言 LSP 服务器目录 —— 单一事实源
 *
 * 设计动机（企业级开箱即用）：
 * - 过去只内置 TypeScript 一种 LSP，其余语言（Vue/Python/Go/Rust 等）全靠用户
 *   手写 `~/.sid-code/lsp.json`，且缺失时报错无引导 → 体验割裂。
 * - LSP 服务器是独立进程（Node/Python/Go/Rust 各异构运行时），无法打进单二进制，
 *   故"全内置二进制"物理上不可行。业界（VSCode/Neovim/Zed）均走"按需获取 + 自动配置"。
 * - 本目录承担"自动配置"：把常见语言的 command / 扩展名映射 / 安装引导集中登记。
 *   command 已在 PATH → 自动注册即可用（零配置）；未安装 → 报错时给出精准安装命令。
 *
 * 这是**唯一**登记内置语言的地方：config.ts 据此自动注册可用服务器，lsp.ts 据此
 * 生成缺失引导。新增语言只需在此追加一条 —— 防止路由表 / 引导文案多处漂移。
 */

/** 单个内置 LSP 服务器的登记条目 */
export interface BuiltinLSPServer {
  /** 服务器名（路由与日志用，也是 lsp.json 里覆盖同名配置的 key） */
  name: string;
  /** 可执行命令名（用于 PATH 探测与 spawn） */
  command: string;
  /** 命令参数（LSP 走 stdio 通信几乎都用 --stdio） */
  args: string[];
  /** 文件扩展名 → LSP 语言 ID 映射（构建路由表用） */
  extensionToLanguage: Record<string, string>;
  /**
   * 未安装时的引导文案：一句话说清"这是什么 + 怎么装"。
   * 面向用户，故用中文；命令给可直接复制执行的形式。
   */
  installHint: string;
  /** 初始化选项（部分服务器如 Volar 需要额外 initializationOptions） */
  initializationOptions?: Record<string, unknown>;
}

/**
 * 内置常见语言目录。
 *
 * 覆盖原则：只收录"主流、单一权威 language server、社区活跃"的语言，避免为长尾语言
 * 塞入低质量或多方案并存的配置（那类交给用户自行写 lsp.json 覆盖）。
 * command 命名以各 language server 的官方安装产物为准。
 */
export const BUILTIN_LSP_SERVERS: readonly BuiltinLSPServer[] = [
  {
    name: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensionToLanguage: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".mts": "typescript",
      ".cts": "typescript",
    },
    installHint:
      "TypeScript/JavaScript 需 typescript-language-server，安装：npm i -g typescript-language-server typescript",
  },
  {
    name: "vue",
    command: "vue-language-server",
    args: ["--stdio"],
    extensionToLanguage: {
      ".vue": "vue",
    },
    installHint:
      "Vue 需 Volar（@vue/language-server），安装：npm i -g @vue/language-server @vue/typescript-plugin",
  },
  {
    name: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensionToLanguage: {
      ".py": "python",
      ".pyi": "python",
    },
    installHint: "Python 需 Pyright，安装：npm i -g pyright（或用 pip install pyright）",
  },
  {
    name: "go",
    command: "gopls",
    args: [],
    extensionToLanguage: {
      ".go": "go",
    },
    installHint: "Go 需 gopls，安装：go install golang.org/x/tools/gopls@latest",
  },
  {
    name: "rust",
    command: "rust-analyzer",
    args: [],
    extensionToLanguage: {
      ".rs": "rust",
    },
    installHint:
      "Rust 需 rust-analyzer，安装：rustup component add rust-analyzer（或从官方 Release 下载二进制）",
  },
  {
    name: "json",
    command: "vscode-json-language-server",
    args: ["--stdio"],
    extensionToLanguage: {
      ".json": "json",
      ".jsonc": "jsonc",
    },
    installHint: "JSON 需 vscode-json-language-server，安装：npm i -g vscode-langservers-extracted",
  },
  {
    name: "yaml",
    command: "yaml-language-server",
    args: ["--stdio"],
    extensionToLanguage: {
      ".yaml": "yaml",
      ".yml": "yaml",
    },
    installHint: "YAML 需 yaml-language-server，安装：npm i -g yaml-language-server",
  },
  {
    name: "html",
    command: "vscode-html-language-server",
    args: ["--stdio"],
    extensionToLanguage: {
      ".html": "html",
      ".htm": "html",
    },
    installHint: "HTML 需 vscode-html-language-server，安装：npm i -g vscode-langservers-extracted",
  },
  {
    name: "css",
    command: "vscode-css-language-server",
    args: ["--stdio"],
    extensionToLanguage: {
      ".css": "css",
      ".scss": "scss",
      ".less": "less",
    },
    installHint: "CSS 需 vscode-css-language-server，安装：npm i -g vscode-langservers-extracted",
  },
  {
    name: "bash",
    command: "bash-language-server",
    args: ["start"],
    extensionToLanguage: {
      ".sh": "shellscript",
      ".bash": "shellscript",
    },
    installHint: "Shell 需 bash-language-server，安装：npm i -g bash-language-server",
  },
] as const;

/**
 * 反向索引：扩展名 → 该扩展名对应的内置服务器条目。
 *
 * 供 lsp.ts 在"路由未命中"时反查：即便该 language server 未安装（未注册进运行时
 * 路由表），也能凭扩展名认出"这是 Vue/Python 文件"，给出精准安装引导，而非笼统的
 * "未知文件类型"。多个服务器声明同一扩展名时，以目录中靠前者为准（先到先得）。
 */
export const EXTENSION_TO_BUILTIN: ReadonlyMap<string, BuiltinLSPServer> = (() => {
  const map = new Map<string, BuiltinLSPServer>();
  for (const server of BUILTIN_LSP_SERVERS) {
    for (const ext of Object.keys(server.extensionToLanguage)) {
      if (!map.has(ext)) map.set(ext, server);
    }
  }
  return map;
})();

/** 从文件路径取扩展名（小写，含点），无扩展名返回空串 */
function extOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * 为"路由未命中"的文件生成精准的引导文案（供 LSP 工具报错时使用）。
 *
 * 分三种情形，让用户拿到可执行的下一步，而非笼统的"未配置"：
 * 1. 扩展名在内置目录中（如 .vue）→ 说明是哪个语言 + 给出安装命令 + lsp.json 路径提示；
 *    这几乎总是"language server 未安装"或"未在 PATH 中"。
 * 2. 扩展名不在内置目录（长尾语言）→ 告知需自行在 lsp.json 中配置，并给出文件路径。
 *
 * @param filePath 触发路由未命中的文件绝对路径
 * @param globalConfigPath 全局 lsp.json 路径（由调用方注入，避免此模块依赖 paths.ts）
 */
export function describeMissingServer(filePath: string, globalConfigPath: string): string {
  const ext = extOf(filePath);
  const builtin = ext ? EXTENSION_TO_BUILTIN.get(ext) : undefined;

  if (builtin) {
    // 内置支持但当前未注册 = 对应 language server 未安装或不在 PATH。
    return [
      `未找到处理 ${ext} 文件的 LSP 服务器：${filePath}`,
      `原因：${builtin.name} language server 未安装或不在 PATH 中。`,
      builtin.installHint,
      `安装后重启 sid-code 即自动生效（无需手动配置）。`,
    ].join("\n");
  }

  // 长尾语言：内置目录未覆盖，引导用户自行配置。
  const extLabel = ext || "该";
  return [
    `没有为 ${extLabel} 文件类型配置 LSP 服务器：${filePath}`,
    `内置语言目录未覆盖此类型。可在全局配置 ${globalConfigPath} 或项目 .sid-code/lsp.json 中添加，格式：`,
    `  { "<名称>": { "command": "<language-server 命令>", "args": ["--stdio"], "extensionToLanguage": { "${ext || ".xxx"}": "<语言ID>" } } }`,
  ].join("\n");
}
