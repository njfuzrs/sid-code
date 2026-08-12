// src/tool/grep-type-alias.ts
// grep 工具 `type` 参数的别名归一 + 非法值降级
//
// ── 为什么需要（2026-08-01 真实报错）─────────────────────────────────────
// 轨迹 20260801-175042-699f69f8 里出现：
//   grep "onSubmit\(|<Composer|Composer\s"
//   ⎿ 搜索失败: ripgrep 退出码 2: rg: unrecognized file type: tsx
//
// 根因：grep.ts 把 `params.type` 裸透传给 `rg --type`，无校验无映射。而 rg 的
// type 表里**没有 `tsx`**——`ts` 本身已包含 `*.tsx`（rg --type-list 实测：
// `ts: *.cts, *.mts, *.ts, *.tsx`）。模型按直觉写 `tsx` 就整条搜索失败。
//
// 这不是"模型写错了"就该算完的事：`tsx` 是一个完全合理的直觉表达，工具层有
// 能力把它翻译成 rg 认识的说法。让一次本可成功的搜索硬失败，代价是模型要多花
// 一轮去试错（那次事故里它确实又重搜了一遍），而这一轮的 token 和延迟是纯浪费。
//
// ── 立场：先归一，再降级，绝不硬失败 ─────────────────────────────────
// 1) 别名能映射 → 映射（tsx → ts）；
// 2) 映射后仍不是 rg 已知类型 → **不传 --type，降级为等价 glob**，并在结果里
//    附一句提示。宁可搜得宽一点让模型自己筛，也不要因为一个可猜的参数把整次
//    搜索判死。
//
// ── 为什么白名单要硬编码而不是运行时 `rg --type-list` ───────────────────
// 每次 grep 都 fork 一次 rg 拿类型表，成本远高于收益（grep 是最高频工具）；
// 且类型表随 rg 版本变化极慢。硬编码 + "未知即降级"的组合已经安全：白名单漏了
// 某个真实类型，最坏结果是降级成 glob（仍能搜到），不会误报失败。
//
// 白名单来源：`rg --type-list | cut -d: -f1`（本机 rg 实测 218 项，取其全量）。

/**
 * rg 已知类型全集（`rg --type-list` 的类型名，218 项）。
 * 只用于"是否需要降级"的判定，不参与映射。
 */
const RG_KNOWN_TYPES = new Set<string>([
  "ada",
  "agda",
  "aidl",
  "alire",
  "amake",
  "asciidoc",
  "asm",
  "asp",
  "ats",
  "avro",
  "awk",
  "bat",
  "batch",
  "bazel",
  "bitbake",
  "boxlang",
  "brotli",
  "buildstream",
  "bzip2",
  "c",
  "cabal",
  "candid",
  "carp",
  "cbor",
  "ceylon",
  "cfml",
  "clojure",
  "cmake",
  "cmd",
  "cml",
  "coffeescript",
  "config",
  "coq",
  "cpp",
  "creole",
  "crystal",
  "cs",
  "csharp",
  "cshtml",
  "csproj",
  "css",
  "csv",
  "cuda",
  "cython",
  "d",
  "dart",
  "devicetree",
  "dhall",
  "diff",
  "dita",
  "docker",
  "dockercompose",
  "dts",
  "dvc",
  "ebuild",
  "edn",
  "elisp",
  "elixir",
  "elm",
  "erb",
  "erlang",
  "fennel",
  "fidl",
  "fish",
  "flatbuffers",
  "fortran",
  "fsharp",
  "fut",
  "gap",
  "gdscript",
  "gleam",
  "gn",
  "go",
  "gprbuild",
  "gradle",
  "graphql",
  "groovy",
  "gzip",
  "h",
  "haml",
  "hare",
  "haskell",
  "hbs",
  "hs",
  "html",
  "hy",
  "idris",
  "janet",
  "java",
  "jinja",
  "jl",
  "js",
  "json",
  "jsonl",
  "julia",
  "jupyter",
  "k",
  "kconfig",
  "kotlin",
  "lean",
  "less",
  "license",
  "lilypond",
  "lisp",
  "llvm",
  "lock",
  "log",
  "lua",
  "lz4",
  "lzma",
  "m4",
  "make",
  "mako",
  "man",
  "markdown",
  "matlab",
  "md",
  "meson",
  "minified",
  "mint",
  "mk",
  "ml",
  "motoko",
  "msbuild",
  "nim",
  "nix",
  "objc",
  "objcpp",
  "ocaml",
  "org",
  "pants",
  "pascal",
  "pdf",
  "perl",
  "php",
  "po",
  "pod",
  "postscript",
  "prolog",
  "protobuf",
  "ps",
  "puppet",
  "purs",
  "py",
  "python",
  "qmake",
  "qml",
  "qrc",
  "qui",
  "r",
  "racket",
  "raku",
  "rdoc",
  "readme",
  "reasonml",
  "red",
  "rescript",
  "robot",
  "rst",
  "ruby",
  "rust",
  "sass",
  "scala",
  "scdoc",
  "seed7",
  "sh",
  "slim",
  "smarty",
  "sml",
  "solidity",
  "soy",
  "spark",
  "spec",
  "sql",
  "ssa",
  "stylus",
  "sv",
  "svelte",
  "svg",
  "swift",
  "swig",
  "systemd",
  "taskpaper",
  "tcl",
  "tex",
  "texinfo",
  "textile",
  "tf",
  "thrift",
  "toml",
  "ts",
  "twig",
  "txt",
  "typescript",
  "typoscript",
  "typst",
  "usd",
  "v",
  "vala",
  "vb",
  "vcl",
  "verilog",
  "vhdl",
  "vim",
  "vimscript",
  "vue",
  "webidl",
  "wgsl",
  "wiki",
  "xml",
  "xz",
  "yacc",
  "yaml",
  "yang",
  "z",
  "zig",
  "zsh",
  "zstd",
]);

