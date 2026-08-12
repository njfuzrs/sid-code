# sid-code

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/zhourusheng/sid-code/actions/workflows/ci.yml/badge.svg)](https://github.com/zhourusheng/sid-code/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-sid--code.cc-4c8bf5)](https://www.sid-code.cc/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#installation)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.0-000000?logo=bun&logoColor=white)](https://bun.sh)

[中文](./README.zh-CN.md) · **English**

**A coding agent that runs in your terminal.** You describe what you want in plain
language; it reads your code, edits files, runs commands, and then proves the change
is correct with real compiler and test output.

Built in-house on TypeScript + Bun + Ink, shipped as a single compiled binary — download
one file and run it. No Node install, no `npm install`.

- 📖 **Documentation:** https://www.sid-code.cc/ (Chinese)
- 📄 **Changelog:** https://www.sid-code.cc/changelog
- 🤝 **Contributing:** [CONTRIBUTING.md](./CONTRIBUTING.md) · 🔒 **Security:** [SECURITY.md](./SECURITY.md)

> **A note on language.** Chinese is this team's working language. The documentation site,
> most source comments, and the primary README are in Chinese. The CLI itself handles
> English prompts fine, but if you plan to contribute code you should expect to read
> Chinese comments. We consider that a fair thing to state up front rather than have you
> discover it after cloning. See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Installation

```bash
curl -fsSL https://www.sid-code.cc/releases/sid-code/install.sh | bash
```

Then:

```bash
sc                    # start (recommended)
sid-code --version    # confirm the version
sid-code update       # upgrade later
```

Prebuilt binaries cover macOS (arm64 / x64) and Linux (x64 / arm64). If the install
fails or `PATH` isn't picking it up, see the
[install guide](https://www.sid-code.cc/start/install).

## 30-second example

Start it and just describe the problem — there are no commands to memorize:

```text
$ sc

› The timeout config in this module isn't taking effect, find out why

  Searching for timeout-related code…
  Reading packages/core/src/tool/bash.ts:55-80
  Found it: parseEnv reads the env var but never passes it to spawn's timeout param
  Editing packages/core/src/tool/bash.ts
  Running bun test tests/tool/bash.test.ts  → 12 pass 0 fail

  The timeout was ignored because parseEnv's return value was never wired into spawn.
  Fixed, and the unit tests pass.
```

Every step is visible in the terminal, and <kbd>Esc</kbd> interrupts at any point.

## Four things that set it apart

On features, this tracks Claude Code closely — agentic loop, tool calling, permission
gating, hooks, skills, and MCP all have working counterparts. The differences below
aren't claims of "we did it better"; they're things a **closed-source commercial product
structurally cannot offer**:

| Capability | What it means |
| --- | --- |
| **Pluggable providers** | Three protocol families: Anthropic / OpenAI / Ollama. Self-hosted gateways, Azure, and fully offline local models all work. Switching models is a config change, not a change of tool |
| **Own the whole harness** | 44 built-in tools, 32 hook event types, skills and subagents — all readable and modifiable. Find a problem, fix it the same day, without waiting on a vendor roadmap |
| **Fits enterprise plumbing** | Internal gateway billing, on-prem GitLab, MCP integrations, team-wide default config distribution — adapted to real corporate networks |
| **Your data stays yours** | Session trajectories, eval results, and cost ledgers live in your own infrastructure. That's a compliance prerequisite, and it's also the fuel for improving the agent |

Coming from Claude Code, migration is close to zero-cost — see the
[migration guide](https://www.sid-code.cc/team/migrate).

## Where it stands today

| Item | Status |
| --- | --- |
| First-party code | 200k+ lines of TypeScript under `packages/` (excludes the vendored ink fork) |
| Engineering loop | 600+ test files, 8000+ unit tests; the full suite runs on every change and must be green before commit |
| Surface area | 44 built-in tools, 32 hook event types, LSP code intelligence, permission gating, observable trajectories |
| Evaluation | 30 eval cases (including a holdout set), run before each release to catch regressions |

<!--
  How these numbers are counted (verified by hand before each release; write round
  numbers, not exact ones):
    NOTE (P2-2, 2026-08-11): sources moved from a flat src/ into
                   packages/{shared,tui-renderer,core,cli}/src/, so the commands below were
                   updated too. A stale `find src` does not error — it just counts 0, and a
                   silently broken verification command is worse than a stale number, because
                   the next person believes they verified it. The ink fork is now its own
                   package, so we exclude a package instead of the previous grep -v '/ink/'.
    lines of code  find packages/{shared,core,cli}/src -name '*.ts' -o -name '*.tsx' | xargs wc -l
                   (2026-08-11: 203,533 lines, excluding the vendored ink fork = packages/tui-renderer)
    test files     find tests packages/*/src -name '*.test.ts' -o -name '*.test.tsx' | wc -l  (642)
    unit tests     grep -rhoE '\b(it|test)\(' tests packages/*/src --include='*.test.ts' --include='*.test.tsx' | wc -l
                   (8,569)
    hook events    member count of the HookEventName enum in packages/core/src/hook/types.ts  (32)
    built-in tools length of the `sid-code --dump-tools` array (44 — same source as the
                   generated ref/tools.md). Do NOT write "60+"; that was wrong and is
                   contradicted by the runtime registry.
    eval cases     the summary line of `bun run eval:list`  (P0=10 holdout=5 P1=9 P2=6 = 30)
  This table must stay identical in three places: README.md (this file, English),
  README.zh-CN.md, and website/index.md. Change one, change all three —
  run the numbers first.
  (Before 2026-08-12 the English copy lived in README.en.md; P2-6 made English the
   main README and moved the Chinese copy to README.zh-CN.md. Same three places,
   different filenames.)
-->

## Local development

Two binaries with **different names** coexist locally; they are not disambiguated by
`PATH` order:

| Command | Points to | Use for |
| --- | --- | --- |
| `sc` / `sid-code` | `~/.local/bin/sid-code` (released build) | comparing against released behavior |
| `sc-dev` / `sid-code-dev` | build output in the repo root | **verifying your local changes** |

```bash
git clone <repository-url>
cd sid-code
bun install
make build            # build the dev binary (does not bump the version — use this daily)
sc-dev                # run the dev build
bun test              # full unit test suite
```

> ⚠️ To verify a code change you must run `sc-dev`. `sc` points at the released build and
> will not reflect any local change. When in doubt, run
> `which sid-code-dev sid-code` first.

Documentation site (VitePress, fully static output):

```bash
bun run website:dev      # preview at http://localhost:5173
bun run website:build    # build (dead-link checking runs here)
```

Contribution workflow, the gates your PR must pass, and repo conventions are in
[CONTRIBUTING.md](./CONTRIBUTING.md); conventions for AI agents working in this repo are
in [CLAUDE.md](./CLAUDE.md) — the single source of truth (there is deliberately no
`AGENTS.md`; see the note at the top of `CLAUDE.md`).

## License

**[MIT](./LICENSE)** for our own code. Non-commercial: not sold, not operated for profit.

Third-party code in this repository is governed by its own terms, and MIT cannot grant
rights we do not hold. One item is worth stating plainly here: `packages/tui-renderer/`
(the terminal rendering layer) is **not original to this project** — it is a fork of the
MIT-licensed [`ink`](https://github.com/vadimdemedes/ink) that reached us through a
third-party snapshot carrying modifications we hold no rights to. It is being refactored
out, and the line-count figures above exclude it.

Provenance, license terms, and our modifications for every third-party component are
recorded in **[NOTICE](./NOTICE)** — read it alongside `LICENSE` before redistributing
or reusing this code. If you are a rights holder with a concern about anything in this
repository, open an issue and we will respond.
