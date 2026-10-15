import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/**
 * /login 实现（按需加载）。核心流程复用 core 的 performCliLogin，不复制。
 *
 * 难点是等浏览器回调最长 5 分钟：命令不能把输入框卡这么久。所以拿到授权链接就立刻返回，
 * 授权在后台跑，结束时走 ctx.notify（状态栏）报结果。notify 是闭包、每次调用才读实例上的
 * statusNotifier，命令返回后再调是安全的（登录闭环方案 §8 第 3 条）。
 * 没有 notify（测试 / 非交互）时退回为同步等待，在命令结果里给出结论。
 *
 * 同一进程内只允许一个登录流程：重复 /login 直接返回同一个链接，不起第二个回调服务器。
 */

interface PendingLogin {
  url: string;
  abort: AbortController;
  done: Promise<void>;
}

let pending: PendingLogin | null = null;

function linkMessage(url: string, again: boolean): string {
  return [
    again
      ? "登录流程已在进行中，授权链接："
      : "已尝试打开浏览器完成飞书授权。若没有自动打开，请手动访问：",
    "",
    `  ${url}`,
    "",
    "5 分钟内有效。可以继续使用，授权完成后状态栏会提示；/login cancel 取消。",
    "SSH 远程机器上：回调地址是 127.0.0.1，需要 ssh -L <端口>:127.0.0.1:<端口> 转发。",
  ].join("\n");
}

async function startLogin(ctx: CommandContext, backendUrl: string): Promise<LocalCommandResult> {
  const { performCliLogin } = await import("@sid-code/core/identity/cli-login.ts");
  const { getRawVersion } = await import("@sid-code/shared/version.ts");
  const abort = new AbortController();

  let resolveUrl!: (url: string) => void;
  const urlReady = new Promise<string>((r) => (resolveUrl = r));

  const flow = performCliLogin(backendUrl, {
    version: getRawVersion(),
    signal: abort.signal,
    onAuthorizeUrl: (url) => resolveUrl(url),
  });

  const done = flow.then(
    (result) => {
      const who =
        result.user?.name ?? result.user?.unionId ?? result.user?.id ?? "(未返回用户信息)";
      ctx.notify?.(`✓ 已登录企业后端：${who}`);
    },
    (err: Error) => {
      if (abort.signal.aborted) {
        ctx.notify?.("已取消登录");
        return;
      }
      ctx.notify?.(`✗ 登录失败：${err.message}`);
    },
  );

  // 回调服务器起不来（端口全占）时 flow 会在给出链接之前就失败，不能一直等 urlReady
  const first = await Promise.race([
    urlReady.then((url) => ({ url })),
    flow.then(
      () => ({ url: undefined as string | undefined, error: undefined as Error | undefined }),
      (error: Error) => ({ url: undefined, error }),
    ),
  ]);
  if (!first.url) {
    const error = "error" in first ? first.error : undefined;
    return { type: "text", value: `✗ 登录失败：${error?.message ?? "未拿到授权链接"}` };
  }

  const entry: PendingLogin = { url: first.url, abort, done };
  pending = entry;
  void done.finally(() => {
    if (pending === entry) pending = null;
  });

  if (!ctx.notify) {
    // 非交互：没有状态栏可报结果，只能同步等
    const lines: string[] = [];
    try {
      const r = await flow;
      lines.push(
        `✓ 已登录：${r.user?.name ?? r.user?.unionId ?? r.user?.id ?? "(未返回用户信息)"}`,
      );
    } catch (err) {
      lines.push(`✗ 登录失败：${(err as Error).message}`);
    }
    return { type: "text", value: `${linkMessage(first.url, false)}\n\n${lines.join("\n")}` };
  }
  return { type: "text", value: linkMessage(first.url, false) };
}

const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const sub = args.trim();
    if (sub === "cancel") {
      if (!pending) return { type: "text", value: "当前没有进行中的登录。" };
      pending.abort.abort();
      return { type: "text", value: "已取消登录，回调服务器已关闭。" };
    }
    if (sub !== "") {
      return { type: "text", value: `未知参数「${sub}」。用法: /login [cancel]` };
    }

    if (pending) return { type: "text", value: linkMessage(pending.url, true) };

    const { resolveBackendUrl } = await import("@sid-code/core/identity/backend-url.ts");
    const { NO_BACKEND_HINT } = await import("@sid-code/core/identity/login-status.ts");
    const backend = resolveBackendUrl();
    if (!backend) return { type: "text", value: NO_BACKEND_HINT };

    const { getDeviceCredential } = await import("@sid-code/core/identity/credential.ts");
    const cred = getDeviceCredential();
    if (cred) {
      const who = cred.user?.name ?? cred.user?.unionId ?? cred.user?.id ?? "(设备凭据未绑定到人)";
      return {
        type: "confirm",
        message: `当前已登录：${who}\n重新登录会让服务端吊销当前凭据。继续？`,
        onConfirm: () => startLogin(ctx, backend.url),
      };
    }
    return startLogin(ctx, backend.url);
  },
};

export default mod;
