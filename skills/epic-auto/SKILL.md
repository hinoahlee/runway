---
name: epic-auto
description: Builds every remaining slice of a planned epic with no one watching, on the epic's branch, fixing CI as it goes, then ships the epic's PR ready for review. Never merges. Stops only for what a developer must handle; "proceed" continues.
argument-hint: "[slug] [status|stop]"
disable-model-invocation: true
---

Arguments: $ARGUMENTS (an optional epic slug, and optionally `status` or `stop`).

First run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it prints `NOT-SET-UP` or `INVALID`, stop and tell
the user to run `/runway:setup`. Its JSON gives `baseBranch` and `epicsDir`.

If no slug was given: for `status` or `stop`, look for runs in `$(git rev-parse --git-common-dir)/runway/`
(`epic-auto-<slug>.json`): one, use it; several, ask which; none, say no run exists. To start, find the epic the way
`${CLAUDE_PLUGIN_ROOT}/skills/epic-next/SKILL.md` step 1 does.

The runner is a script; it runs in the background, outside this session, and spends no tokens itself:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/epic-auto.mjs" <start|status|stop> <slug>
```

- **`status`**: run `status` and report the state, the PR, any stop reason, the run's cost so far (`costUsd`, at API
  rates), any `strays` (files a session wrote in the main checkout: list them for the user to check and remove;
  never delete them yourself), and the log's last lines. For a stopped run, the next step is always to fix what it
  names and say "proceed" here: never run `/runway:ship` or another runway skill in this session to finish the
  epic, since the runner ships it in a fresh session.
- **`stop`**: run `stop` and confirm.
- **Otherwise, start or continue:**
  1. **Preflight.** `gh auth status` must pass; if not, tell the user to run `gh auth login` and then
     `gh auth setup-git`, and stop. `git fetch`, then `git rev-parse --verify --quiet origin/epic/<slug>` must pass;
     if not, the epic is not planned yet: say to run `/runway:epic-plan`, and stop. Run `status`: if it is running,
     report it and stop. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --only protection` and keep its line
     for the warning.
  2. **A stopped run.** If the status is `stopped`, show its reason and ask whether the blocker is resolved. On a
     clear yes ("proceed"), go to step 4.
  3. **A new run: warn and wait.** Count the slices left in the epic file on `origin/epic/<slug>`. Then show this
     warning, filled in, and ask the user to reply "yes, run it":

     > **epic-auto will build the <N> remaining slices of `<slug>` on `epic/<slug>` with no one watching.** Headless
     > Claude sessions approve each slice's spec themselves, edit files, and run git, package-manager, Node, curl,
     > `gh pr` and browser commands without asking you. They commit and push to `epic/<slug>` only; CI runs on the
     > epic's PR and failures are fixed automatically (up to 3 tries). When every slice is done, a last session
     > reviews the whole epic and marks the PR ready for review. **Nothing is merged: you review and merge the PR.**
     > It stops early when something needs you (a secret or dashboard setting, a risky choice the plan leaves open,
     > CI it cannot fix).
     >
     > Its guard against destructive commands is a pattern check, not a security boundary: the sessions can run
     > arbitrary code on this computer with your permissions. What protects `<base>` is GitHub's branch rules.
     > <The doctor's protection line: "PASS: <base> blocks force pushes, deletion and pushes without a PR", or
     > "WARN: <base> does not block …" followed by how to add a ruleset.> For more isolation, run it in a dev
     > container, or turn on Claude Code's sandbox with
     > `"claudeSettings": { "sandbox": { "enabled": true, "failIfUnavailable": true } }` in
     > runway.json (macOS, Linux or WSL2 only; its network allows no domains at first, so allow GitHub and your
     > package registry, or pushes and installs fail).
     >
     > It runs for hours on your Claude plan; when the usage limit is hit it waits for the reset and carries on.
     > Keep this computer on and awake, and the database (Docker) running.

     Start nothing unless the reply is a clear yes.
  4. **Start.** Run `start`. Report the pid and the log path, and how to follow it: `/runway:epic-auto status`,
     `/runway:epic-auto stop`, or in a terminal `Get-Content -Wait <log>` (PowerShell) / `tail -f <log>` (free). Say this session can be closed: the run doesn't need it.

If the user later says "proceed" in this session, continue from step 1.
