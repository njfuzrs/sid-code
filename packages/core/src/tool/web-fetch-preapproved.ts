/**
 * WebFetch 预授权域名白名单（对齐 claude-code preapproved.ts）
 *
 * 出于法律与安全考虑，WebFetch 通常只允许访问用户以某种形式提供过的域名。
 * 但对一批「代码相关」的公共文档域名开例外——这些域名的 GET 请求默认免确认。
 *
 * 安全警告：这些预授权域名**仅用于 WebFetch（只读 GET）**。沙箱网络限制**不继承**此列表，
 * 因为对这些域名的任意网络访问（POST、上传等）可能导致数据外泄。
 */

/** 预授权主机集合（部分带路径前缀，如 github.com/anthropics 只放行该组织） */
export const PREAPPROVED_HOSTS = new Set<string>([
  // Anthropic
  "platform.claude.com",
  "code.claude.com",
  "modelcontextprotocol.io",
  "github.com/anthropics",
  "agentskills.io",

  // 主流编程语言
  "docs.python.org",
  "en.cppreference.com",
  "docs.oracle.com",
  "learn.microsoft.com",
  "developer.mozilla.org",
  "go.dev",
  "pkg.go.dev",
  "www.php.net",
  "docs.swift.org",
  "kotlinlang.org",
  "ruby-doc.org",
  "doc.rust-lang.org",
  "www.typescriptlang.org",

  // Web & JavaScript 框架/库
  "react.dev",
  "angular.io",
  "vuejs.org",
  "nextjs.org",
  "expressjs.com",
  "nodejs.org",
  "bun.sh",
  "jquery.com",
  "getbootstrap.com",
  "tailwindcss.com",
  "d3js.org",
  "threejs.org",
  "redux.js.org",
  "webpack.js.org",
  "jestjs.io",
  "reactrouter.com",

  // Python 框架 & 库
  "docs.djangoproject.com",
  "flask.palletsprojects.com",
  "fastapi.tiangolo.com",
  "pandas.pydata.org",
  "numpy.org",
  "www.tensorflow.org",
  "pytorch.org",
  "scikit-learn.org",
  "matplotlib.org",
  "requests.readthedocs.io",
  "jupyter.org",

  // PHP 框架
  "laravel.com",
  "symfony.com",
  "wordpress.org",

  // Java 框架 & 库
  "docs.spring.io",
  "hibernate.org",
  "tomcat.apache.org",
  "gradle.org",
  "maven.apache.org",

  // .NET & C# 框架
  "asp.net",
  "dotnet.microsoft.com",
  "nuget.org",
  "blazor.net",

  // 移动开发
  "reactnative.dev",
  "docs.flutter.dev",
  "developer.apple.com",
  "developer.android.com",

  // 数据科学 & 机器学习
  "keras.io",
  "spark.apache.org",
  "huggingface.co",
  "www.kaggle.com",

  // 数据库
  "www.mongodb.com",
  "redis.io",
  "www.postgresql.org",
  "dev.mysql.com",
  "www.sqlite.org",
  "graphql.org",
  "prisma.io",

  // 云 & DevOps
  "docs.aws.amazon.com",
  "cloud.google.com",
  "kubernetes.io",
  "www.docker.com",
  "www.terraform.io",
  "www.ansible.com",
  "vercel.com/docs",
  "docs.netlify.com",
  "devcenter.heroku.com",

  // 测试 & 监控
  "cypress.io",
  "selenium.dev",

  // 游戏开发
  "docs.unity.com",
  "docs.unrealengine.com",

  // 其它必备工具
  "git-scm.com",
  "nginx.org",
  "httpd.apache.org",
]);

// 模块加载时拆分一次：纯主机名走 O(1) Set.has()，带路径前缀的走小型 per-host 列表。
const { HOSTNAME_ONLY, PATH_PREFIXES } = (() => {
  const hosts = new Set<string>();
  const paths = new Map<string, string[]>();
  for (const entry of PREAPPROVED_HOSTS) {
    const slash = entry.indexOf("/");
    if (slash === -1) {
      hosts.add(entry);
    } else {
      const host = entry.slice(0, slash);
      const p = entry.slice(slash);
      const prefixes = paths.get(host);
      if (prefixes) prefixes.push(p);
      else paths.set(host, [p]);
    }
  }
  return { HOSTNAME_ONLY: hosts, PATH_PREFIXES: paths };
})();

/**
 * 判断 (hostname, pathname) 是否命中预授权白名单。
 * 强制路径分段边界：`/anthropics` 不匹配 `/anthropics-evil/malware`，
 * 只有精确相等或 `/` 后接的才算命中。
 */
export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  if (HOSTNAME_ONLY.has(hostname)) return true;
  const prefixes = PATH_PREFIXES.get(hostname);
  if (prefixes) {
    for (const p of prefixes) {
      if (pathname === p || pathname.startsWith(p + "/")) return true;
    }
  }
  return false;
}