/**
 * 别名 → rg 规范类型名。
 *
 * 只收录「模型/人类会自然写出、但 rg 不认」的写法（全部经本机 rg 实测确认无效）。
 * 刻意**不**收录已经有效的写名（rust / typescript / python / cpp / go 都是 rg
 * 原生类型，无需映射）——映射表越小越不容易和 rg 未来的类型名冲突。
 */
const TYPE_ALIASES: Record<string, string> = {
  // TS/JS 家族：rg 的 ts 已含 *.tsx，js 已含 *.jsx
  tsx: "ts",
  jsx: "js",
  javascript: "js",
  node: "js",
  mjs: "js",
  cjs: "js",
  // 扩展名当类型名写（rg 用语言名而非扩展名）
  rs: "rust",
  golang: "go",
  kt: "kotlin",
  rb: "ruby",
  yml: "yaml",
  // C 家族
  "c++": "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  // shell
  shell: "sh",
  bash: "sh",
  // 其他常见直觉写法
  dockerfile: "docker",
  makefile: "make",
  jsonc: "json",
  htm: "html",
  py3: "py",
  python3: "py",
};

/**
 * 非法类型的 glob 兜底：降级时用等价 glob 尽量保住搜索范围。
 * 只为「没有 rg 类型可映射、但扩展名明确」的情况准备。
 */
const TYPE_FALLBACK_GLOBS: Record<string, string> = {
  tsx: "*.tsx",
  jsx: "*.jsx",
};

export interface ResolvedGrepType {
  /** 传给 `rg --type` 的规范类型名；null 表示不要传 --type */
  rgType: string | null;
  /** 降级时补的 glob（调用方应追加到 --glob）；null 表示无 */
  fallbackGlob: string | null;
  /** 给模型看的一句提示；null 表示原样可用、无需提示 */
  notice: string | null;
}

/**
 * 归一 grep 的 type 参数。
 *
 * 三种结局：
 *   ① 本就是 rg 类型 → 原样透传，无提示；
 *   ② 是已知别名 → 映射为规范名，附一句"已按 X 处理"（让模型学到正确写法）；
 *   ③ 完全不认识 → 不传 --type（可能附 glob 兜底），附一句说明。
 *      **绝不返回错误**——降级搜宽永远好过硬失败。
 */
export function resolveGrepType(raw: string | undefined): ResolvedGrepType {
  if (raw === undefined) {
    return { rgType: null, fallbackGlob: null, notice: null };
  }
  // rg 的类型名全为小写；两端空白是常见的手滑，一并容错。
  const key = raw.trim().toLowerCase();
  if (key === "") {
    return { rgType: null, fallbackGlob: null, notice: null };
  }

  // ① 直接就是 rg 认识的类型
  if (RG_KNOWN_TYPES.has(key)) {
    return { rgType: key, fallbackGlob: null, notice: null };
  }

  // ② 已知别名 → 映射
  const mapped = TYPE_ALIASES[key];
  if (mapped !== undefined && RG_KNOWN_TYPES.has(mapped)) {
    return {
      rgType: mapped,
      fallbackGlob: null,
      notice: `type="${raw}" 不是 ripgrep 类型名，已按 type="${mapped}" 搜索（ripgrep 的 ${mapped} 已覆盖该扩展名）。`,
    };
  }

  // ③ 不认识 → 降级，不传 --type
  const glob = TYPE_FALLBACK_GLOBS[key] ?? null;
  return {
    rgType: null,
    fallbackGlob: glob,
    notice: glob
      ? `type="${raw}" 不是 ripgrep 类型名，已改用 glob="${glob}" 搜索。`
      : `type="${raw}" 不是 ripgrep 类型名，已忽略该过滤条件（搜索范围未收窄）。` +
        `可用 glob 参数按扩展名过滤，或改用 ripgrep 类型名（如 ts / js / py / go / rust）。`,
  };
}

/** 测试用：暴露别名表规模，防止未来误删 */
export function __getGrepTypeAliasCount(): number {
  return Object.keys(TYPE_ALIASES).length;
}
