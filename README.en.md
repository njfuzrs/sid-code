# sid-code

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/njfuzrs/sid-code/actions/workflows/ci.yml/badge.svg)](https://github.com/njfuzrs/sid-code/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-sid--code.cc-4c8bf5)](https://www.sid-code.cc/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#installation)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.0-000000?logo=bun&logoColor=white)](https://bun.sh)

[中文](./README.md) · **English**

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
is structurally positioned not to offer**:

| Capability | What it means |
| --- | --- |
| **Fits enterprise plumbing** | Internal gateway billing, MCP integrations, team-wide default config distribution — designed for enterprise networks. It plugs into what your company already runs, instead of asking the company to adapt to the tool |
| **Any model, and the whole harness is yours** | Change one config line to swap models (Anthropic / OpenAI / Ollama protocol families, with automatic fallback); write one file to extend it (hooks, skills, subagents, MCP); open one PR to change the core (44 built-in tools, context engineering, the main loop — all open source) |
| **Your data stays yours** | Session trajectories, eval results, and cost ledgers live in your own infrastructure, and never enter anyone's training set. That's a compliance prerequisite, and it's also the fuel for improving the agent |
| **Every cent and every decision is auditable** | Latency, cost, and decisions are all recorded in local trajectories, on by default; evals run before each release to catch regressions. It's also the only measurement source behind the directions we track release over release: faster, cheaper, less rework, safer |

Coming from Claude Code, migration is close to zero-cost — see the
[migration guide](https://www.sid-code.cc/team/migrate).

## Where it stands today

| Item | Status |
| --- | --- |
| First-party code | 508k lines of TypeScript (including 197k lines of tests) |
| Engineering loop | 12,875 unit tests, 84.7% line coverage on the agent engine; CI runs the full suite on every PR and it must be green to merge |
| Surface area | 44 built-in tools, MCP client / server, LSP code intelligence, permission gating, observable trajectories |
| Evaluation | Separate benchmark [agent-traj-bench](https://github.com/njfuzrs/agent-traj-bench): 39 SWE-bench-style tasks reverse-built from real sessions |

<!--
  How these numbers are counted (re-based 2026-09-30; same source as the homepage stat bar
  and the author's resume):
    The old values ("200k+ lines / 600+ test files / 8000+ tests / 32 hook events / 30 eval
    cases") came from static scans and didn't match the resume; the 30 eval cases were deleted
    on 2026-09-18 along with the old evals/ suites, so keeping them here would be untrue.
    The first two rows now come from one run of scripts/resume-metrics.ts (`--coverage`)
    in the docs-research repo:
    lines of code  507,914 (production + renderer fork + tests + tooling, minus _vendor/ third-party);
                   tests 197,130
    unit tests     12,875 as executed by `bun test` (includes generated cases a static grep misses)
    coverage       84.7% line coverage of packages/core/src (74,209 / 87,603); engine layer only
    built-in tools length of the `sid-code --dump-tools` array (44, same source as ref/tools.md)
    Hook event count is no longer in this table: some of the 32 HookEventName members are
    reserved and not wired yet, so "32" here would read as 32 usable events. See website/ref/hooks.md.
  Keep in sync with website/.vitepress/theme/HomeShowcase.vue and README.md (Chinese).
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
bun run vendor:fetch  # fetch build-time vendor sources (see the note below)
make build            # build the dev binary (does not bump the version — use this daily)
sc-dev                # run the dev build
bun test              # full unit test suite
```

> ⚠️ `bun run vendor:fetch` is required on a fresh clone. Two directories
> (`packages/tui-renderer/src/` and `packages/cli/src/command/commands/claude-api/reference/`)
> are not tracked in git but *are* build-time dependencies, so a clone without them fails to
> compile (`Cannot find module '@sid-code/tui-renderer/...'`). `make build` runs the fetch on
> its own; a bare `bun test` does not — run it once after cloning. Same mechanism as the
> vendored `ripgrep`: local copy wins, otherwise download + sha256 verify.
>
> Both paths are **symlinks into `.vendor-src/`**, where the real bytes live. That path exists
> in no git ref, so no `checkout` / `merge` / `reset` can delete the files — a `git checkout -f`
> may replace the symlink, but `bun run vendor:fetch` restores it offline. Details and the three
> constraints you must not break: [CONTRIBUTING.md](./CONTRIBUTING.md#新克隆必须先-bun-run-vendorfetch).

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

Third-party assets that ship with this repository (the vendored `ripgrep` binaries and
the npm runtime dependencies) are governed by their own licenses, recorded in
**[NOTICE](./NOTICE)**.
