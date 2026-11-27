---
name: spec
description: Writes numbered acceptance criteria and a file-level plan for a task or one slice of an epic, then asks for approval before any code is written.
argument-hint: "<task> [--go]"
disable-model-invocation: true
---

Write the spec for: $ARGUMENTS

0. **Settings and worktree.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it prints `NOT-SET-UP` or
   `INVALID`, stop and tell the user to run `/runway:setup`. Otherwise its JSON gives `verifyCommand`, `epicsDir`
   and `baseBranch`. (When epic-next started this spec, skip this whole step: it has done all of it.) Run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/prepare-worktree.mjs" <name> --base <baseBranch>`, with a short name for the
   task (`fix-login`). Act on the last line it prints:
   - `ENTER <name>`: call the `EnterWorktree` tool with that name (if the tool is not available, stop and tell the
     user to start a session in a new worktree), then run the script again: it must print `STAY`.
   - `STAY`: continue here.
   - `IN-USE <branch>`: this worktree already holds work on `<branch>`. Never leave it or create another one.
     If this request continues that work, continue here; otherwise ask the user whether to continue here
     or start a new session for the new task.
   - `STOP <reason>`: stop and tell the user the reason.
   Tell the user about any `REMOVED` lines (old worktrees whose PR is merged or closed).
   **Baseline:** in a fresh worktree (`STAY`), install dependencies if they are missing, then run the verify command
   once before changing anything, quietly, as `${CLAUDE_PLUGIN_ROOT}/skills/verify/SKILL.md` step 1 shows. If it
   fails, the base branch is already broken: tell the user what fails and stop.
   Don't fix it as part of this task unless they ask.
1. **Find the context.** For a slice of an epic, read the epic file in `<epicsDir>` first: its slice row,
   interfaces, data model and decisions bind the spec. Otherwise run the `runway:explorer` agent on the task. Read
   CLAUDE.md and the convention docs it links.
2. **Write numbered acceptance criteria.** Each one is observable and testable: an input or action, and the
   result. Include the denied cases (no session, another user's or tenant's data, invalid input). End each with
   its proof: `[test: <test file>]`, or `[manual: <how it is checked>]` only when no automated test is practical
   (Docker, infra, a third-party dashboard), for example `[manual: docker compose up, then curl /health returns 200]`.
3. **Write a file-level plan.** For each file to create or change: its path and what changes, including the test
   files the criteria name. Note migrations, new env vars and new dependencies explicitly.
4. **State the risk**: low, medium or high, with one line on why (the slice's row decides it for epic work).
5. **Save it** (runway keeps `.runway/` out of git): to `.runway/specs/epic/<slug>/slice-<N>.md` for a slice of an
   epic, otherwise to `.runway/specs/<branch>.md` (`git branch --show-current`). Include the task, the criteria with
   their tags, the file plan, the risk, and the decisions made with the user, each with why. Keep it in step with
   every revision.
6. **Approval, then implement.**
   - **Started by epic-next:** wait for approval only if the slice's risk is medium or high and the session is
     not unattended. Then read `${CLAUDE_PLUGIN_ROOT}/skills/implement/SKILL.md` and follow it: every test file
     is written by a `runway:test-writer` agent before any code.
   - **Otherwise:** ask the user to approve and wait (skip the wait only with `--go`, and say so). Recommend
     `/clear`, then `/runway:implement`: it reads the saved spec and starts from a small context. If they approve
     here instead, read `${CLAUDE_PLUGIN_ROOT}/skills/implement/SKILL.md` and follow it.
