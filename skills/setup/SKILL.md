---
name: setup
description: Sets runway up in this repository. Checks the prerequisites, then, with the user's approval at each step, writes runway.json and fills the gaps runway relies on (a Checks section in CLAUDE.md, REVIEW.md, .worktreeinclude, the epics folder).
disable-model-invocation: true
---

Set runway up in this repository. Change nothing without the user's approval for that step.

1. **Check.** Run `git fetch`, then `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"`. Show the user its lines as a
   short table (check, result, fix). FAIL lines on node, git, gh or github block runway: say what to do, and stop
   if the user cannot fix them now.
   Then tell the user, in plain words and only where it applies to this repository, what runway can't do here:
   - **GitHub only.** PRs, CI, worktree cleanup and epic-auto go through `gh`; GitLab, Bitbucket and Azure DevOps
     aren't supported.
   - **Formatting on each edit** (the `format` line): only Biome, or Prettier and ESLint, installed and configured
     at the repository root. Other languages and tools are checked by the verify command only.
   - **Browser checks** need a web app whose dev server the CLAUDE.md Checks section explains how to start. In a
     library or CLI, verify skips the browser.
   - **A private repository on a free GitHub plan** (`gh repo view --json isPrivate,owner`, when gh is signed in):
     branch rulesets aren't available, so nothing on GitHub stops a force push or a direct push to the base branch
     (runway's guard still stops Claude's own), and draft PRs aren't either, so an epic's PR is titled `WIP:` until
     it's ready.
   - **Unattended runs on native Windows** can't use Claude Code's sandbox (it needs macOS, Linux or WSL2); a dev
     container is the alternative.
   - **The browser server** (Playwright) starts in every session where runway is enabled, so enable runway for the
     projects that use it, not for every repository.
2. **Settings.** If the `config` check passed, show the settings and ask whether to change them; otherwise propose
   them:
   - `verifyCommand`: read `package.json` (its `scripts` and `packageManager`) and the lockfile. Prefer an existing
     script that runs lint, typecheck and unit tests (`verify`, `check`, `validate`); otherwise chain the existing
     lint, typecheck and unit-test scripts with `&&`, using the repository's package manager. Never include e2e or
     anything that needs the network. If the repository has no such scripts, ask the user for the command.
   - `epicsDir` (default `docs/epics`) and `baseBranch` (the GitHub default branch, from
     `gh repo view --json defaultBranchRef`).
   Ask where they go:
   - **The repository** (`.claude/runway.json`, committed): everyone who uses runway here shares them.
   - **This clone only** (`runway.json` in the folder `git rev-parse --path-format=absolute --git-common-dir`
     prints): nothing in the repository mentions runway.
   Write the file, starting with `"$schema": "${CLAUDE_PLUGIN_ROOT}/schemas/runway.schema.json"` only for the clone
   file (the path is local). Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"` to confirm it loads.
3. **Prove the verify command.** Run it, and note how long it takes. If it fails, show the end of its output and
   ask whether it is the right command; runway's Stop hook would send every session back to work (up to three times
   per stop) until it passes. If it takes more than a minute or two, say so: it runs whenever Claude stops with
   changes, so a slow command makes every stop slow.
4. **Fill the gaps**, one approval each, for every WARN from step 1 the user wants fixed:
   - **CLAUDE.md "Checks" section:** the verify command, plus how to run the e2e tests, one e2e file, the dev
     server and the database, found in `package.json`, the README and CI workflows. Ask for what you cannot find.
   - **REVIEW.md:** start from `${CLAUDE_PLUGIN_ROOT}/templates/review.md`, adapted to what this repository's docs
     and code already require.
   - **.worktreeinclude:** the ignored files a fresh worktree needs to run tests and the dev server (look for
     `.env` files with `git status --ignored --short`; list paths only, never read or print their contents).
   - **Epics folder:** create `<epicsDir>/README.md` with one line saying runway's epic plans live here.
   - **Branch protection:** if the base branch does not block force pushes, deletion and pushes without a PR,
     explain the ruleset fix from the doctor's line. Never change GitHub settings yourself.
5. **Fewer prompts (optional).** Offer to add to
   `.claude/settings.json` (shared) or `.claude/settings.local.json` (this clone) `permissions.allow` rules for what
   runway runs on every task: the verify command and its parts, the test runner for one file, read-only `git`
   (`git status`, `git diff`, `git log`, `git show`, `git branch`, `git rev-parse`, `git fetch`), `gh pr view`, and
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/*"`. Never allow push, force, reset, rm or anything that writes outside the
   repository. Show the exact rules before writing.
6. **Sharing (optional).** Only if the user wants teammates to get runway with the repository: add to
   `.claude/settings.json` an `extraKnownMarketplaces` entry `"runway": { "source": { "source": "github", "repo":
   "hinoahlee/runway" } }` and `"enabledPlugins": { "runway@runway": true }`. Tell them each teammate still runs
   `claude plugin install runway@runway --scope project`: committing the setting does not install it.
7. **Commit?** List the files written. Commit only if the user asks (`chore: set up runway`), on a branch if the
   repository's rules require one.

Report what is set up and what still needs the user (a FAIL or WARN left, a ruleset to add).
