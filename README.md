# runway 🛫

An agentic engineering workflow for Claude Code, built on one idea: **strong, deterministic verification makes
better output.** Formatters, linters, type checks, tests and a real browser check Claude's work at every step, so
"done" is proven, not claimed.

Use as much of it as you need: from a normal, free-flowing session to a big feature built unattended. runway never
merges: you review and merge every PR.

## 📦 Install

```
/plugin marketplace add hinoahlee/runway
```

```
/plugin install runway@runway
```

Then, in each repository you want it in:

```
/runway:setup
```

Setup checks what runway needs and fixes the gaps with your approval.

## 🧭 How to use it

| | You do | What happens |
|---|---|---|
| 💬 **Any session** | Work as usual.<br>Done? `/runway:ship`. | Every edit is formatted and linted. Dangerous commands are blocked. Claude keeps fixing until your checks pass. Ship reviews the branch, fixes what it finds and opens the PR. |
| 🔧 **Small feature or fix** | 1. `/runway:spec <what you want>`<br>2. `/runway:implement`<br>3. `/runway:ship`, then merge | A checklist of what "done" means, failing tests first, then the code, checked in a browser, reviewed, one PR. |
| 🧱 **Big feature, slice by slice** | 1. `/runway:epic-plan <brief>`<br>2. `/runway:epic-next` per slice<br>3. `/runway:ship`, then merge | A plan of small slices on one branch, each built like a small feature. You steer between slices; one PR. |
| 🤖 **Big feature, unattended** | 1. `/runway:epic-plan <brief>`<br>2. `/runway:epic-auto`<br>3. If it stops: fix it, say "proceed"<br>4. Review and merge | The same, with nobody watching: a fresh session per slice, CI fixed automatically, the PR marked ready for you. |

🗺️ **See it step by step:** [docs/flow.html](docs/flow.html) shows what runs at each step;
[docs/inventory.html](docs/inventory.html) lists every command, agent, hook and script. Open them in a browser.

## ⚙️ Settings

In `.claude/runway.json` (shared) or `runway.json` in the git folder (this clone only).

```json
{ "verifyCommand": "pnpm verify", "epicsDir": "docs/epics", "baseBranch": "main" }
```

| Key | Default | What it does |
|---|---|---|
| `verifyCommand` | (required) | Lint, typecheck and unit tests. Runs whenever Claude tries to stop. |
| `epicsDir` | `docs/epics` | Where epic plans live. |
| `baseBranch` | `main` | The branch PRs target. |
| `testPaths` | `*.test.*`, `*.spec.*`, test and e2e folders | Test files: committed on their own, before the code. |
| `securityPaths` | routes, auth, db, config, infra, CI, dependencies | Paths that always get a security review. |
| `model` | `sonnet` | The model unattended runs use. |
| `reviewModel` | `opus` | The model of the code and security reviewers (each slice and ship). |
| `claudeSettings` | none | Extra Claude Code settings for unattended runs (a sandbox, say). |

Environment variables for unattended runs:

| Variable | What it does |
|---|---|
| `RUNWAY_ALLOWED_TOOLS` | Extra tools unattended sessions may use (comma-separated). |
| `RUNWAY_CLAUDE_BIN` | Where Claude Code is, if the runner can't find it. |
| `RUNWAY_PERMISSION_MODE` | The headless sessions' permission mode. Default `acceptEdits`. |
| `RUNWAY_SESSION_HOURS` | Hours before a session counts as hung. Default 4. |

---

MIT licensed: see [LICENSE](LICENSE).
